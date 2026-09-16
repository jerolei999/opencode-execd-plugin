import path from "node:path"
import type { Hooks, PluginInput, PluginOptions, ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

type WorkerResponse = {
  readonly sandboxID: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly output: string
  readonly outputTruncated: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

type Options = {
  readonly endpoints: string[]
  readonly token?: string
  readonly shell: string
  readonly defaultTimeoutMs: number
  readonly maxOutputBytes: number
  readonly env: Record<string, string>
}

export async function OpenCodeExecdPlugin(
  input: PluginInput,
  pluginOptions: PluginOptions = {},
): Promise<Hooks> {
  const options = parseOptions(pluginOptions)
  const routes = new Map<string, string>()

  return {
    tool: {
      bash: tool({
        description: [
          "Executes a shell command in the shared workspace using the remote OpenSandbox execd worker.",
          "Use workdir instead of changing directories inside the command.",
        ].join(" "),
        args: {
          command: tool.schema.string().describe("The command to execute"),
          timeout: tool.schema.number().int().positive().optional().describe("Optional timeout in milliseconds"),
          workdir: tool.schema.string().optional().describe("Working directory, relative to the project by default"),
        },
        async execute(args, context) {
          const directory = path.resolve(context.directory || input.directory)
          const worktree = context.worktree || input.worktree || directory
          const root = path.resolve(worktree === "/" ? directory : worktree)
          const cwd = path.resolve(directory, args.workdir ?? ".")

          // A workdir outside the project needs its own external_directory approval, the same
          // way the built-in tool asks for one. It matters more here because the worker root is
          // usually a shared mount, so every project on that mount is reachable from a command.
          if (!contained(directory, cwd) && !contained(root, cwd)) {
            const globs = [path.join(cwd, "*")]
            await context.ask({
              permission: "external_directory",
              patterns: globs,
              always: globs,
              metadata: { command: args.command, directories: [cwd], patterns: globs },
            })
          }

          await context.ask({
            permission: "bash",
            patterns: [args.command],
            always: [args.command],
            metadata: { command: args.command },
          })

          const response = await execute(options, routes, context, {
            sessionID: context.sessionID,
            workspaceID: root,
            root,
            command: args.command,
            cwd,
            shell: options.shell,
            env: options.env,
            timeoutMs: args.timeout ?? options.defaultTimeoutMs,
            maxOutputBytes: options.maxOutputBytes,
          })

          return {
            title: args.command,
            output: response.output || "(no output)",
            metadata: {
              exit: response.exitCode,
              truncated: response.outputTruncated,
              sandboxID: response.sandboxID,
            },
          }
        },
      }),
    },
    async event(event) {
      if (event.event.type !== "session.deleted") return
      const sessionID = event.event.properties.info.id
      const endpoint = routes.get(sessionID)
      routes.delete(sessionID)
      const endpoints = endpoint ? [endpoint] : options.endpoints
      await Promise.all(endpoints.map((item) => request(item, "/release", options, { sessionID }).catch(() => undefined)))
    },
    async dispose() {
      routes.clear()
    },
  }
}

async function execute(
  options: Options,
  routes: Map<string, string>,
  context: ToolContext,
  body: Record<string, unknown>,
) {
  const assigned = routes.get(context.sessionID)
  const endpoints = assigned
    ? [assigned, ...options.endpoints.filter((endpoint) => endpoint !== assigned)]
    : rotate(options.endpoints, hash(context.sessionID) % options.endpoints.length)
  let failure: Error | undefined

  for (const endpoint of endpoints) {
    try {
      const response = await request(endpoint, "/execute", options, body, context.abort)
      if (response.ok) {
        routes.set(context.sessionID, endpoint)
        return (await response.json()) as WorkerResponse
      }
      const message = `execd worker returned ${response.status}: ${await response.text()}`
      if (response.status !== 503) throw new Error(message)
      failure = new Error(message)
    } catch (error) {
      if (context.abort.aborted) throw error
      failure = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw failure ?? new Error("no execd worker endpoint is available")
}

function request(
  endpoint: string,
  pathname: string,
  options: Options,
  body: unknown,
  signal?: AbortSignal,
) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  // A load balancer in front of several workers cannot read the session id from the JSON
  // body, so it is repeated as a header for session stickiness (x-opencode-session).
  const sessionID = (body as { sessionID?: unknown } | undefined)?.sessionID
  if (typeof sessionID === "string" && sessionID) headers["x-opencode-session"] = sessionID
  return fetch(`${endpoint}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
}

function contained(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function parseOptions(value: PluginOptions): Options {
  const configured = Array.isArray(value.endpoints)
    ? value.endpoints.filter((item): item is string => typeof item === "string")
    : typeof value.endpoint === "string"
      ? [value.endpoint]
      : (process.env.OPENCODE_EXECD_WORKER_URLS ?? "").split(",").filter(Boolean)
  const endpoints = configured.map((endpoint) => endpoint.replace(/\/$/, ""))
  if (endpoints.length === 0) {
    throw new Error("Configure plugin option endpoint/endpoints or OPENCODE_EXECD_WORKER_URLS")
  }

  return {
    endpoints,
    token: typeof value.token === "string" ? value.token : process.env.OPENCODE_EXECD_WORKER_TOKEN,
    shell: typeof value.shell === "string" ? value.shell : "/bin/bash",
    defaultTimeoutMs: positiveInteger(value.defaultTimeoutMs, 2 * 60 * 1000),
    maxOutputBytes: positiveInteger(value.maxOutputBytes, 1024 * 1024),
    env: stringRecord(value.env),
  }
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function hash(value: string) {
  return [...value].reduce((result, character) => (result * 31 + character.charCodeAt(0)) >>> 0, 0)
}

function rotate<T>(items: T[], offset: number) {
  return [...items.slice(offset), ...items.slice(0, offset)]
}

export default OpenCodeExecdPlugin
