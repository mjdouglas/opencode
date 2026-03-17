import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Glob } from "../util/glob"
import type { ClaudePluginDiscovery } from "./discovery"
import type { Config } from "../config/config"

export namespace ClaudePluginSkills {
  const log = Log.create({ service: "claude-plugins.skills" })

  interface SkillFrontmatter {
    description?: string
    [key: string]: unknown
  }

  /**
   * Parse a SKILL.md file, extracting YAML frontmatter and body content.
   * Frontmatter is delimited by --- lines at the top of the file.
   */
  function parseSkillMd(content: string): { frontmatter: SkillFrontmatter; body: string } {
    const lines = content.split("\n")
    if (lines[0]?.trim() !== "---") {
      return { frontmatter: {}, body: content.trim() }
    }

    const endIndex = lines.indexOf("---", 1)
    if (endIndex === -1) {
      return { frontmatter: {}, body: content.trim() }
    }

    // Simple YAML key: value parsing for frontmatter
    const frontmatter: SkillFrontmatter = {}
    for (let i = 1; i < endIndex; i++) {
      const line = lines[i]
      const colonIdx = line.indexOf(":")
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      if (key && value) {
        frontmatter[key] = value
      }
    }

    const body = lines.slice(endIndex + 1).join("\n").trim()
    return { frontmatter, body }
  }

  /**
   * Load skills from a Claude Code plugin and convert them to OpenCode commands.
   */
  export async function load(plugin: ClaudePluginDiscovery.DiscoveredPlugin): Promise<Record<string, Config.Command>> {
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

    const result: Record<string, Config.Command> = {}

    for (const match of matches) {
      try {
        const content = await fs.readFile(match, "utf-8")
        const { frontmatter, body } = parseSkillMd(content)

        // Derive skill name from directory name
        const skillName = path.basename(path.dirname(match))
        const commandName = `claude:${plugin.name}:${skillName}`

        result[commandName] = {
          template: body,
          description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
        }

        log.info("loaded skill from Claude plugin", { plugin: plugin.name, skill: skillName })
      } catch (err) {
        log.error("failed to load skill", { plugin: plugin.name, path: match, error: String(err) })
      }
    }

    return result
  }
}
