/**
 * Import of globally installed skills into the managed library.
 *
 * Importing copies the skill into an `imported-<origin>` source and records its
 * provenance. The library stays the single source of truth: the original
 * directory is never linked to, so another tool cannot change or delete a
 * managed copy behind the manager's back.
 *
 * Conflicts are decided by catalog name plus the sha256 of SKILL.md: the same
 * name with the same content is skipped, the same name with different content is
 * refused unless the conflicting copy is itself an earlier import and the caller
 * explicitly asks to overwrite it.
 *
 * @module dsh-skills-manager/imports
 */
import type { WarnLogger } from './library.js';
import type { ImportRequest, ImportResponse } from './shared/api.js';
/** One provenance row, keyed by `source/skillName`. */
export interface ImportRecord {
    /** Original SKILL.md path. */
    readonly originPath: string;
    /** Registry key of the origin root. */
    readonly originKey: string;
    /** Hash at import time. */
    readonly contentHash: string;
    /** ISO timestamp. */
    readonly importedAt: string;
}
/** Provenance storage, written atomically next to the other state files. */
export declare class ImportStore {
    readonly path: string;
    private readonly logger;
    /**
     * @param path - absolute JSON file path.
     * @param logger - receives warnings for an unreadable file.
     */
    constructor(path: string, logger: WarnLogger);
    /**
     * Read every recorded import.
     * @returns provenance keyed by `source/skillName`.
     */
    read(): Record<string, ImportRecord>;
    /**
     * Keys already owned by an import.
     * @returns the provenance keys.
     */
    keys(): Set<string>;
    /**
     * Whether a source holds at least one imported skill.
     * @param source - source slug.
     * @returns true when the source was created by an import.
     */
    ownsSource(source: string): boolean;
    /**
     * Record one import.
     * @param source - imported source slug.
     * @param skillName - skill directory name.
     * @param record - provenance row.
     */
    set(source: string, skillName: string, record: ImportRecord): void;
    /**
     * Drop the provenance of a removed source.
     * @param source - source slug.
     */
    dropSource(source: string): void;
    private write;
}
/** Inputs for {@link importSkills}. */
export interface ImportOptions {
    /** Absolute library root. */
    readonly libraryDir: string;
    /** Provenance store. */
    readonly store: ImportStore;
    /** Configured extra scan roots. */
    readonly extraRoots: readonly string[];
    /** Receives warnings. */
    readonly logger: WarnLogger;
}
/**
 * Copy the selected skills into `imported-<origin>` sources.
 * @param options - library, store, roots, and logger.
 * @param request - requested paths and the overwrite flag.
 * @returns one outcome per requested path.
 * @throws {SkillManagerError} when the request is empty or malformed.
 */
export declare function importSkills(options: ImportOptions, request: ImportRequest): ImportResponse;
