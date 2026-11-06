/**
 * Project skill-directory conventions, one row per agent.
 *
 * The snapshot below is derived from the agent registry in
 * `vercel-labs/skills` v1.5.20 (`src/agents.ts`, MIT), the same data source
 * the reference implementation pins, with one local addition: `dsh` itself,
 * whose project root is `<project>/.dsh/skills` (the `project-dsh` root of
 * `@deepseek-ai/dsh-skill-filesystem`). No runtime call reaches that library:
 * symlink creation and removal stay in this plugin, so an upstream release
 * cannot change behavior here, and re-syncing is a data-only diff.
 *
 * @module dsh-skills-manager/agent-registry
 */

/** One agent directory convention. */
export interface AgentTarget {
  /** Stable registry key, used in link requests and records. */
  readonly name: string
  /** Human-readable agent name. */
  readonly displayName: string
  /** Project-relative skills directory, POSIX separators. */
  readonly skillsDir: string
  /** Whether many agents share this directory convention. */
  readonly universal: boolean
}

/** Agent targeted when a link request names none. */
export const DEFAULT_AGENT_TARGET = 'dsh'

/** Registry rows, DSH first, then the pinned upstream order. */
export const AGENT_TARGETS: readonly AgentTarget[] = [
  { name: "dsh", displayName: "DeepSeek Harness", skillsDir: ".dsh/skills", universal: false },
  { name: "adal", displayName: "AdaL", skillsDir: ".adal/skills", universal: false },
  { name: "aider-desk", displayName: "AiderDesk", skillsDir: ".aider-desk/skills", universal: false },
  { name: "amp", displayName: "Amp", skillsDir: ".agents/skills", universal: true },
  { name: "antigravity", displayName: "Antigravity", skillsDir: ".agents/skills", universal: true },
  { name: "antigravity-cli", displayName: "Antigravity CLI", skillsDir: ".agents/skills", universal: true },
  { name: "astrbot", displayName: "AstrBot", skillsDir: "data/skills", universal: false },
  { name: "augment", displayName: "Augment", skillsDir: ".augment/skills", universal: false },
  { name: "autohand-code", displayName: "Autohand Code CLI", skillsDir: ".autohand/skills", universal: false },
  { name: "bob", displayName: "IBM Bob", skillsDir: ".bob/skills", universal: false },
  { name: "claude-code", displayName: "Claude Code", skillsDir: ".claude/skills", universal: false },
  { name: "cline", displayName: "Cline", skillsDir: ".agents/skills", universal: true },
  { name: "codearts-agent", displayName: "CodeArts Agent", skillsDir: ".codeartsdoer/skills", universal: false },
  { name: "codebuddy", displayName: "CodeBuddy", skillsDir: ".codebuddy/skills", universal: false },
  { name: "codemaker", displayName: "Codemaker", skillsDir: ".codemaker/skills", universal: false },
  { name: "codestudio", displayName: "Code Studio", skillsDir: ".codestudio/skills", universal: false },
  { name: "codex", displayName: "Codex", skillsDir: ".agents/skills", universal: true },
  { name: "command-code", displayName: "Command Code", skillsDir: ".commandcode/skills", universal: false },
  { name: "continue", displayName: "Continue", skillsDir: ".continue/skills", universal: false },
  { name: "cortex", displayName: "Cortex Code", skillsDir: ".cortex/skills", universal: false },
  { name: "crush", displayName: "Crush", skillsDir: ".crush/skills", universal: false },
  { name: "cursor", displayName: "Cursor", skillsDir: ".agents/skills", universal: true },
  { name: "deepagents", displayName: "Deep Agents", skillsDir: ".agents/skills", universal: true },
  { name: "devin", displayName: "Devin for Terminal", skillsDir: ".devin/skills", universal: false },
  { name: "dexto", displayName: "Dexto", skillsDir: ".agents/skills", universal: true },
  { name: "droid", displayName: "Droid", skillsDir: ".factory/skills", universal: false },
  { name: "eve", displayName: "Eve", skillsDir: "agent/skills", universal: false },
  { name: "firebender", displayName: "Firebender", skillsDir: ".agents/skills", universal: true },
  { name: "forgecode", displayName: "ForgeCode", skillsDir: ".forge/skills", universal: false },
  { name: "gemini-cli", displayName: "Gemini CLI", skillsDir: ".agents/skills", universal: true },
  { name: "github-copilot", displayName: "GitHub Copilot", skillsDir: ".agents/skills", universal: true },
  { name: "goose", displayName: "Goose", skillsDir: ".goose/skills", universal: false },
  { name: "grok", displayName: "Grok Build", skillsDir: ".grok/skills", universal: false },
  { name: "hermes-agent", displayName: "Hermes Agent", skillsDir: ".hermes/skills", universal: false },
  { name: "iflow-cli", displayName: "iFlow CLI", skillsDir: ".iflow/skills", universal: false },
  { name: "inference-sh", displayName: "inference.sh", skillsDir: ".inferencesh/skills", universal: false },
  { name: "jazz", displayName: "Jazz", skillsDir: ".jazz/skills", universal: false },
  { name: "junie", displayName: "Junie", skillsDir: ".junie/skills", universal: false },
  { name: "kilo", displayName: "Kilo Code", skillsDir: ".kilocode/skills", universal: false },
  { name: "kimchi", displayName: "Kimchi", skillsDir: ".kimchi/skills", universal: false },
  { name: "kimi-code-cli", displayName: "Kimi Code CLI", skillsDir: ".agents/skills", universal: true },
  { name: "kiro-cli", displayName: "Kiro CLI", skillsDir: ".kiro/skills", universal: false },
  { name: "kode", displayName: "Kode", skillsDir: ".kode/skills", universal: false },
  { name: "lingma", displayName: "Lingma", skillsDir: ".lingma/skills", universal: false },
  { name: "loaf", displayName: "Loaf", skillsDir: ".agents/skills", universal: true },
  { name: "mcpjam", displayName: "MCPJam", skillsDir: ".mcpjam/skills", universal: false },
  { name: "mistral-vibe", displayName: "Mistral Vibe", skillsDir: ".vibe/skills", universal: false },
  { name: "moxby", displayName: "Moxby", skillsDir: ".moxby/skills", universal: false },
  { name: "mux", displayName: "Mux", skillsDir: ".mux/skills", universal: false },
  { name: "neovate", displayName: "Neovate", skillsDir: ".neovate/skills", universal: false },
  { name: "ona", displayName: "Ona", skillsDir: ".ona/skills", universal: false },
  { name: "openclaw", displayName: "OpenClaw", skillsDir: "skills", universal: false },
  { name: "opencode", displayName: "OpenCode", skillsDir: ".agents/skills", universal: true },
  { name: "openhands", displayName: "OpenHands", skillsDir: ".openhands/skills", universal: false },
  { name: "pi", displayName: "Pi", skillsDir: ".pi/skills", universal: false },
  { name: "pochi", displayName: "Pochi", skillsDir: ".pochi/skills", universal: false },
  { name: "promptscript", displayName: "PromptScript", skillsDir: ".agents/skills", universal: true },
  { name: "qoder", displayName: "Qoder", skillsDir: ".qoder/skills", universal: false },
  { name: "qoder-cn", displayName: "Qoder CN", skillsDir: ".qoder/skills", universal: false },
  { name: "qwen-code", displayName: "Qwen Code", skillsDir: ".qwen/skills", universal: false },
  { name: "reasonix", displayName: "Reasonix", skillsDir: ".reasonix/skills", universal: false },
  { name: "replit", displayName: "Replit", skillsDir: ".agents/skills", universal: true },
  { name: "roo", displayName: "Roo Code", skillsDir: ".roo/skills", universal: false },
  { name: "rovodev", displayName: "Rovo Dev", skillsDir: ".rovodev/skills", universal: false },
  { name: "tabnine-cli", displayName: "Tabnine CLI", skillsDir: ".tabnine/agent/skills", universal: false },
  { name: "terramind", displayName: "Terramind", skillsDir: ".terramind/skills", universal: false },
  { name: "tinycloud", displayName: "Tinycloud", skillsDir: ".tinycloud/skills", universal: false },
  { name: "trae", displayName: "Trae", skillsDir: ".trae/skills", universal: false },
  { name: "trae-cn", displayName: "Trae CN", skillsDir: ".trae/skills", universal: false },
  { name: "universal", displayName: "Universal", skillsDir: ".agents/skills", universal: true },
  { name: "warp", displayName: "Warp", skillsDir: ".agents/skills", universal: true },
  { name: "windsurf", displayName: "Windsurf", skillsDir: ".windsurf/skills", universal: false },
  { name: "zcode", displayName: "ZCode", skillsDir: ".zcode/skills", universal: false },
  { name: "zed", displayName: "Zed", skillsDir: ".agents/skills", universal: true },
  { name: "zencoder", displayName: "Zencoder", skillsDir: ".zencoder/skills", universal: false },
  { name: "zenflow", displayName: "Zenflow", skillsDir: ".zencoder/skills", universal: false },
]

/**
 * Look up one registry row.
 * @param name - registry key.
 * @returns the row, or undefined for an unknown key.
 */
export function findAgentTarget(name: string): AgentTarget | undefined {
  return AGENT_TARGETS.find((agent) => agent.name === name)
}

