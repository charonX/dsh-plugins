/**
 * Discovery of skills already installed globally by this or other agents.
 *
 * The scanner only reads: importing is an explicit copy into the library, so an
 * external tool can never change a managed skill behind the manager's back.
 *
 * @module dsh-skills-manager/scan
 */
import { type WarnLogger } from './library.js';
import type { ScanRootView, ScanSkillView } from './shared/api.js';
/** One built-in global root, keyed by the agent it belongs to. */
interface ScanRoot {
    readonly key: string;
    readonly label: string;
    readonly path: string;
    /** Skip this child name (DSH keeps packaged skills under `.system`). */
    readonly skip?: string;
}
/** Skill currently managed by this library, used for conflict decisions. */
export interface LibrarySkillRef {
    readonly source: string;
    readonly skillName: string;
    readonly name: string;
    readonly dir: string;
    readonly hash: string;
    readonly imported: boolean;
}
/** Full scan observation. */
export interface ScanResult {
    readonly roots: readonly ScanRootView[];
    readonly skills: readonly ScanSkillView[];
}
/** Options for {@link scanGlobalSkills}. */
export interface ScanOptions {
    /** Extra roots configured on the plugin, appended after the built-in ones. */
    readonly extraRoots: readonly string[];
    /** Absolute library root, used to classify each candidate. */
    readonly libraryDir: string;
    /** Provenance keys (`source/skillName`) owned by the import store. */
    readonly importedKeys: ReadonlySet<string>;
    /** Receives warnings for unreadable entries. */
    readonly logger: WarnLogger;
}
/**
 * Build the built-in global roots: DSH's own user directory plus the common
 * agent homes, following each tool's environment override when set.
 * @param env - environment used to resolve overrides.
 * @returns one root per known agent, in display order.
 */
export declare function defaultScanRoots(env?: NodeJS.ProcessEnv): ScanRoot[];
/**
 * Scan global roots and classify candidates against the current library.
 * @param options - roots, library, provenance, and logger.
 * @returns roots with existence and one row per discovered skill.
 */
export declare function scanGlobalSkills(options: ScanOptions): ScanResult;
/**
 * Hash one SKILL.md body; the unit of conflict detection.
 * @param text - file contents.
 * @returns lowercase sha256 hex.
 */
export declare function hashSkillText(text: string): string;
export declare function buildLibraryIndex(options: ScanOptions): {
    byName: Map<string, LibrarySkillRef>;
};
/**
 * Whether a candidate path lives inside one of the configured scan roots.
 * @param path - absolute candidate path.
 * @param extraRoots - configured extra roots.
 * @returns the matching root, or undefined when the path is outside every root.
 */
export declare function rootForPath(path: string, extraRoots: readonly string[]): ScanRoot | undefined;
export {};
