# Plan: Add Claude Code Plugin Support to OpenCode

## Goal
Allow OpenCode to discover and load Claude Code plugins installed on the user's laptop, making their capabilities (tools via MCP servers, hooks, skills/commands) available within OpenCode sessions.

## Background

### Claude Code Plugin Structure
Claude Code plugins are directories with this layout:
```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Manifest: { name, version, description, ... }
├── skills/                   # Markdown skill files (SKILL.md)
├── agents/                   # Agent definition markdown files
├── hooks/
│   └── hooks.json            # Event handler definitions
├── .mcp.json                 # MCP server configurations
├── .lsp.json                 # Language server configs
└── settings.json             # Default plugin settings
```

Plugins are installed at:
- **User scope**: `~/.claude/settings.json` → `enabledPlugins` array, cached in `~/.claude/plugins/cache/`
- **Project scope**: `.claude/settings.json` → `enabledPlugins` array

### OpenCode's Existing Plugin System
OpenCode has its own plugin system (`packages/opencode/src/plugin/index.ts`) that:
- Loads npm packages and local `file://` plugins
- Expects plugins to be TypeScript/JS modules exporting `(input: PluginInput) => Promise<Hooks>`
- Supports hooks for auth, tools, events, config, chat params, permissions, etc.
- Custom tools loaded from `.opencode/tool/*.ts`
- Custom agents loaded from `.opencode/agent/*.md`
- Custom commands loaded from `.opencode/command/*.md`

## Implementation Plan

### Step 1: Add Claude Code Plugin Discovery (`packages/opencode/src/claude-plugins/discovery.ts`)

Create a new module to discover Claude Code plugins on the system:

1. **Read `~/.claude/settings.json`** to find `enabledPlugins` list
2. **Read `.claude/settings.json`** in the project directory for project-scoped plugins
3. **Scan `~/.claude/plugins/cache/`** for cached plugin directories
4. **For each enabled plugin**, locate its directory and parse `.claude-plugin/plugin.json` manifest
5. Return a list of discovered `ClaudePlugin` objects with their paths and parsed manifests

```typescript
export namespace ClaudePluginDiscovery {
  export interface ClaudePluginManifest {
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
    manifest: ClaudePluginManifest
  }

  export async function discover(projectDir: string): Promise<DiscoveredPlugin[]>
}
```

### Step 2: Load MCP Servers from Claude Plugins (`packages/opencode/src/claude-plugins/mcp.ts`)

Claude Code plugins primarily extend functionality via MCP servers defined in `.mcp.json`. OpenCode already has MCP support (`packages/opencode/src/mcp/`).

1. For each discovered Claude plugin, read its `.mcp.json` file
2. Resolve `${CLAUDE_PLUGIN_ROOT}` environment variable references to the plugin's directory
3. Convert the MCP server configs into OpenCode's MCP config format
4. Register these MCP servers with OpenCode's existing MCP infrastructure

### Step 3: Load Skills/Commands as OpenCode Commands (`packages/opencode/src/claude-plugins/skills.ts`)

Claude Code skills are markdown files in `skills/*/SKILL.md` with YAML frontmatter. These map naturally to OpenCode's command system.

1. For each discovered plugin, scan `skills/` directory for `SKILL.md` files
2. Parse the YAML frontmatter (description, arguments) and markdown body
3. Register them as OpenCode commands namespaced as `claude-plugin-name:skill-name`
4. The skill markdown content becomes the command prompt template

### Step 4: Load Hooks (`packages/opencode/src/claude-plugins/hooks.ts`)

Claude Code hooks (`hooks/hooks.json`) define shell commands triggered on events like `PreToolUse`, `PostToolUse`, etc. Map these to OpenCode's hook system where possible.

1. Parse `hooks/hooks.json` from each plugin
2. Map Claude Code hook events to OpenCode plugin hook equivalents:
   - `PreToolUse` → `tool.execute.before`
   - `PostToolUse` → `tool.execute.after`
   - `UserPromptSubmit` → `chat.message`
   - `SessionStart` → `event` (filter for session start events)
3. For `command` type handlers, execute shell commands via `Bun.$`
4. Register the mapped hooks through OpenCode's plugin system

### Step 5: Integrate into Config/Plugin Loading (`packages/opencode/src/plugin/index.ts`)

Wire the Claude plugin discovery into OpenCode's startup:

1. Add a config option `claudePlugins` (boolean, default `true`) to enable/disable Claude Code plugin loading
2. In `Plugin.state()`, after loading OpenCode's own plugins, call `ClaudePluginDiscovery.discover()`
3. For each discovered plugin:
   - Load its MCP servers into OpenCode's MCP config
   - Load its skills as commands
   - Load and map its hooks
4. Log which Claude Code plugins were discovered and loaded

### Step 6: Add Configuration Options (`packages/opencode/src/config/config.ts`)

Add config schema entries:

```typescript
claudePlugins: z.object({
  enabled: z.boolean().optional().default(true),
  // Allow users to exclude specific Claude plugins by name
  exclude: z.string().array().optional(),
}).optional()
```

This allows users to:
- Disable Claude plugin loading entirely: `{ "claudePlugins": { "enabled": false } }`
- Exclude specific plugins: `{ "claudePlugins": { "exclude": ["noisy-plugin"] } }`

## File Changes Summary

| File | Change |
|------|--------|
| `packages/opencode/src/claude-plugins/discovery.ts` | **New** - Plugin discovery logic |
| `packages/opencode/src/claude-plugins/mcp.ts` | **New** - MCP server loading from Claude plugins |
| `packages/opencode/src/claude-plugins/skills.ts` | **New** - Skill/command loading |
| `packages/opencode/src/claude-plugins/hooks.ts` | **New** - Hook mapping and loading |
| `packages/opencode/src/claude-plugins/index.ts` | **New** - Main entry point, orchestrates loading |
| `packages/opencode/src/plugin/index.ts` | **Modified** - Call Claude plugin loader during init |
| `packages/opencode/src/config/config.ts` | **Modified** - Add `claudePlugins` config schema |

## Key Design Decisions

1. **MCP-first approach**: Claude plugins' primary extension mechanism is MCP servers, which OpenCode already supports natively. This is the highest-value integration point.

2. **Namespace isolation**: All Claude plugin components are namespaced (e.g., `claude:plugin-name:skill-name`) to avoid conflicts with native OpenCode plugins.

3. **Opt-out, not opt-in**: Enabled by default since the user asked for automatic pickup. The `claudePlugins.exclude` config provides granular control.

4. **Read-only consumption**: OpenCode reads Claude Code plugin artifacts but doesn't modify them. The Claude Code installation remains the source of truth.

5. **Graceful degradation**: If `~/.claude/` doesn't exist or a plugin can't be loaded, log a warning and continue. No hard failures.

## What Won't Be Supported (Initially)

- **Plugin marketplace browsing/installation** from within OpenCode (use Claude Code's CLI for that)
- **LSP servers** from Claude plugins (OpenCode has its own LSP support that would need deeper integration)
- **Output styles** (Claude Code-specific rendering concept)
- **Agent definitions** with Claude Code-specific agent features (partial support via command mapping)
