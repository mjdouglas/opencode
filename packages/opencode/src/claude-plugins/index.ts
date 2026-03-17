import { Log } from "../util/log"
import { ClaudePluginDiscovery } from "./discovery"
import { ClaudePluginMcp } from "./mcp"
import { ClaudePluginSkills } from "./skills"
import { ClaudePluginHooks } from "./hooks"
import type { Hooks } from "@opencode-ai/plugin"
import type { Config } from "../config/config"

export namespace ClaudePlugins {
  const log = Log.create({ service: "claude-plugins" })

  export interface LoadResult {
    mcp: Record<string, Config.Mcp>
    commands: Record<string, Config.Command>
    hooks: Hooks[]
    pluginNames: string[]
  }

  /**
   * Discover and load all Claude Code plugins installed on the system.
   * Returns MCP configs, commands (from skills), and hooks that should be
   * merged into OpenCode's configuration.
   */
  export async function load(options?: { exclude?: string[] }): Promise<LoadResult> {
    const result: LoadResult = {
      mcp: {},
      commands: {},
      hooks: [],
      pluginNames: [],
    }

    const excludeSet = new Set(options?.exclude ?? [])

    let plugins: ClaudePluginDiscovery.DiscoveredPlugin[]
    try {
      plugins = await ClaudePluginDiscovery.discover()
    } catch (err) {
      log.error("failed to discover Claude Code plugins", { error: String(err) })
      return result
    }

    if (plugins.length === 0) {
      log.debug("no Claude Code plugins found")
      return result
    }

    log.info("found Claude Code plugins", { count: plugins.length, names: plugins.map((p) => p.name) })

    for (const plugin of plugins) {
      if (excludeSet.has(plugin.name)) {
        log.info("skipping excluded Claude plugin", { name: plugin.name })
        continue
      }

      try {
        // Load MCP servers
        const mcp = await ClaudePluginMcp.load(plugin)
        Object.assign(result.mcp, mcp)

        // Load skills as commands
        const commands = await ClaudePluginSkills.load(plugin)
        Object.assign(result.commands, commands)

        // Load hooks
        const hooks = await ClaudePluginHooks.load(plugin)
        if (hooks) result.hooks.push(hooks)

        result.pluginNames.push(plugin.name)
      } catch (err) {
        log.error("failed to load Claude plugin", { name: plugin.name, error: String(err) })
      }
    }

    log.info("loaded Claude Code plugins", {
      plugins: result.pluginNames,
      mcpServers: Object.keys(result.mcp).length,
      commands: Object.keys(result.commands).length,
      hooks: result.hooks.length,
    })

    return result
  }
}
