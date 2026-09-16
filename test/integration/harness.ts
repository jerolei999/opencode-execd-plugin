import { createHash } from "node:crypto"
import { OpenCodeExecdPlugin } from "../../src/plugin.ts"

/**
 * Shared harness for the integration suites. It drives the exact code path OpenCode uses
 * (the plugin's `bash` tool) against a real worker, so both suites agree on request shape,
 * result mapping, and the session directory layout.
 */
export const endpoint = process.env.OPENCODE_EXECD_TEST_ENDPOINT
export const token = process.env.OPENCODE_EXECD_TEST_TOKEN
export const workspace = process.env.OPENCODE_EXECD_TEST_WORKSPACE

export type Outcome =
  | {
      readonly kind: "result"
      readonly output: string
      readonly exit: number
      readonly truncated: boolean
      readonly sandboxID: string
    }
  | { readonly kind: "error"; readonly message: string }

export async function open(input: {
  session: string
  directory?: string
  root?: string
  token?: string
  env?: Record<string, string>
  signal?: AbortSignal
  endpoint?: string
  endpoints?: string[]
}) {
  const root = input.root ?? workspace!
  const directory = input.directory ?? root
  const hooks = await OpenCodeExecdPlugin(
    { directory, worktree: root } as never,
    {
      endpoint: input.endpoints ? undefined : (input.endpoint ?? endpoint!),
      endpoints: input.endpoints,
      token: input.token ?? token,
      shell: "/bin/bash",
      env: input.env,
    },
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

export function expectResult(outcome: Outcome) {
  if (outcome.kind !== "result") throw new Error(`expected a result, received error: ${outcome.message}`)
  return outcome
}

export function sessionDir(session: string) {
  return `/tmp/opencode-sessions/${createHash("sha256").update(session).digest("hex").slice(0, 32)}`
}
