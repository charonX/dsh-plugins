/**
 * Install, update, and remove library sources.
 *
 * Every child process is started with an argument array — never a shell — and
 * git identifiers are restricted to transports that cannot execute commands.
 *
 * @module dsh-skills-manager/installer
 */
import type { JobRecord } from './jobs.js';
/** Inputs an install or update run needs. */
export interface InstallerOptions {
    /** Absolute library root. */
    readonly libraryDir: string;
    /** Whether a `file://` git identifier is accepted. */
    readonly allowFileProtocol: boolean;
}
/** Normalized git target details. */
export interface GitSourceTarget {
    /** The validated git transport or URL to clone from. */
    readonly url: string;
    /** Optional branch, tag, or commit ref. */
    readonly ref?: string;
}
/**
 * Strips command runners like `npx skill add`, `npx skills add`, `bunx skills add`,
 * as well as common CLI flags so that pasting a terminal command works cleanly.
 *
 * @param input - raw user input string.
 * @returns sanitized input string.
 */
export declare function cleanSkillCommandInput(input: string): string;
/**
 * Normalize an identifier (which may be a GitHub shorthand like `citrolabs/ego-lite`,
 * a GitHub browser URL with branch/tree, or a raw git transport) into a cloneable target.
 *
 * @param input - user-supplied clone source, command, or shorthand.
 * @returns normalized target with cloneable url and optional ref.
 */
export declare function normalizeGitSource(input: string): GitSourceTarget;
/**
 * Validate a git identifier or shorthand, resolving it to a cloneable target.
 *
 * @param identifier - user-supplied clone source, command, or shorthand.
 * @param allowFile - whether `file://` identifiers are allowed.
 * @returns the validated and normalized target.
 * @throws {SkillManagerError} when the source or ref is invalid or forbidden.
 */
export declare function resolveGitSource(identifier: string, allowFile: boolean): GitSourceTarget;
/**
 * Validate a git identifier before any command runs.
 * @param identifier - user-supplied clone source, command, or shorthand.
 * @param allowFile - whether `file://` identifiers are allowed.
 * @returns the resolved, cloneable git URL.
 * @throws {SkillManagerError} when the transport is not on the allow list.
 */
export declare function assertGitIdentifier(identifier: string, allowFile: boolean): string;
/**
 * Ensure a `git` executable is available.
 * @throws {SkillManagerError} with `GIT_UNAVAILABLE` when git cannot be started.
 */
export declare function ensureGitAvailable(): Promise<void>;
/**
 * Derive a stable directory name from a git identifier (`owner-repo`).
 * @param identifier - validated git identifier, shorthand, or target object.
 * @returns the sanitized slug.
 */
export declare function deriveGitSlug(identifier: string | GitSourceTarget): string;
/**
 * Pick a free slug by appending a numeric suffix.
 * @param libraryDir - absolute library root.
 * @param base - desired slug.
 * @returns a slug whose directory does not exist yet.
 */
export declare function resolveFreeSlug(libraryDir: string, base: string): string;
/**
 * Clone a git source into the library and validate its contents.
 * @param job - job receiving live command output.
 * @param options - library and protocol configuration.
 * @param identifier - validated git identifier, shorthand, or target.
 * @returns the created source slug.
 * @throws {SkillManagerError} when git fails or the clone holds no skill.
 */
export declare function installGitSource(job: JobRecord, options: InstallerOptions, identifier: string | GitSourceTarget): Promise<string>;
/**
 * Copy a local directory into the library and validate its contents.
 * @param job - job receiving progress output.
 * @param options - library configuration.
 * @param identifier - absolute or `~`-prefixed source directory.
 * @param force - replace an existing source with the same slug.
 * @returns the created source slug.
 * @throws {SkillManagerError} when the directory is unusable, overlaps the library, or conflicts.
 */
export declare function installLocalSource(job: JobRecord, options: InstallerOptions, identifier: string, force: boolean): Promise<string>;
/**
 * Update a git source in place with `git pull --ff-only`.
 * @param job - job receiving live command output.
 * @param options - library configuration.
 * @param sourceDir - absolute source directory.
 * @throws {SkillManagerError} when the source is not a git clone, its remote is
 *   not an allowed transport, or the pull fails.
 */
export declare function updateGitSource(job: JobRecord, options: InstallerOptions, sourceDir: string): Promise<void>;
/**
 * Delete one source directory.
 * @param sourceDir - absolute source directory inside the library.
 */
export declare function removeSourceDirectory(sourceDir: string): void;
