import { afterEach, describe, expect, test } from "bun:test"
import { OpenCodeExecdPlugin } from "../src/plugin.ts"

const servers: Bun.Server<unknown>[] = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})

describe("OpenCodeExecdPlugin", () => {
  test("overrides bash and forwards the native tool contract", async () => {
    let received: { body?: unknown; authorization?: string | null } = {}
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/execute") {
          return new Response("not found", { status: 404 })
        }
        received = {
          body: await request.json(),
          authorization: request.headers.get("authorization"),
        }
        return Response.json({
          sandboxID: "node-1",
          exitCode: 3,
          stdout: "build output",
          stderr: "",
          output: "build output",
          outputTruncated: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        })
      },
    })
    servers.push(server)
    const hooks = await OpenCodeExecdPlugin(
      { directory: "/cubefs/acme/repo", worktree: "/cubefs/acme/repo" } as never,
      { endpoint: server.url.toString(), token: "worker-secret", shell: "/bin/bash" },
    )
    const asks: unknown[] = []

    const result = await hooks.tool?.bash.execute(
      { command: "bun test", timeout: 9000, workdir: "packages/api" },
      {
        sessionID: "session-1",
        messageID: "message-1",
        agent: "build",
        directory: "/cubefs/acme/repo",
        worktree: "/cubefs/acme/repo",
        abort: new AbortController().signal,
        metadata() {},
        async ask(input) {
          asks.push(input)
        },
      },
    )

    expect(asks).toHaveLength(1)
    expect(received.authorization).toBe("Bearer worker-secret")
    expect(received.body).toEqual({
      sessionID: "session-1",
      workspaceID: "/cubefs/acme/repo",
      root: "/cubefs/acme/repo",
      command: "bun test",
      cwd: "/cubefs/acme/repo/packages/api",
      shell: "/bin/bash",
      env: {},
      timeoutMs: 9000,
      maxOutputBytes: 1048576,
    })
    expect(result).toEqual({
      title: "bun test",
      output: "build output",
      metadata: { exit: 3, truncated: false, sandboxID: "node-1" },
    })
  })

  test("releases session state when OpenCode deletes a session", async () => {
    const released: unknown[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "POST" && new URL(request.url).pathname === "/release") {
          released.push(await request.json())
          return Response.json({ released: true })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    const hooks = await OpenCodeExecdPlugin(
      { directory: "/cubefs/repo", worktree: "/cubefs/repo" } as never,
      { endpoint: server.url.toString() },
    )

    await hooks.event?.({
      event: { type: "session.deleted", properties: { info: { id: "session-2" } } } as never,
    })

    expect(released).toEqual([{ sessionID: "session-2" }])
  })
})
