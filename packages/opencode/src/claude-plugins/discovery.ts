import path from "path"
import os from "os"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Instance } from "../project/instance"

export namespace ClaudePluginDiscovery {
  const log = Log.create({ service: "claude-plugins.discovery" })

  export interface Manifest {
    name: string
    version?: string
    description?: string
    skills?: string
    agents?: string
    commands?: string
    hooks?: string
    mcpServers?: string
    lspServers?: string
  }

  export interface DiscoveredPlugin {
    name: string
    path: string
    manifest: Manifest
  }

  interface ClaudeSettings {
    enabledPlugins?: string[]
  }

  function claudeDir(): string {
    return path.join(os.homedir(), ".claude")
  }

  async function readJsonSafe<T>(filepath: string): Promise<T | undefined> {
    try {
      const content = await fs.readFile(filepath, "utf-8")
      return JSON.parse(content) as T
    } catch {
      return undefined
    }
  }

  /**
   * Resolve a plugin name to its directory on disk.
   * Plugins are cached in ~/.claude/plugins/cache/<name>/
   */
  async function resolvePluginPath(name: string): Promise<string | undefined> {
    // Check cache directory first
    const cachePath = path.join(claudeDir(), "plugins", "cache", name)
    try {
      const stat = await fs.stat(cachePath)
      if (stat.isDirectory()) return cachePath
    } catch {}

    // Also check if the name is an absolute path (for --plugin-dir style entries)
    if (path.isAbsolute(name)) {
      try {
        const stat = await fs.stat(name)
        if (stat.isDirectory()) return name
      } catch {}
    }

    return undefined
  }

  async function loadManifest(pluginDir: string): Promise<Manifest | undefined> {
    const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json")
    const manifest = await readJsonSafe<Manifest>(manifestPath)
    if (!manifest?.name) {
      log.debug("no valid manifest found", { path: manifestPath })
      return undefined
    }
    return manifest
  }

  /**
   * Discover all enabled Claude Code plugins from user and project settings.
   */
  export async function discover(): Promise<DiscoveredPlugin[]> {
    const plugins: DiscoveredPlugin[] = []
    const seen = new Set<string>()

    // Collect enabled plugin names from user-level settings
    const userSettings = await readJsonSafe<ClaudeSettings>(path.join(claudeDir(), "settings.json"))
    const enabledNames = new Set<string>(userSettings?.enabledPlugins ?? [])

    // Also check project-level .claude/settings.json
    const projectClaudeDir = path.join(Instance.directory, ".claude")
    const projectSettings = await readJsonSafe<ClaudeSettings>(path.join(projectClaudeDir, "settings.json"))
    if (projectSettings?.enabledPlugins) {
      for (const name of projectSettings.enabledPlugins) {
        enabledNames.add(name)
      }
    }

    // Also scan cache directory for any installed plugins (in case settings is out of sync)
    const cacheDir = path.join(claudeDir(), "plugins", "cache")
    try {
      const entries = await fs.readdir(cacheDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          enabledNames.add(entry.name)
        }
      }
    } catch {
      // Cache directory may not exist
    }

    for (const name of enabledNames) {
      if (seen.has(name)) continue
      seen.add(name)

      const pluginPath = await resolvePluginPath(name)
      if (!pluginPath) {
        log.debug("could not resolve plugin path", { name })
        continue
      }

      const manifest = await loadManifest(pluginPath)
      if (!manifest) {
        log.debug("skipping plugin without valid manifest", { name, path: pluginPath })
        continue
      }

      plugins.push({
        name: manifest.name,
        path: pluginPath,
        manifest,
      })
      log.info("discovered Claude Code plugin", { name: manifest.name, path: pluginPath })
    }

    return plugins
  }
}
