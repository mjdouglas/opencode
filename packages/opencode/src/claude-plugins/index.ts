import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Glob } from "../util/glob"
import { Instance } from "../project/instance"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const log = Log.create({ service: "plugin.claude-plugins" })

// ── Types ──────────────────────────────────────────────────────────────

interface Manifest {
  name: string
  version?: string
  description?: string
  skills?: string
  hooks?: string
  mcpServers?: string
}

interface DiscoveredPlugin {
  name: string
  path: string
  manifest: Manifest
}

interface ClaudeMcpServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: string
  url?: string
}

interface ClaudeHookHandler {
  type: "command" | "prompt" | "agent"
  command?: string
  timeout?: number
}

interface ClaudeHookEntry {
  matcher?: string
  hooks: ClaudeHookHandler[]
}

interface ClaudeHooksConfig {
  PreToolUse?: ClaudeHookEntry[]
  PostToolUse?: ClaudeHookEntry[]
  [key: string]: ClaudeHookEntry[] | undefined
}

// ── Helpers ────────────────────────────────────────────────────────────

async function readJsonSafe<T>(filepath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filepath, "utf-8")
    return JSON.parse(content) as T
  } catch {
    return undefined
  }
}

function resolvePluginRoot(value: string, pluginPath: string): string {
  return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginPath)
}

function claudeDir(): string {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".claude")
}

// ── Discovery ──────────────────────────────────────────────────────────

async function discover(): Promise<DiscoveredPlugin[]> {
  const plugins: DiscoveredPlugin[] = []
  const seen = new Set<string>()

  const userSettings = await readJsonSafe<{ enabledPlugins?: string[] }>(
    path.join(claudeDir(), "settings.json"),
  )
  const enabledNames = new Set<string>(userSettings?.enabledPlugins ?? [])

  const projectSettings = await readJsonSafe<{ enabledPlugins?: string[] }>(
    path.join(Instance.directory, ".claude", "settings.json"),
  )
  if (projectSettings?.enabledPlugins) {
    for (const name of projectSettings.enabledPlugins) enabledNames.add(name)
  }

  const cacheDir = path.join(claudeDir(), "plugins", "cache")
  try {
    for (const entry of await fs.readdir(cacheDir, { withFileTypes: true })) {
      if (entry.isDirectory()) enabledNames.add(entry.name)
    }
  } catch {}

  for (const name of enabledNames) {
    if (seen.has(name)) continue
    seen.add(name)

    const pluginPath = await resolvePluginPath(name)
    if (!pluginPath) continue

    const manifest = await readJsonSafe<Manifest>(
      path.join(pluginPath, ".claude-plugin", "plugin.json"),
    )
    if (!manifest?.name) continue

    plugins.push({ name: manifest.name, path: pluginPath, manifest })
    log.info("discovered Claude Code plugin", { name: manifest.name })
  }

  return plugins
}

async function resolvePluginPath(name: string): Promise<string | undefined> {
  const cachePath = path.join(claudeDir(), "plugins", "cache", name)
  try {
    if ((await fs.stat(cachePath)).isDirectory()) return cachePath
  } catch {}

  if (path.isAbsolute(name)) {
    try {
      if ((await fs.stat(name)).isDirectory()) return name
    } catch {}
  }

  return undefined
}

// ── MCP Servers ────────────────────────────────────────────────────────

async function loadMcpServers(
  plugin: DiscoveredPlugin,
): Promise<Record<string, { type: "local"; command: string[]; environment?: Record<string, string> }>> {
  const mcpConfigPath = plugin.manifest.mcpServers
    ? path.resolve(plugin.path, plugin.manifest.mcpServers)
    : path.join(plugin.path, ".mcp.json")

  const config = await readJsonSafe<{ mcpServers?: Record<string, ClaudeMcpServer> }>(mcpConfigPath)
  if (!config?.mcpServers) return {}

  const result: Record<string, { type: "local"; command: string[]; environment?: Record<string, string> }> = {}

  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.type === "remote" || server.url || !server.command) continue

    const command = resolvePluginRoot(server.command, plugin.path)
    const args = (server.args ?? []).map((a) => resolvePluginRoot(a, plugin.path))
    const env: Record<string, string> = {}
    if (server.env) {
      for (const [k, v] of Object.entries(server.env)) {
        env[k] = resolvePluginRoot(v, plugin.path)
      }
    }

    const key = `claude:${plugin.name}:${name}`
    result[key] = {
      type: "local" as const,
      command: [command, ...args],
      environment: Object.keys(env).length > 0 ? env : undefined,
    }
    log.info("loaded MCP server from Claude plugin", { plugin: plugin.name, server: name })
  }

  return result
}

// ── Skills → Tools ─────────────────────────────────────────────────────

function parseSkillMd(content: string): { description: string; body: string } {
  const lines = content.split("\n")
  if (lines[0]?.trim() !== "---") return { description: "", body: content.trim() }

  const endIndex = lines.indexOf("---", 1)
  if (endIndex === -1) return { description: "", body: content.trim() }

  let description = ""
  for (let i = 1; i < endIndex; i++) {
    const colonIdx = lines[i].indexOf(":")
    if (colonIdx === -1) continue
    const key = lines[i].slice(0, colonIdx).trim()
    const value = lines[i].slice(colonIdx + 1).trim()
    if (key === "description" && value) description = value
  }

  return { description, body: lines.slice(endIndex + 1).join("\n").trim() }
}

async function loadSkillTools(
  plugin: DiscoveredPlugin,
): Promise<Record<string, ReturnType<typeof tool>>> {
  const skillsDir = plugin.manifest.skills
    ? path.resolve(plugin.path, plugin.manifest.skills)
    : path.join(plugin.path, "skills")

  try {
    await fs.stat(skillsDir)
  } catch {
    return {}
  }

  const matches = Glob.scanSync("*/SKILL.md", {
    cwd: skillsDir,
    absolute: true,
    dot: true,
    symlink: true,
  })

  const result: Record<string, ReturnType<typeof tool>> = {}

  for (const match of matches) {
    try {
      const content = await fs.readFile(match, "utf-8")
      const { description, body } = parseSkillMd(content)
      const skillName = path.basename(path.dirname(match))
      const toolName = `claude_${plugin.name.replace(/[^a-zA-Z0-9]/g, "_")}_${skillName}`

      result[toolName] = tool({
        description: description || `Skill from Claude plugin ${plugin.name}: ${skillName}`,
        args: {
          input: tool.schema.string().optional().describe("Optional input to pass to the skill"),
        },
        async execute(args) {
          return body + (args.input ? `\n\nUser input: ${args.input}` : "")
        },
      })

      log.info("loaded skill tool from Claude plugin", { plugin: plugin.name, skill: skillName })
    } catch (err) {
      log.error("failed to load skill", { plugin: plugin.name, path: match, error: String(err) })
    }
  }

  return result
}

// ── Hooks ──────────────────────────────────────────────────────────────

async function executeShellCommand(command: string, cwd: string, $: PluginInput["$"], timeout?: number): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })

  const timeoutMs = timeout ?? 30000
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    await proc.exited
  } finally {
    clearTimeout(timer)
  }
}

async function loadHooks(
  plugin: DiscoveredPlugin,
  $: PluginInput["$"],
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after">> {
  const hooksPath = plugin.manifest.hooks
    ? path.resolve(plugin.path, plugin.manifest.hooks)
    : path.join(plugin.path, "hooks", "hooks.json")

  const config = await readJsonSafe<ClaudeHooksConfig>(hooksPath)
  if (!config) return {}

  const hooks: Pick<Hooks, "tool.execute.before" | "tool.execute.after"> = {}
  const pluginDir = plugin.path

  if (config.PreToolUse?.length) {
    const entries = config.PreToolUse
    hooks["tool.execute.before"] = async (input, output) => {
      for (const entry of entries) {
        if (entry.matcher && entry.matcher !== "*" && !input.tool.includes(entry.matcher)) continue
        for (const handler of entry.hooks) {
          if (handler.type !== "command" || !handler.command) continue
          try {
            await executeShellCommand(handler.command, pluginDir, $, handler.timeout)
          } catch (err) {
            log.error("PreToolUse hook failed", { plugin: plugin.name, error: String(err) })
          }
        }
      }
    }
  }

  if (config.PostToolUse?.length) {
    const entries = config.PostToolUse
    hooks["tool.execute.after"] = async (input, output) => {
      for (const entry of entries) {
        if (entry.matcher && entry.matcher !== "*" && !input.tool.includes(entry.matcher)) continue
        for (const handler of entry.hooks) {
          if (handler.type !== "command" || !handler.command) continue
          try {
            await executeShellCommand(handler.command, pluginDir, $, handler.timeout)
          } catch (err) {
            log.error("PostToolUse hook failed", { plugin: plugin.name, error: String(err) })
          }
        }
      }
    }
  }

  return hooks
}

// ── Plugin Entry Point ─────────────────────────────────────────────────

export const ClaudePluginsPlugin = async (input: PluginInput): Promise<Hooks> => {
  const allTools: Record<string, ReturnType<typeof tool>> = {}
  const allBeforeHooks: Hooks["tool.execute.before"][] = []
  const allAfterHooks: Hooks["tool.execute.after"][] = []
  const mcpConfigs: Record<string, { type: "local"; command: string[]; environment?: Record<string, string> }> = {}

  let plugins: DiscoveredPlugin[]
  try {
    plugins = await discover()
  } catch (err) {
    log.error("failed to discover Claude Code plugins", { error: String(err) })
    return {}
  }

  if (plugins.length === 0) {
    log.debug("no Claude Code plugins found")
    return {}
  }

  log.info("found Claude Code plugins", { count: plugins.length, names: plugins.map((p) => p.name) })

  for (const plugin of plugins) {
    try {
      // MCP servers
      const mcp = await loadMcpServers(plugin)
      Object.assign(mcpConfigs, mcp)

      // Skills → tools
      const tools = await loadSkillTools(plugin)
      Object.assign(allTools, tools)

      // Hooks
      const hooks = await loadHooks(plugin, input.$)
      if (hooks["tool.execute.before"]) allBeforeHooks.push(hooks["tool.execute.before"])
      if (hooks["tool.execute.after"]) allAfterHooks.push(hooks["tool.execute.after"])
    } catch (err) {
      log.error("failed to load Claude plugin", { name: plugin.name, error: String(err) })
    }
  }

  const result: Hooks = {}

  // Register tools from skills
  if (Object.keys(allTools).length > 0) {
    result.tool = allTools
  }

  // Inject MCP servers into config via the config hook
  if (Object.keys(mcpConfigs).length > 0) {
    result.config = async (config) => {
      const mcp = (config as any).mcp ?? {}
      Object.assign(mcp, mcpConfigs)
      ;(config as any).mcp = mcp
    }
  }

  // Combine hooks from all plugins
  if (allBeforeHooks.length > 0) {
    result["tool.execute.before"] = async (input, output) => {
      for (const fn of allBeforeHooks) await fn!(input, output)
    }
  }

  if (allAfterHooks.length > 0) {
    result["tool.execute.after"] = async (input, output) => {
      for (const fn of allAfterHooks) await fn!(input, output)
    }
  }

  return result
}

ClaudePluginsPlugin.pluginName = "claude-plugins"
