# Plugin Design

## Goal

Move shell execution off the OpenCode host without changing OpenCode Core and without synchronizing files. The plugin is the only OpenCode-side integration point; everything behind `POST /execute` is owned by the [opencode-execd](https://github.com/jerolei999/opencode-execd) service.

## Why a tool override

OpenCode registers plugin tools after built-in tools, so a plugin tool named `bash` replaces the built-in implementation. That is the same mechanism the Daytona OpenCode plugin uses. Overriding a tool name is a public extension surface, so OpenCode Core needs no patch and no fork.

Only `bash` is overridden on purpose:

- `read`, `write`, `edit`, `grep`, `glob`, patching, and LSP keep running locally, so there is no protocol to keep in sync and no risk of a file operation bypassing the remote environment;
- the workspace is expected to be a shared mount (CubeFS), so local reads already observe remote writes;
- tool arguments and results stay byte-identical to the built-in contract, so agent prompts and permissions behave as before.

## Tool contract

`src/plugin.ts` registers exactly the built-in argument shape:

```ts
bash: tool({
  args: {
    command: string,
    timeout?: number,   // milliseconds
    workdir?: string,   // relative to the project directory
  },
  async execute(args, context) { ... },
})
```

`workdir` is resolved against `context.directory` (falling back to the plugin input directory) and `root` is resolved from `context.worktree` so the worker can validate containment. The result keeps the built-in `title`/`output`/`metadata` shape and adds `exit`, `truncated`, and `sandboxID` to metadata.

The tool description tells the model to use `workdir` instead of `cd` inside the command, because every invocation is a fresh shell process and `cd` state is not preserved.

## Permission and cancellation

Before dispatch the plugin calls `context.ask({ permission: "bash", patterns: [command], always: [command], metadata: { command } })`. This keeps OpenCode's existing `allow`/`ask`/`deny` policy and its "always allow" memory authoritative; the plugin never decides on its own.

The tool's `AbortSignal` is passed to `fetch`, so aborting a tool call aborts the request. The worker translates that into a `DELETE /command?id=...` against `execd`, which terminates the remote process group.

## Routing and affinity

Sessions are pinned to the worker that first served them:

- `routes: Map<sessionID, endpoint>` holds the pin;
- a new session picks an endpoint by rotating `options.endpoints` with a stable hash of the session ID, so replicas spread sessions deterministically without a central registry;
- a pinned session retries the remaining endpoints when its worker fails or answers `503`.

`503` is the only status treated as retryable, because the service uses it for capacity exhaustion and same-session concurrency. Any other failure surfaces to the tool call, which avoids silently running a command on a node where the workspace has diverged.

The pin is released by `release()` on `session.deleted`, which best-effort calls `POST /release` on the owning worker so the per-session home/temp directories are removed. `dispose()` clears all pins when the plugin unloads.

## Environment

Only `options.env` is forwarded. The plugin deliberately does not forward the OpenCode process environment, and the worker additionally strips its own credential variables, so a command cannot read worker or execd secrets. The worker sets `HOME`, `TMPDIR`, `TMP`, `TEMP`, and `OPENCODE_SESSION_ID` itself.

## Failure modes

| Situation | Behavior |
| --- | --- |
| No endpoint configured | Plugin throws at load time |
| `503` from a worker | Try the next configured endpoint |
| Network error | Try the next configured endpoint |
| `401`/`400`/`5xx` other than `503` | Fail the tool call with the worker message |
| User aborts the tool call | Abort the HTTP request; worker cancels the remote command |
| Session deleted | Best-effort `/release`; failures are ignored |

## Non-goals

- No file transfer or workspace synchronization.
- No local fallback: when the remote service is unavailable the tool call fails rather than executing on the OpenCode host.
- No sandbox lifecycle management. Container creation stays with the company CI/CD and platform.
- No per-command CPU detection; the routing decision is always "bash goes remote".
