import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Integration suite that drives a real OpenCode session (model in the loop) against a
 * running opencode-execd worker, so the bash override is exercised end to end:
 *
 *   OPENCODE_EXECD_TEST_ENDPOINT=http://127.0.0.1:19020 \
 *   OPENCODE_EXECD_TEST_TOKEN=it-plugin-secret \
 *   OPENCODE_EXECD_TEST_WORKSPACE=/private/tmp/execd-it \
 *   OPENCODE_EXECD_TEST_MODEL=deepseek/deepseek-v4-flash \
 *   OPENCODE_EXECD_TEST_CONTAINER=opencode-execd-it \
 *   bun test test/integration/opencode.test.ts
 *
 * `OPENCODE_EXECD_TEST_CONTAINER` is optional and only enables the container CPU sampling
 * assertions. Without the variables above the suite is skipped.
 */
const endpoint = process.env.OPENCODE_EXECD_TEST_ENDPOINT
const token = process.env.OPENCODE_EXECD_TEST_TOKEN
const workspace = process.env.OPENCODE_EXECD_TEST_WORKSPACE
const model = process.env.OPENCODE_EXECD_TEST_MODEL
const container = process.env.OPENCODE_EXECD_TEST_CONTAINER
const opencodeBin = process.env.OPENCODE_BIN ?? "opencode"
const enabled = Boolean(endpoint && workspace && model)

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const project = workspace ? path.join(workspace, "opencode-it") : "/"
const suite = enabled ? describe : describe.skip

const compute =
  process.env.OPENCODE_EXECD_TEST_RUNTIME === "python3"
    ? (count: number) => `python3 -c "print(sum(i * i for i in range(${count})))"`
    : (count: number) =>
        `bun -e "let s=0n;for(let i=0n;i<${count}n;i++)s+=i*i;console.log(String(s))"`

const sumSquares = (n: bigint) => (n * (n + 1n) * (2n * n + 1n)) / 6n

async function ask(prompt: string, timeoutMs = 180_000) {
  const started = Date.now()
  // `--dir` is required: opencode resolves the project directory from PWD, so spawning it
  // with a different cwd alone still picks up the parent process's project (and then silently
  // loads no plugin config and runs the built-in bash tool instead).
  const proc = Bun.spawn([opencodeBin, "run", "--dir", project, "-m", model!, prompt], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  clearTimeout(timer)
  return { stdout, stderr, exitCode, elapsed: Date.now() - started }
}

function reported(stdout: string) {
  const match = stdout.match(/<out>\s*([\s\S]*?)\s*<\/out>/)
  return match?.[1].trim().replace(/^`+|`+$/g, "").trim()
}

async function expectReported(command: string, expected: string, extra = "") {
  const prompt = [
    `Call the bash tool with exactly this command: ${command}`,
    extra,
    "Then reply with only the raw stdout of that command, wrapped in <out> and </out> tags.",
    "Never substitute another command, never explain, never reformat the output.",
  ]
    .filter(Boolean)
    .join("\n")

  const failures: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await ask(prompt)
    const value = reported(result.stdout)
    if (value === expected) return { attempt, elapsed: result.elapsed }
    failures.push(
      `attempt ${attempt}: exit=${result.exitCode} value=${JSON.stringify(value)} stdout=${JSON.stringify(result.stdout.slice(0, 300))}`,
    )
  }
  throw new Error(`model did not report ${JSON.stringify(expected)}\n${failures.join("\n")}`)
}

async function cpuPercent() {
  const proc = Bun.spawn(["docker", "stats", "--no-stream", "--format", "{{.CPUPerc}}", container!], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  const value = Number.parseFloat(text.trim().replace("%", ""))
  return Number.isFinite(value) ? value : 0
}

/** Samples container CPU until the awaited work finishes and returns the peak. */
async function peakCpuWhile(work: Promise<unknown>) {
  let peak = 0
  let done = false
  const sampler = (async () => {
    while (!done) {
      peak = Math.max(peak, await cpuPercent())
      await Bun.sleep(500)
    }
  })()
  await work
  done = true
  await sampler
  return peak
}

suite("opencode integration: bash override through a real session", () => {
  beforeAll(async () => {
    await mkdir(path.join(project, "sub"), { recursive: true })
    await mkdir(path.join(project, ".opencode"), { recursive: true })
    await writeFile(path.join(project, "sub", "file.txt"), "hello-from-opencode\n")
    await writeFile(
      path.join(project, ".opencode", "opencode.jsonc"),
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [[`file://${repoRoot}`, { endpoint, token, shell: "/bin/bash" }]],
          permission: { bash: "allow" },
        },
        null,
        2,
      )}\n`,
    )
    // Wall-clock bounded burn loop, long enough that a 3s tool timeout must interrupt it.
    await writeFile(
      path.join(project, "burn.ts"),
      [
        "const deadline = Date.now() + 120000",
        "let acc = 0n",
        "while (Date.now() < deadline) for (let i = 0n; i < 100000n; i++) acc += i * i",
        "console.log(String(acc))",
        "",
      ].join("\n"),
    )
  }, 60_000)

  test("runs a command in the project directory by default", async () => {
    const result = await expectReported("pwd", project)
    console.log(`[opencode] default cwd reported after ${result.elapsed}ms (attempt ${result.attempt})`)
  }, 240_000)

  test("reads files from the shared workspace", async () => {
    const result = await expectReported("cat sub/file.txt", "hello-from-opencode")
    console.log(`[opencode] shared workspace read after ${result.elapsed}ms`)
  }, 240_000)

  test("honours an explicit workdir", async () => {
    await expectReported("pwd", path.join(project, "sub"), "Pass workdir: sub in the same tool call.")
  }, 240_000)

  test("preserves multi-line output", async () => {
    await expectReported("printf 'alpha\\nbeta\\ngamma\\n'", "alpha\nbeta\ngamma")
  }, 240_000)

  test("reports stdout of a failing command instead of an error", async () => {
    await expectReported("printf 'partial-output'; exit 3", "partial-output")
  }, 240_000)

  test("returns the exact result of a cpu intensive command", async () => {
    const count = 50_000_000
    const peak = await peakCpuWhile(expectReported(compute(count), `${sumSquares(BigInt(count - 1))}`))
    console.log(`[opencode] cpu peak during single-thread compute: ${peak}%`)
    if (container) expect(peak).toBeGreaterThan(10)
  }, 300_000)

  test("saturates the container with parallel compute", async () => {
    const command = `{ for i in 1 2 3 4; do ${compute(10_000_000)} & done; wait; } | sort -u | wc -l`
    const peak = await peakCpuWhile(expectReported(command, "1"))
    console.log(`[opencode] cpu peak during parallel compute: ${peak}%`)
    if (container) expect(peak).toBeGreaterThan(10)
  }, 300_000)

  test("a cpu intensive command that exceeds its timeout returns control", async () => {
    const prompt = [
      "Call the bash tool with exactly this command: bun burn.ts",
      "Set the tool timeout argument to 3000 milliseconds.",
      "Then reply with only the raw stdout of that command, wrapped in <out> and </out> tags.",
    ].join("\n")
    const started = Date.now()
    const result = await ask(prompt, 150_000)
    const elapsed = Date.now() - started
    console.log(`[opencode] timeout session finished after ${elapsed}ms, exit=${result.exitCode}`)
    expect(elapsed).toBeLessThan(90_000)
  }, 200_000)

  afterAll(async () => {
    await rm(path.join(project, "burn.ts"), { force: true })
  })
})
