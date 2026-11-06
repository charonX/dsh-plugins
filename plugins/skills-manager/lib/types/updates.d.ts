/**
 * Git update checks for library sources.
 *
 * A check fetches the source's remote, compares the local HEAD with its
 * upstream, and records the result for the Web Client. Results are advisory:
 * updating stays an explicit `git pull --ff-only`.
 *
 * @module dsh-skills-manager/updates
 */
import { type WarnLogger } from './library.js';
/** Result of one update check. */
export interface UpdateCheck {
    /** ISO timestamp of this observation. */
    readonly checkedAt: string;
    /** Local HEAD commit. */
    readonly localCommit?: string;
    /** Upstream commit, when the source has one. */
    readonly remoteCommit?: string;
    /** Commits the local checkout is behind. */
    readonly behind?: number;
    /** Commits the local checkout is ahead of upstream. */
    readonly ahead?: number;
    /** Whether the working tree has uncommitted changes. */
    readonly dirty?: boolean;
    /** Version-ish label of the upstream commit (`git describe`). */
    readonly remoteVersion?: string;
    /** Failure recorded instead of throwing, so the UI can show it. */
    readonly error?: {
        readonly code: string;
        readonly message: string;
    };
}
/** Persistent last-check results, keyed by source slug. */
export declare class UpdateStore {
    readonly path: string;
    private readonly logger;
    /**
     * @param path - absolute JSON file path.
     * @param logger - receives warnings for an unreadable file.
     */
    constructor(path: string, logger: WarnLogger);
    /**
     * Read the recorded checks.
     * @returns checks keyed by source slug.
     */
    read(): Record<string, UpdateCheck>;
    /**
     * Record one check.
     * @param slug - source slug.
     * @param check - the observation.
     */
    set(slug: string, check: UpdateCheck): void;
    /**
     * Drop a removed source's check.
     * @param slug - source slug.
     */
    drop(slug: string): void;
    private write;
}
/** Inputs a check needs. */
export interface CheckOptions {
    /** Whether a `file://` remote is accepted. */
    readonly allowFileProtocol: boolean;
}
/**
 * Fetch a source and compare its local HEAD with its upstream.
 * @param sourceDir - absolute source directory inside the library.
 * @param options - protocol configuration.
 * @returns the observation; a git failure becomes `error` on the record.
 * @throws {SkillManagerError} when the source is not a git clone or its remote is not allowed.
 */
export declare function checkGitSource(sourceDir: string, options: CheckOptions): Promise<UpdateCheck>;
