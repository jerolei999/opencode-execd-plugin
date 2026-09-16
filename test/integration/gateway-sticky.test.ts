import { describe, expect, test } from "bun:test"
import { expectResult, open, sessionDir, token, workspace } from "./harness.ts"

/**
 * Multi-replica gateway with session stickiness: the plugin sends `x-opencode-session`, and the
 * load balancer hashes on it, which keeps one session on one replica.
 *
 *   # nginx
 *   map $http_x_opencode_session $sticky_key { "" $request_id; default $http_x_opencode_session; }
 *   upstream execd_workers { hash $sticky_key consistent; server ...:19021; server ...:19022; }
 *
 *   OPENCODE_EXECD_TEST_STICKY_GATEWAY=http://127.0.0.1:19031 \
 *   OPENCODE_EXECD_TEST_TOKEN=it-plugin-secret \
 *   OPENCODE_EXECD_TEST_WORKSPACE=/private/tmp/execd-it \
 *   OPENCODE_EXECD_TEST_REPLICAS=http://127.0.0.1:19021,http://127.0.0.1:19022 \
 *   bun test test/integration/gateway-sticky.test.ts
 *
 * `gateway.test.ts` is the control case: the same scenarios through a round-robin gateway.
 */
const gateway = process.env.OPENCODE_EXECD_TEST_STICKY_GATEWAY
const replicas = (process.env.OPENCODE_EXECD_TEST_REPLICAS ?? "").split(",").filter(Boolean)
const enabled = Boolean(gateway && workspace && replicas.length > 1)
const suite = enabled ? describe : describe.skip

async function replicaIDs() {
  const entries = await Promise.all(
    replicas.map(async (replica) => {
      const response = await fetch(`${replica.replace(/\/$/, "")}/health`, {
        headers: { authorization: `Bearer ${token}` },
      })
      const health = (await response.json()) as { id: string }
      return [replica, health.id] as const
    }),
  )
  return new Map(entries)
}

const ids = enabled ? await replicaIDs() : new Map<string, string>()

suite("sticky gateway integration: one URL with session affinity", () => {
  test("keeps a session on a single replica", async () => {
    const session = await open({ session: "sticky-pin", endpoint: gateway })
    const hosts: string[] = []
    for (let index = 0; index < 4; index++) {
      hosts.push(expectResult(await session.run({ command: "true" })).sandboxID)
    }
    console.log(`[sticky] 4 calls for one session landed on ${[...new Set(hosts)].join(", ")}`)
    expect(new Set(hosts).size).toBe(1)
  }, 120_000)

  test("keeps session home state across calls", async () => {
    const session = await open({ session: "sticky-home", endpoint: gateway })
    expectResult(await session.run({ command: "printf state > \"$HOME/state.txt\"" }))
    const reads: string[] = []
    for (let index = 0; index < 3; index++) {
      reads.push(expectResult(await session.run({ command: "cat \"$HOME/state.txt\"" })).output.trim())
    }
    console.log(`[sticky] home reads: ${reads.join(", ")}`)
    expect(reads).toEqual(["state", "state", "state"])
  }, 120_000)

  test("still serializes commands for the same session", async () => {
    const session = await open({ session: "sticky-busy", endpoint: gateway })
    const first = session.run({ command: "sleep 5; printf first", timeout: 30_000 })
    await Bun.sleep(500)
    const second = await session.run({ command: "printf second" })
    console.log(`[sticky] concurrent same-session call -> ${second.kind}`)
    expect(second.kind).toBe("error")
    if (second.kind === "error") expect(second.message).toContain("already executing")
    expectResult(await first)
  }, 120_000)

  test("release reaches the replica that holds the session", async () => {
    const sessionID = "sticky-release"
    const throughGateway = await open({ session: sessionID, endpoint: gateway })
    expectResult(await throughGateway.run({ command: "printf work" }))
    await throughGateway.release()

    const dir = sessionDir(sessionID)
    const survivors = await Promise.all(
      replicas.map(async (replica) => {
        const direct = await open({ session: `sticky-release-probe-${ids.get(replica)}`, endpoint: replica })
        const outcome = expectResult(await direct.run({ command: `test -d ${dir} && echo present || echo missing` }))
        return { replica: ids.get(replica), present: outcome.output === "present\n" }
      }),
    )
    console.log(`[sticky] after release: ${survivors.map((item) => `${item.replica}=${item.present}`).join(", ")}`)
    expect(survivors.filter((item) => item.present)).toHaveLength(0)
  }, 120_000)

  test("still spreads separate sessions across replicas", async () => {
    const seen = new Set<string>()
    for (let index = 0; index < 6; index++) {
      const session = await open({ session: `sticky-spread-${index}`, endpoint: gateway })
      seen.add(expectResult(await session.run({ command: "true" })).sandboxID)
    }
    console.log(`[sticky] spread over ${seen.size} replicas: ${[...seen].join(", ")}`)
    expect(seen.size).toBeGreaterThan(1)
  }, 120_000)

  test("tolerates requests without the sticky header", async () => {
    const response = await fetch(`${gateway}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sessionID: "sticky-no-header",
        workspaceID: "w",
        root: workspace,
        cwd: workspace,
        command: "echo fallback",
        shell: "/bin/bash",
      }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { output: string }
    expect(body.output.trim()).toBe("fallback")
  }, 60_000)
})
