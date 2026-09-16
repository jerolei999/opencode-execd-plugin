# OpenCode Execd Plugin

Transparent remote shell execution for OpenCode. The plugin overrides only the built-in `bash` tool and forwards every command to an [opencode-execd](https://github.com/jerolei999/opencode-execd) worker service, which runs it through OpenSandbox `execd` inside a normal SaaS container.

It is intended for fixed SaaS environments where you can deploy a private service image but cannot grant a Docker socket, privileged mode, writable cgroups, or Kubernetes API access, and where the workspace is already shared (for example through CubeFS). No file synchronization is needed: `read`, `write`, `edit`, `grep`, `glob`, patching, and LSP stay inside OpenCode and see the same files directly.

## Boundary

```text
OpenCodeBridge (existing auth/control plane)
        |
        v
OpenCode server + this plugin ---- POST /execute ----> opencode-execd service
                                                        (admission, path policy,
                                                         concurrency, execd)
```

The Bridge is unchanged and command bytes never pass through it. The plugin calls the execution service directly. OpenCode Core is not modified.

## Install

```json
{
  "plugin": [
    [
      "opencode-execd-plugin",
      {
        "endpoint": "http://opencode-execd.internal:9010",
        "token": "{env:OPENCODE_EXECD_WORKER_TOKEN}",
        "shell": "/bin/bash",
        "defaultTimeoutMs": 120000,
        "maxOutputBytes": 1048576
      }
    ]
  ]
}
```

The package is consumed as TypeScript source, so install it with the same runtime OpenCode uses (Bun) from a registry or from this repository:

```bash
bun add opencode-execd-plugin
```

Alternatively bake this repository into the OpenCode image and reference the plugin path directly.

## Configuration

Plugin options:

| Option | Default | Meaning |
| --- | --- | --- |
| `endpoint` | unset | Single worker or load-balanced service URL |
| `endpoints` | unset | Explicit worker list for client-side failover |
| `token` | unset | Bearer token sent to the worker service |
| `shell` | `/bin/bash` | Shell the worker uses for `shell -lc` |
| `defaultTimeoutMs` | `120000` | Timeout used when the tool call omits `timeout` |
| `maxOutputBytes` | `1048576` | Client-side ceiling for captured output |
| `env` | `{}` | Extra environment variables forwarded to commands |

Environment fallbacks, useful when options must stay out of configuration files:

| Variable | Meaning |
| --- | --- |
| `OPENCODE_EXECD_WORKER_URLS` | Comma-separated worker URLs |
| `OPENCODE_EXECD_WORKER_TOKEN` | Bearer token |

`endpoint`/`endpoints` (or `OPENCODE_EXECD_WORKER_URLS`) is required; otherwise the plugin fails fast at load time instead of silently running commands locally.

## Behavior

- Registers a custom tool named `bash`, which replaces the built-in tool without patching OpenCode Core.
- Keeps the native `command`, `timeout`, and `workdir` arguments and returns the same `title`/`output`/`metadata` shape.
- Calls OpenCode's `bash` permission check (`context.ask`) before dispatching, so `allow`/`ask`/`deny` rules keep working.
- Sends the tool call's `AbortSignal`, so a user abort cancels the remote command.
- Calls `POST /release` on the owning worker when OpenCode emits `session.deleted`, cleaning up the session's private home and temp directories.
- Reports `exit`, `truncated`, and `sandboxID` in tool metadata.

Only the environment variables passed through plugin option `env` are forwarded. The worker strips its own credentials before execution.

## Routing and failures

Each session is pinned to the endpoint that first served it, and `session.deleted` releases that endpoint. A new session is assigned by rotating the configured endpoint list with a hash of its session ID, which spreads sessions over replicas without a central registry.

Dispatch falls back to the remaining endpoints when the pinned one fails or answers `503` (capacity exhausted or session already executing). Authentication errors, `400` validation errors, and other non-`503` responses surface immediately to the tool call instead of silently running the command on a different node.

## Multiple replicas behind one URL

The worker keeps per-session state on the node that ran the command: the session `HOME`/temp
directories, the in-flight command registry, and the `execd` command id used for cancellation. A
plain round-robin load balancer therefore breaks three behaviours at once. Measured with two
replicas behind nginx:

| Symptom | Round robin (`gateway.test.ts`) | Sticky (`gateway-sticky.test.ts`) |
| --- | --- | --- |
| Session `HOME` state | `MISSING, MISSING, MISSING, MISSING` - written on one replica, read on the other | `state, state, state` |
| Two concurrent commands for one session | both accepted, on two different replicas | second rejected with `503 ... already executing` |
| `POST /release` | reached the other replica, session directory leaked | removed on every replica |

The plugin sends `x-opencode-session: <sessionID>` on `/execute` and `/release`, so a load balancer
can pin a session without parsing the JSON body:

```nginx
map $http_x_opencode_session $sticky_key {
  ""      $request_id;                  # header-less callers are not funnelled to one replica
  default $http_x_opencode_session;
}

upstream execd_workers {
  hash $sticky_key consistent;          # one session -> one replica
  server worker-1.internal:9010;
  server worker-2.internal:9010;
}
```

Stickiness still spreads different sessions across replicas, so capacity adds up across them.

Mounting CubeFS at `OPENCODE_SESSION_ROOT` removes part of the problem, because every replica then
sees the same session home, but it does not remove all of it:

| Symptom | Round robin | Round robin + shared session root | Sticky |
| --- | --- | --- | --- |
| Session `HOME` state | `MISSING` on the next call | `state, state, state, state` | stable |
| `POST /release` | leaked on one replica | cleaned on both | cleaned |
| Same-session concurrency | both accepted | **both accepted** | second rejected with `503` |
| Cancellation | can miss the running command | **can still miss it** | reaches the owning replica |

The two remaining rows are worker-memory state (`running`/`reserved` maps and the `execd` command
id), so they need affinity or an external lock regardless of where `HOME` lives. Run the control
suite with `OPENCODE_EXECD_TEST_SHARED_HOME=1` to assert the shared-root behaviour instead of the
node-local one.
Adding or removing a replica remaps some sessions, and the session `HOME` starts empty on the new
node: keep `HOME` on shared storage (`OPENCODE_SESSION_ROOT` on CubeFS) when commands depend on
state across calls. If a sticky gateway is not an option, pass the replica list through plugin option
`endpoints` (or `OPENCODE_EXECD_WORKER_URLS`) instead: the plugin then hashes the session id itself
and pins it client-side.

## Limitations

This plugin removes local CPU/IO work from the OpenCode host; it is not a security boundary of its own. The worker is a multi-tenant execution pool that shares a kernel, process namespace, network namespace, and Unix identity across sessions. Filesystem tools still run with the OpenCode process's own privileges, and CubeFS ACLs remain the authoritative filesystem boundary.

Because file tools stay local, a command that writes through the worker and a `read` that runs locally both observe the same mount. If the workspace is not shared, this plugin is the wrong tool.

## Development

```bash
bun install
bun test
bun run typecheck
```

The tests run a real HTTP server and assert the worker request contract, permission prompting, cancellation plumbing, and release-on-delete behavior.

## Integration testing

`bun test` is offline: it covers the plugin contract, permission call, cancellation plumbing, and release behaviour against a fake worker. Two opt-in suites drive a **real** worker instead, and are skipped unless their environment variables are set.

| Suite | Covers | Requires |
| --- | --- | --- |
| `test/integration/scenarios.test.ts` | 27 deterministic scenarios through the plugin's `bash` tool: default/relative/absolute `workdir`, path rejection, exit codes, multi-line, unicode, long lines, truncation, 20k lines, binary output, heredoc/pipes/background, shared-mount writes, env and secret isolation, per-session `HOME`, `/release` cleanup, same-session and capacity admission, 401, unreachable worker, and CPU-bound commands including cancellation and timeout | a worker and a workspace mount |
| `test/integration/opencode.test.ts` | 8 scenarios through a real `opencode run` session with the model in the loop: cwd, workspace reads, explicit `workdir`, multi-line output, failing-command output, single-thread CPU compute with exact result, parallel CPU saturation, and a CPU command interrupted by its tool timeout. It samples `docker stats` so the CPU assertions prove the work happens inside the worker container | a worker, a workspace mount, and model credentials |

Start a worker whose workspace is mounted at the same absolute path on both sides, then run:

```bash
# deterministic scenarios (no model needed)
OPENCODE_EXECD_TEST_ENDPOINT=http://127.0.0.1:19020 \
OPENCODE_EXECD_TEST_TOKEN=worker-secret \
OPENCODE_EXECD_TEST_WORKSPACE=/private/tmp/execd-it \
  bun run test:integration

# full session scenarios through opencode itself
OPENCODE_EXECD_TEST_ENDPOINT=http://127.0.0.1:19020 \
OPENCODE_EXECD_TEST_TOKEN=worker-secret \
OPENCODE_EXECD_TEST_WORKSPACE=/private/tmp/execd-it \
OPENCODE_EXECD_TEST_MODEL=anthropic/claude-haiku-4-5 \
OPENCODE_EXECD_TEST_CONTAINER=opencode-execd-it \
  bun run test:opencode
```

`OPENCODE_EXECD_TEST_CONTAINER` is optional and enables the container CPU assertions; `OPENCODE_EXECD_TEST_RUNTIME=python3` switches the CPU scenarios to Python when the worker image ships it instead of Bun. `OPENCODE_BIN` overrides the `opencode` executable.

On macOS mount the resolved path (`/private/tmp/...`, not `/tmp/...`) because the worker compares literal paths, and let the suite pass `--dir` to opencode: opencode resolves its project directory from `PWD`, so spawning it with only a different working directory can silently attach the parent project and run commands with the built-in tool instead of this plugin.

## Related

- [opencode-execd](https://github.com/jerolei999/opencode-execd) - the worker service image that this plugin talks to.
- [docs/design.md](docs/design.md) - plugin design notes.

## License

MIT.
