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
/**
 * Validate a git identifier before any command runs.
 * @param identifier - user-supplied clone source.
 * @param allowFile - whether `file://` identifiers are allowed.
 * @returns the trimmed identifier.
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
 * @param identifier - validated git identifier.
 * @returns the sanitized slug.
 */
export declare function deriveGitSlug(identifier: string): string;
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
 * @param identifier - validated git identifier.
 * @returns the created source slug.
 * @throws {SkillManagerError} when git fails or the clone holds no skill.
 */
export declare function installGitSource(job: JobRecord, options: InstallerOptions, identifier: string): Promise<string>;
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
