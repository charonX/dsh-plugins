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
    readonly name: string;
    /** Human-readable agent name. */
    readonly displayName: string;
    /** Project-relative skills directory, POSIX separators. */
    readonly skillsDir: string;
    /** Whether many agents share this directory convention. */
    readonly universal: boolean;
}
/** Agent targeted when a link request names none. */
export declare const DEFAULT_AGENT_TARGET = "dsh";
/** Registry rows, DSH first, then the pinned upstream order. */
export declare const AGENT_TARGETS: readonly AgentTarget[];
/**
 * Look up one registry row.
 * @param name - registry key.
 * @returns the row, or undefined for an unknown key.
 */
export declare function findAgentTarget(name: string): AgentTarget | undefined;
