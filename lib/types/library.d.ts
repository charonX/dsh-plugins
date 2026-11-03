/**
 * Live scan of the managed skill library.
 *
 * Disk is the single source of truth: there is no index or install database.
 * A source is one direct child directory of the library, and it may hold a
 * root-level `SKILL.md`, `skills/<name>/SKILL.md`, or the nested
 * `skills/<category>/<name>/SKILL.md` layout carried over from the reference
 * implementation.
 *
 * @module dsh-skills-manager/library
 */
import type { SkillInvocationPolicy } from './shared/api.js';
/** Minimal logger surface the scan reports unreadable entries through. */
export interface WarnLogger {
    warn(message: string): void;
}
/** One skill directory discovered below a source. */
export interface DiscoveredSkillDir {
    /** Directory name: the stable identity inside the source. */
    readonly skillName: string;
    /** Absolute skill directory. */
    readonly dir: string;
    /** Path relative to the source directory. */
    readonly relativePath: string;
}
/** One scanned skill, before manager state is applied. */
export interface ScannedSkill extends DiscoveredSkillDir {
    readonly name?: string;
    readonly description?: string;
    readonly whenToUse?: string;
    readonly invocation: SkillInvocationPolicy;
    readonly valid: boolean;
    readonly problem?: string;
}
/** One scanned source, before manager state is applied. */
export interface ScannedSource {
    readonly slug: string;
    readonly dir: string;
    readonly sourceType: 'git' | 'local';
    readonly sourceUrl?: string;
    readonly version?: string;
    readonly problem?: string;
    readonly skills: readonly ScannedSkill[];
}
/**
 * Discover skill directories under one source using the three supported layouts.
 * @param sourceDir - absolute source directory.
 * @returns discovered skill directories, unsorted.
 */
export declare function discoverSkillDirs(sourceDir: string): DiscoveredSkillDir[];
/**
 * Scan every source inside the library.
 * @param libraryDir - absolute library root; a missing root scans as empty.
 * @param logger - receives warnings for unreadable directories.
 * @returns sources sorted by slug, with skills sorted by directory name.
 */
export declare function scanLibrary(libraryDir: string, logger: WarnLogger): ScannedSource[];
/**
 * Read the `origin` remote of a git source from `.git/config`, without running git.
 * @param sourceDir - absolute source directory.
 * @returns the remote URL, if the source is a git clone with an origin.
 */
export declare function readGitRemote(sourceDir: string): string | undefined;
/**
 * Resolve a display version: `package.json` version, else the git short hash.
 * @param sourceDir - absolute source directory.
 * @param git - whether the source carries a `.git` entry.
 * @returns the version string, or undefined when neither source answers.
 */
export declare function readSourceVersion(sourceDir: string, git: boolean): string | undefined;
