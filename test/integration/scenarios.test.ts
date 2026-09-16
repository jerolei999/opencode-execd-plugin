import { beforeAll, describe, expect, test } from "bun:test"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { OpenCodeExecdPlugin } from "../../src/plugin.ts"

/**
 * End-to-end scenario suite for the OpenCode bash override.
 *
 * It drives the exact code path OpenCode uses (the plugin's `bash` tool) against a
 * real opencode-execd worker, so a run needs a reachable worker whose workspace is
 * mounted at the same absolute path on both sides:
 *
 *   OPENCODE_EXECD_TEST_ENDPOINT=http://127.0.0.1:19020 \
 *   OPENCODE_EXECD_TEST_TOKEN=it-plugin-secret \
 *   OPENCODE_EXECD_TEST_WORKSPACE=/private/tmp/execd-it \
 *   bun test test/integration
 *
 * Without those variables the suite is skipped, so `bun test` stays offline.
 */
const endpoint = process.env.OPENCODE_EXECD_TEST_ENDPOINT
const token = process.env.OPENCODE_EXECD_TEST_TOKEN
const workspace = process.env.OPENCODE_EXECD_TEST_WORKSPACE
const enabled = Boolean(endpoint && workspace)

type Outcome =
  | { readonly kind: "result"; readonly output: string; readonly exit: number; readonly truncated: boolean; readonly sandboxID: string }
  | { readonly kind: "error"; readonly message: string }

type Session = Awaited<ReturnType<typeof open>>

async function open(input: {
  session: string
  directory?: string
  root?: string
  token?: string
  env?: Record<string, string>
  signal?: AbortSignal
  endpoint?: string
}) {
  const root = input.root ?? workspace!
  const directory = input.directory ?? root
  const hooks = await OpenCodeExecdPlugin(
    { directory, worktree: root } as never,
    { endpoint: input.endpoint ?? endpoint!, token: input.token ?? token, shell: "/bin/bash", env: input.env },
  )
  const tool = hooks.tool!.bash as {
    execute: (args: unknown, ctx: unknown) => Promise<{ output: string; metadata: Record<string, unknown> }>
  }
  const context = {
    sessionID: input.session,
    messageID: "message-1",
    agent: "build",
    directory,
    worktree: root,
    abort: input.signal ?? new AbortController().signal,
    metadata() {},
    async ask() {},
  } as never

  return {
    run: async (call: { command: string; workdir?: string; timeout?: number }): Promise<Outcome> => {
      try {
        const result = await tool.execute(call, context)
        return {
          kind: "result",
          output: result.output,
          exit: Number(result.metadata.exit),
          truncated: Boolean(result.metadata.truncated),
          sandboxID: String(result.metadata.sandboxID),
        }
      } catch (error) {
        return { kind: "error", message: error instanceof Error ? error.message : String(error) }
      }
    },
    release: async (session = input.session) => {
      await hooks.event?.({
        event: { type: "session.deleted", properties: { info: { id: session } } } as never,
      })
    },
  }
}

function expectResult(outcome: Outcome) {
  if (outcome.kind !== "result") throw new Error(`expected a result, received error: ${outcome.message}`)
  return outcome
}

function sessionDir(session: string) {
  return `/tmp/opencode-sessions/${createHash("sha256").update(session).digest("hex").slice(0, 32)}`
}

const project = workspace ? path.join(workspace, "project") : "/"
const suite = enabled ? describe : describe.skip

/**
 * The worker image decides which compute runtime exists: the reference image ships
 * python3, while a minimal image may only carry the Bun runtime it was built with.
 */
type Runtime = "python3" | "node" | "bun"
const runtime: Runtime = enabled ? await detectRuntime() : "bun"
const burnFile = runtime === "python3" ? "burn.py" : `burn.${runtime === "node" ? "js" : "ts"}`
const burnCommand = runtime === "python3" ? `python3 ${burnFile}` : `${runtime} ${burnFile}`

async function detectRuntime(): Promise<Runtime> {
  const probe = await open({ session: "it-runtime-probe" })
  const outcome = await probe.run({ command: "command -v python3 || command -v node || command -v bun" })
  const found = outcome.kind === "result" ? outcome.output.trim().split("\n")[0] : ""
  if (found.includes("python3")) return "python3"
  if (found.endsWith("/node")) return "node"
  return "bun"
}

function compute(count: number) {
  if (runtime === "python3") return `python3 -c "print(sum(i * i for i in range(${count})))"`
  const loop = `let s=0n;for(let i=0n;i<${count}n;i++)s+=i*i;console.log(String(s))`
  return `${runtime} -e "${loop}"`
}

function progress(steps: number, inner: number) {
  if (runtime === "python3") {
    return `python3 -c "for i in range(${steps}):\n    print('step', i, flush=True)\n    sum(j * j for j in range(${inner}))"`
  }
  const loop = `let t=0n;for(let i=0;i<${steps};i++){console.log('step',i);for(let j=0n;j<${inner}n;j++)t+=j*j}`
  return `${runtime} -e "${loop}"`
}

suite("integration: workspace and cwd", () => {
  test("default cwd is the project directory", async () => {
    const session = await open({ session: "it-cwd-default", directory: project, root: project })
    const result = expectResult(await session.run({ command: "pwd && cat sub/file.txt" }))
    expect(result.output).toBe(`${project}\nhello-from-it\n`)
    expect(result.exit).toBe(0)
  }, 60_000)

  test("relative workdir resolves against the project directory", async () => {
    const session = await open({ session: "it-cwd-relative", directory: project, root: project })
    const result = expectResult(await session.run({ command: "pwd && ls", workdir: "sub" }))
    expect(result.output).toBe(`${project}/sub\nfile.txt\n`)
  }, 60_000)

  test("absolute workdir inside the workspace root is accepted", async () => {
    const session = await open({ session: "it-cwd-absolute", directory: project, root: project })
    const result = expectResult(await session.run({ command: "pwd", workdir: path.join(project, "sub") }))
    expect(result.output).toBe(`${project}/sub\n`)
  }, 60_000)

  test("cd does not persist between calls", async () => {
    const session = await open({ session: "it-cwd-persistence", directory: project, root: project })
    expectResult(await session.run({ command: "cd sub && pwd" }))
    const next = expectResult(await session.run({ command: "pwd" }))
    expect(next.output).toBe(`${project}\n`)
  }, 60_000)

  test("a workdir outside the workspace root is rejected before execution", async () => {
    const session = await open({ session: "it-cwd-outside", directory: project, root: project })
    const outcome = await session.run({ command: "pwd", workdir: path.dirname(project) })
    expect(outcome.kind).toBe("error")
    if (outcome.kind === "error") expect(outcome.message).toContain("outside")
  }, 60_000)

  test("a project outside the worker root is rejected", async () => {
    const session = await open({ session: "it-root-outside", directory: "/etc", root: "/etc" })
    const outcome = await session.run({ command: "pwd" })
    expect(outcome.kind).toBe("error")
    if (outcome.kind === "error") expect(outcome.message).toContain("outside worker root")
  }, 60_000)
})

suite("integration: command results", () => {
  test("captures stdout, stderr, and exit codes without turning failures into errors", async () => {
    const session = await open({ session: "it-results" })
    // execd tails stdout and stderr with separate readers, so the merged stream keeps
    // both but does not promise their relative order.
    const ok = expectResult(await session.run({ command: "printf out; printf err >&2" }))
    expect(ok.output).toContain("out")
    expect(ok.output).toContain("err")
    expect(ok.exit).toBe(0)
    expect(ok.sandboxID).not.toBe("")

    for (const [code, command] of [
      [1, "exit 1"],
      [7, "printf boom >&2; exit 7"],
      [127, "definitely-not-a-real-binary"],
    ] as const) {
      const failed = expectResult(await session.run({ command }))
      expect(failed.exit).toBe(code)
    }
  }, 120_000)

  test("preserves multi-line and unicode output", async () => {
    const session = await open({ session: "it-output-shape" })
    const multiline = expectResult(await session.run({ command: "printf 'a\\nb\\nc\\n'" }))
    expect(multiline.output).toBe("a\nb\nc\n")

    const unicode = expectResult(await session.run({ command: "printf '中文 ✓ 日本語\\n'" }))
    expect(unicode.output).toBe("中文 ✓ 日本語\n")

    const empty = expectResult(await session.run({ command: "true" }))
    expect(empty.output).toBe("(no output)")
    expect(empty.exit).toBe(0)
  }, 120_000)

  test("keeps a very long single line and re-terminates it", async () => {
    const session = await open({ session: "it-output-long-line" })
    const result = expectResult(await session.run({ command: "head -c 200000 /dev/zero | tr '\\0' 'a'" }))
    // execd streams newline-stripped lines, so the plugin restores the terminator even on
    // the final unterminated line: 200000 characters plus the reconstructed newline.
    expect(result.output).toBe("a".repeat(200_000) + "\n")
    expect(result.truncated).toBe(false)
  }, 120_000)

  test("flags truncated output instead of buffering everything", async () => {
    const session = await open({ session: "it-output-truncated" })
    const result = expectResult(await session.run({ command: "head -c 3145728 /dev/zero | tr '\\0' 'a'" }))
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBe(1_048_576)
    expect(result.exit).toBe(0)
  }, 120_000)

  test("handles many output lines", async () => {
    const session = await open({ session: "it-output-many-lines" })
    const started = Date.now()
    const result = expectResult(await session.run({ command: "seq 1 20000" }))
    expect(result.output.split("\n").filter(Boolean)).toHaveLength(20_000)
    expect(Date.now() - started).toBeLessThan(60_000)
  }, 120_000)

  test("survives binary output", async () => {
    const session = await open({ session: "it-output-binary" })
    const result = expectResult(await session.run({ command: "head -c 64 /dev/urandom | base64 -w0 | tail -c 16" }))
    expect(result.output.trim().length).toBeGreaterThan(0)
    expect(result.exit).toBe(0)
  }, 120_000)
})

suite("integration: shell semantics and environment", () => {
  test("supports pipes, redirection, heredocs, and background jobs", async () => {
    const session = await open({ session: "it-shell", directory: project, root: project })
    const result = expectResult(
      await session.run({
        command: [
          "cat <<'EOF' | tr 'a-z' 'A-Z' > heredoc.txt",
          "hello",
          "world",
          "EOF",
          "(printf bg >&2) & wait",
          "cat heredoc.txt",
        ].join("\n"),
      }),
    )
    expect(result.output).toContain("bg")
    expect(result.output).toContain("HELLO\nWORLD\n")
    expect(await readFile(path.join(project, "heredoc.txt"), "utf8")).toBe("HELLO\nWORLD\n")
  }, 120_000)

  test("writes are visible on the shared workspace", async () => {
    const session = await open({ session: "it-shared-write", directory: project, root: project })
    const target = path.join(project, "shared.txt")
    expectResult(await session.run({ command: "printf 'from-container\\n' > shared.txt" }))
    expect(await readFile(target, "utf8")).toBe("from-container\n")
    expect((await stat(target)).size).toBe(15)
  }, 60_000)

  test("injects only sanitized environment variables", async () => {
    const session = await open({
      session: "it-env",
      env: { IT_VISIBLE: "yes", EXECD_ACCESS_TOKEN: "leaked", OPENCODE_WORKER_TOKEN: "leaked" },
    })
    const result = expectResult(await session.run({ command: "env | sort" }))
    expect(result.output).toContain("IT_VISIBLE=yes")
    expect(result.output).toContain("OPENCODE_SESSION_ID=it-env")
    expect(result.output).not.toContain("EXECD_ACCESS_TOKEN")
    expect(result.output).not.toContain("OPENCODE_EXECD_WORKER_ACCESS_TOKEN")
    expect(result.output).not.toContain("OPENCODE_WORKER_TOKEN")
    expect(result.output).not.toContain("leaked")
  }, 60_000)

  test("gives each session its own HOME and temp directory", async () => {
    const first = await open({ session: "it-home-a" })
    const second = await open({ session: "it-home-b" })
    const a = expectResult(await first.run({ command: "printf '%s|%s' \"$HOME\" \"$TMPDIR\"" }))
    const b = expectResult(await second.run({ command: "printf '%s|%s' \"$HOME\" \"$TMPDIR\"" }))
    expect(a.output).not.toBe(b.output)
    expect(a.output).toContain(sessionDir("it-home-a"))
    expect(b.output).toContain(sessionDir("it-home-b"))
  }, 120_000)

  test("release removes the session home directory", async () => {
    const session = "it-release"
    const worker = await open({ session })
    expectResult(await worker.run({ command: "true" }))
    const dir = sessionDir(session)
    const before = expectResult(await worker.run({ command: `test -d ${dir} && echo present || echo missing` }))
    expect(before.output).toBe("present\n")

    await worker.release()

    const verifier = await open({ session: "it-release-verifier" })
    const after = expectResult(await verifier.run({ command: `test -d ${dir} && echo present || echo missing` }))
    expect(after.output).toBe("missing\n")
  }, 120_000)
})

suite("integration: cpu intensive commands", () => {
  const sumSquares = (n: bigint) => (n * (n + 1n) * (2n * n + 1n)) / 6n
  // Sized so the loop needs real CPU time on either runtime.
  const singleCount = runtime === "python3" ? 5_000_000 : 50_000_000

  beforeAll(async () => {
    // A wall-clock bounded burn loop, so cancel and timeout scenarios always land mid-flight.
    const script =
      runtime === "python3"
        ? [
            "import time",
            "deadline = time.time() + 25",
            "acc = 0",
            "while time.time() < deadline:",
            "    acc += sum(j * j for j in range(200000))",
            "print(acc)",
            "",
          ].join("\n")
        : [
            "const deadline = Date.now() + 25000",
            "let acc = 0n",
            "while (Date.now() < deadline) for (let i = 0n; i < 100000n; i++) acc += i * i",
            "console.log(String(acc))",
            "",
          ].join("\n")
    await writeFile(path.join(project, burnFile), script)
    console.log(`[cpu] compute runtime: ${runtime}`)
  })

  test("returns the exact result of a single-threaded compute loop", async () => {
    const session = await open({ session: "it-cpu-single" })
    const started = Date.now()
    const result = expectResult(await session.run({ command: compute(singleCount), timeout: 120_000 }))
    const elapsed = Date.now() - started
    expect(result.output).toBe(`${sumSquares(BigInt(singleCount - 1))}\n`)
    expect(result.exit).toBe(0)
    expect(elapsed).toBeGreaterThan(250)
    expect(elapsed).toBeLessThan(120_000)
    console.log(`[cpu] single-thread count=${singleCount} took ${elapsed}ms`)
  }, 180_000)

  test("saturates the container with parallel compute without breaking the result", async () => {
    const session = await open({ session: "it-cpu-parallel" })
    const result = expectResult(
      await session.run({
        command: `{ for i in 1 2 3 4; do ${compute(3_000_000)} & done; wait; } | sort -u | wc -l`,
        timeout: 180_000,
      }),
    )
    expect(result.output).toBe("1\n")
    expect(result.exit).toBe(0)
  }, 240_000)

  test("streams progress from a long compute loop", async () => {
    const session = await open({ session: "it-cpu-progress" })
    const result = expectResult(await session.run({ command: progress(60, 400_000), timeout: 180_000 }))
    expect(result.output.split("\n").filter((line) => line.startsWith("step "))).toHaveLength(60)
    expect(result.exit).toBe(0)
  }, 240_000)

  test("keeps the workspace mount and cwd while burning cpu", async () => {
    const session = await open({ session: "it-cpu-workspace", directory: project, root: project })
    const result = expectResult(
      await session.run({
        command: `${compute(2_000_000)} > cpu.out && pwd && cat sub/file.txt`,
        workdir: ".",
        timeout: 120_000,
      }),
    )
    expect(result.output).toBe(`${project}\nhello-from-it\n`)
    expect((await stat(path.join(project, "cpu.out"))).size).toBeGreaterThan(0)
  }, 180_000)

  test("cancelling a compute command kills the whole process group", async () => {
    const marker = path.join(project, "cancel-marker.txt")
    await rm(marker, { force: true })
    const controller = new AbortController()
    const session = await open({ session: "it-cpu-cancel", signal: controller.signal, directory: project, root: project })
    const running = session.run({
      command: `(sleep 25; touch ${marker}) & ${burnCommand}; touch ${marker}`,
      timeout: 120_000,
    })
    await Bun.sleep(1_500)
    controller.abort()
    const outcome = await running
    expect(outcome.kind).toBe("error")
    await Bun.sleep(3_000)
    expect(await stat(marker).then(() => true).catch(() => false)).toBe(false)
  }, 180_000)

  test("a compute command that exceeds its timeout does not keep running", async () => {
    const marker = path.join(project, "timeout-marker.txt")
    await rm(marker, { force: true })
    const session = await open({ session: "it-cpu-timeout", directory: project, root: project })
    const started = Date.now()
    const outcome = await session.run({ command: `${burnCommand}; touch ${marker}`, timeout: 2_000 })
    const elapsed = Date.now() - started
    console.log(
      `[cpu] timeout after ${elapsed}ms -> ${outcome.kind === "result" ? `exit=${outcome.exit}` : `error=${outcome.message}`}`,
    )
    expect(elapsed).toBeLessThan(30_000)
    await Bun.sleep(3_000)
    expect(await stat(marker).then(() => true).catch(() => false)).toBe(false)
  }, 180_000)
})

suite("integration: admission", () => {
  test("rejects a second concurrent command for the same session", async () => {
    const session = await open({ session: "it-busy" })
    const first = session.run({ command: "sleep 6", timeout: 30_000 })
    await Bun.sleep(700)
    const second = await session.run({ command: "echo second" })
    expect(second.kind).toBe("error")
    if (second.kind === "error") expect(second.message).toContain("already executing")
    expectResult(await first)
  }, 120_000)

  test("surfaces capacity exhaustion as a 503 the plugin can fail over from", async () => {
    const sessions = await Promise.all(
      Array.from({ length: 5 }, (_, index) => open({ session: `it-capacity-${index}` })),
    )
    const outcomes = await Promise.all(sessions.map((session) => session.run({ command: "sleep 4", timeout: 30_000 })))
    const errors = outcomes.filter((outcome) => outcome.kind === "error")
    console.log(`[capacity] ${outcomes.length - errors.length} ran, ${errors.length} rejected`)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind === "error" ? errors[0].message : "").toContain("503")
  }, 180_000)

  test("requires the worker bearer token", async () => {
    const session = await open({ session: "it-auth", token: "wrong-token" })
    const outcome = await session.run({ command: "echo nope" })
    expect(outcome.kind).toBe("error")
    if (outcome.kind === "error") expect(outcome.message).toContain("401")
  }, 60_000)

  test("reports a worker that is not reachable", async () => {
    const session = await open({ session: "it-unreachable", endpoint: "http://127.0.0.1:1" })
    const outcome = await session.run({ command: "echo nope" })
    expect(outcome.kind).toBe("error")
  }, 60_000)
})
