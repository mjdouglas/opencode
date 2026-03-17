import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import type { Hooks } from "@opencode-ai/plugin"
import type { ClaudePluginDiscovery } from "./discovery"

export namespace ClaudePluginHooks {
  const log = Log.create({ service: "claude-plugins.hooks" })

  interface ClaudeHookHandler {
    type: "command" | "prompt" | "agent"
    command?: string
    prompt?: string
    timeout?: number
  }

  interface ClaudeHookEntry {
    matcher?: string
    hooks: ClaudeHookHandler[]
  }

  interface ClaudeHooksConfig {
    PreToolUse?: ClaudeHookEntry[]
    PostToolUse?: ClaudeHookEntry[]
    UserPromptSubmit?: ClaudeHookEntry[]
    SessionStart?: ClaudeHookEntry[]
    Stop?: ClaudeHookEntry[]
    [key: string]: ClaudeHookEntry[] | undefined
  }

  /**
   * Execute a shell command hook handler.
   */
  async function executeCommand(command: string, cwd: string, timeout?: number): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    const timeoutMs = timeout ?? 30000
    const timer = setTimeout(() => proc.kill(), timeoutMs)

    try {
      const output = await new Response(proc.stdout).text()
      await proc.exited
      return output.trim()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Load hooks from a Claude Code plugin and convert to OpenCode Hooks format.
   * Only command-type hooks are supported (prompt/agent types are Claude-specific).
   */
  export async function load(plugin: ClaudePluginDiscovery.DiscoveredPlugin): Promise<Hooks | undefined> {
    const hooksPath = plugin.manifest.hooks
      ? path.resolve(plugin.path, plugin.manifest.hooks)
      : path.join(plugin.path, "hooks", "hooks.json")

    let raw: string
    try {
      raw = await fs.readFile(hooksPath, "utf-8")
    } catch {
      return undefined
    }

    let config: ClaudeHooksConfig
    try {
      config = JSON.parse(raw)
    } catch {
      log.error("failed to parse hooks config", { plugin: plugin.name, path: hooksPath })
      return undefined
    }

    const hooks: Hooks = {}
    const pluginDir = plugin.path

    // Map PreToolUse → tool.execute.before
    if (config.PreToolUse?.length) {
      const entries = config.PreToolUse
      hooks["tool.execute.before"] = async (input, output) => {
        for (const entry of entries) {
          // Check matcher against tool name
          if (entry.matcher && entry.matcher !== "*" && !input.tool.includes(entry.matcher)) continue
          for (const handler of entry.hooks) {
            if (handler.type !== "command" || !handler.command) continue
            try {
              await executeCommand(handler.command, pluginDir, handler.timeout)
            } catch (err) {
              log.error("PreToolUse hook failed", { plugin: plugin.name, error: String(err) })
            }
          }
        }
      }
    }

    // Map PostToolUse → tool.execute.after
    if (config.PostToolUse?.length) {
      const entries = config.PostToolUse
      hooks["tool.execute.after"] = async (input, output) => {
        for (const entry of entries) {
          if (entry.matcher && entry.matcher !== "*" && !input.tool.includes(entry.matcher)) continue
          for (const handler of entry.hooks) {
            if (handler.type !== "command" || !handler.command) continue
            try {
              await executeCommand(handler.command, pluginDir, handler.timeout)
            } catch (err) {
              log.error("PostToolUse hook failed", { plugin: plugin.name, error: String(err) })
            }
          }
        }
      }
    }

    if (Object.keys(hooks).length === 0) return undefined

    log.info("loaded hooks from Claude plugin", { plugin: plugin.name })
    return hooks
  }
}
