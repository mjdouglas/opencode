import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import type { ClaudePluginDiscovery } from "./discovery"
import type { Config } from "../config/config"

export namespace ClaudePluginMcp {
  const log = Log.create({ service: "claude-plugins.mcp" })

  interface ClaudeMcpServer {
    command?: string
    args?: string[]
    env?: Record<string, string>
    type?: string
    url?: string
  }

  interface ClaudeMcpConfig {
    mcpServers?: Record<string, ClaudeMcpServer>
  }

  /**
   * Resolve ${CLAUDE_PLUGIN_ROOT} references in string values.
   */
  function resolvePluginRoot(value: string, pluginPath: string): string {
    return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginPath)
  }

  function resolveEnv(env: Record<string, string> | undefined, pluginPath: string): Record<string, string> {
    if (!env) return {}
    const resolved: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      resolved[key] = resolvePluginRoot(value, pluginPath)
    }
    return resolved
  }

  /**
   * Load MCP server configurations from a Claude Code plugin's .mcp.json file
   * and convert them to OpenCode's MCP config format.
   */
  export async function load(plugin: ClaudePluginDiscovery.DiscoveredPlugin): Promise<Record<string, Config.Mcp>> {
    const mcpConfigPath = plugin.manifest.mcpServers
      ? path.resolve(plugin.path, plugin.manifest.mcpServers)
      : path.join(plugin.path, ".mcp.json")

    let raw: string
    try {
      raw = await fs.readFile(mcpConfigPath, "utf-8")
    } catch {
      return {}
    }

    let config: ClaudeMcpConfig
    try {
      config = JSON.parse(raw)
    } catch {
      log.error("failed to parse MCP config", { plugin: plugin.name, path: mcpConfigPath })
      return {}
    }

    const servers = config.mcpServers ?? {}
    const result: Record<string, Config.Mcp> = {}

    for (const [name, server] of Object.entries(servers)) {
      const key = `claude:${plugin.name}:${name}`

      if (server.type === "remote" || server.url) {
        // Remote MCP server - not commonly used in plugins but supported
        log.debug("skipping remote MCP server from Claude plugin", { plugin: plugin.name, server: name })
        continue
      }

      if (!server.command) {
        log.debug("skipping MCP server without command", { plugin: plugin.name, server: name })
        continue
      }

      const command = resolvePluginRoot(server.command, plugin.path)
      const args = (server.args ?? []).map((arg) => resolvePluginRoot(arg, plugin.path))
      const environment = resolveEnv(server.env, plugin.path)

      result[key] = {
        type: "local" as const,
        command: [command, ...args],
        environment: Object.keys(environment).length > 0 ? environment : undefined,
      }

      log.info("loaded MCP server from Claude plugin", { plugin: plugin.name, server: name, key })
    }

    return result
  }
}
