/**
 * SKILL.md frontmatter parsing with the harness's skill-name and invocation
 * rules.
 *
 * Parsing never throws: a malformed file yields a `problem` so the manager UI
 * can show it, while the skill provider skips it.
 *
 * @module dsh-skills-manager/frontmatter
 */
import type { SkillInvocationPolicy } from './shared/api.js';
/** Parsed result of one SKILL.md file. */
export interface ParsedSkillFile {
    /** Catalog name from frontmatter, absent when the file is invalid. */
    readonly name?: string;
    /** Routing description from frontmatter. */
    readonly description?: string;
    /** Optional extra routing guidance from frontmatter. */
    readonly whenToUse?: string;
    /** Resolved invocation controls; defaults permit both surfaces. */
    readonly invocation: SkillInvocationPolicy;
    /** Instruction body with the frontmatter block removed. */
    readonly content: string;
    /** Why the file cannot contribute a skill; absent when it is valid. */
    readonly problem?: string;
}
/**
 * Whether a name is a valid skill name.
 * @param name - candidate catalog name.
 * @returns whether the name matches the harness grammar.
 */
export declare function isSkillName(name: string): boolean;
/**
 * Parse one SKILL.md text.
 * @param text - raw file contents.
 * @returns the parsed skill, or the reason it cannot be used.
 */
export declare function parseSkillMarkdown(text: string): ParsedSkillFile;
