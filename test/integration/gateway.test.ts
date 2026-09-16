import { describe, expect, test } from "bun:test"
import { expectResult, open, sessionDir, token, workspace } from "./harness.ts"

/**
 * Multi-replica gateway scenarios: several opencode-execd replicas behind one load balancer,
 * which is how the Bridge style deployment exposes a single stable service URL.
 *
 *   docker run -d --name opencode-execd-it-1 -p 19021:9010 ... opencode-execd:local
 *   docker run -d --name opencode-execd-it-2 -p 19022:9010 ... opencode-execd:local
 *   docker run -d --name opencode-execd-gateway -p 19030:19030 -v nginx.conf:/etc/nginx/nginx.conf:ro nginx:alpine
 *
 *   OPENCODE_EXECD_TEST_GATEWAY=http://127.0.0.1:19030 \
 *   OPENCODE_EXECD_TEST_TOKEN=it-plugin-secret \
 *   OPENCODE_EXECD_TEST_WORKSPACE=/private/tmp/execd-it \
 *   OPENCODE_EXECD_TEST_REPLICAS=http://127.0.0.1:19021,http://127.0.0.1:19022 \
 *   bun test test/integration/gateway.test.ts
 */
const gateway = process.env.OPENCODE_EXECD_TEST_GATEWAY
const replicas = (process.env.OPENCODE_EXECD_TEST_REPLICAS ?? "").split(",").filter(Boolean)
// With a shared session root (CubeFS mounted at OPENCODE_SESSION_ROOT) every replica sees the
// same session home, so HOME continuity and /release stop depending on where the request lands.
// Same-session serialization stays node-local, because that registry lives in worker memory.
const sharedHome = process.env.OPENCODE_EXECD_TEST_SHARED_HOME === "1"
const enabled = Boolean(gateway && workspace && replicas.length > 1)
const suite = enabled ? describe : describe.skip

/** Worker ID each replica reports, so results can be attributed to a specific replica. */
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

suite("gateway integration: replicas behind one URL", () => {
  test("serves commands through the load balancer", async () => {
    const session = await open({ session: "gw-basic", endpoint: gateway })
    const result = expectResult(await session.run({ command: "printf through-gateway" }))
    expect(result.output).toBe("through-gateway\n")
    expect(result.exit).toBe(0)
    expect([...ids.values()]).toContain(result.sandboxID)
    console.log(`[gateway] served by ${result.sandboxID}`)
  }, 60_000)

  test("spreads separate sessions across replicas", async () => {
    const seen = new Set<string>()
    for (let index = 0; index < 6; index++) {
      const session = await open({ session: `gw-spread-${index}`, endpoint: gateway })
      seen.add(expectResult(await session.run({ command: "true" })).sandboxID)
    }
    console.log(`[gateway] spread over ${seen.size} replicas: ${[...seen].join(", ")}`)
    expect(seen.size).toBeGreaterThan(1)
  }, 120_000)

  test("a single URL cannot pin one session to one replica", async () => {
    const session = await open({ session: "gw-affinity", endpoint: gateway })
    const hosts: string[] = []
    const homes: string[] = []
    for (let index = 0; index < 3; index++) {
      const result = expectResult(await session.run({ command: "printf '%s' \"$HOME\"" }))
      hosts.push(result.sandboxID)
      homes.push(result.output)
    }
    // The path stays deterministic (same hash of the session id), but the directory itself is
    // node-local, so state written on one replica is absent on the next one.
    expect(new Set(hosts).size).toBeGreaterThan(1)
    expect(new Set(homes).size).toBe(1)

    const observed: string[] = []
    for (let index = 0; index < 4; index++) {
      expectResult(await session.run({ command: "printf state > \"$HOME/state.txt\"" }))
      const read = expectResult(await session.run({ command: "cat \"$HOME/state.txt\" 2>/dev/null || echo MISSING" }))
      observed.push(read.output.trim())
    }
    console.log(`[gateway] session HOME reads through the gateway: ${observed.join(", ")}`)
    if (sharedHome) expect(observed).not.toContain("MISSING")
    else expect(observed).toContain("MISSING")
  }, 120_000)

  test("per-session concurrency guard is not shared between replicas", async () => {
    const session = await open({ session: "gw-busy", endpoint: gateway })
    const first = session.run({ command: "sleep 5; printf first", timeout: 30_000 })
    await Bun.sleep(500)
    const second = await session.run({ command: "printf second" })
    const firstResult = await first
    console.log(
      `[gateway] concurrent same-session calls -> first=${firstResult.kind} on ${firstResult.kind === "result" ? firstResult.sandboxID : "-"}, second=${second.kind} on ${second.kind === "result" ? second.sandboxID : "-"}`,
    )
    // Both are accepted because they landed on different replicas, so the invariant
    // "one active command per session" no longer holds behind a shared URL.
    expect(firstResult.kind).toBe("result")
    expect(second.kind).toBe("result")
  }, 120_000)

  test("release can miss the replica that holds the session directory", async () => {
    const sessionID = "gw-release"
    const throughGateway = await open({ session: sessionID, endpoint: gateway })
    const executed = expectResult(await throughGateway.run({ command: "printf work" }))
    await throughGateway.release()

    const dir = sessionDir(sessionID)
    const survivors = await Promise.all(
      replicas.map(async (replica) => {
        const direct = await open({ session: `gw-release-probe-${ids.get(replica)}`, endpoint: replica })
        const outcome = expectResult(await direct.run({ command: `test -d ${dir} && echo present || echo missing` }))
        return { replica, present: outcome.output === "present\n" }
      }),
    )
    console.log(`[gateway] after release: ${survivors.map((item) => `${item.replica}=${item.present}`).join(", ")}`)
    if (sharedHome) expect(survivors.filter((item) => item.present)).toHaveLength(0)
    else expect(survivors.filter((item) => item.present).length).toBeGreaterThan(0)
    expect(executed.sandboxID).not.toBe("")
  }, 120_000)

  test("client-side endpoint list pins a session to one replica", async () => {
    const session = await open({ session: "gw-pinned", endpoints: replicas })
    const hosts: string[] = []
    const homes: string[] = []
    for (let index = 0; index < 3; index++) {
      const result = expectResult(await session.run({ command: "printf '%s' \"$HOME\"" }))
      hosts.push(result.sandboxID)
      homes.push(result.output)
    }
    console.log(`[gateway] endpoint list pinned ${homes.length} calls to ${new Set(hosts).size} replica(s)`)
    expect(new Set(hosts).size).toBe(1)
    expect(new Set(homes).size).toBe(1)

    const dir = sessionDir("gw-pinned")
    const pinned = hosts[0]
    await session.release()
    const replica = replicas.find((item) => ids.get(item) === pinned)
    expect(replica).toBeDefined()
    if (replica) {
      const direct = await open({ session: `gw-pinned-probe-${ids.get(replica)}`, endpoint: replica })
      const outcome = expectResult(await direct.run({ command: `test -d ${dir} && echo present || echo missing` }))
      expect(outcome.output).toBe("missing\n")
    }
  }, 120_000)
})
