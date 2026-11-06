/**
 * Sparse manager state: per-source and per-skill enablement, categories, and
 * notes.
 *
 * Defaults are never written, so the file stays minimal and an absent entry
 * reads as "enabled, no note, no category". Writes use a temporary file plus
 * rename so a crash cannot leave a half-written state file.
 *
 * @module dsh-skills-manager/state
 */
import type { WarnLogger } from './library.js';
/** Persisted state of one source. */
export interface SourceState {
    readonly enabled?: boolean;
    readonly category?: string;
    readonly note?: string;
}
/** Persisted state of one skill, keyed by `source/skillName`. */
export interface SkillState {
    readonly enabled?: boolean;
    readonly note?: string;
}
/** On-disk state document. */
export interface StateFile {
    readonly version: 1;
    readonly sources: Record<string, SourceState>;
    readonly skills: Record<string, SkillState>;
}
/** Patch accepted by {@link StateStore.patchSource}. */
export interface SourceStatePatch {
    readonly enabled?: boolean;
    readonly category?: string;
    readonly note?: string;
}
/** Patch accepted by {@link StateStore.patchSkill}. */
export interface SkillStatePatch {
    readonly enabled?: boolean;
    readonly note?: string;
}
/**
 * Compose the state key of one skill.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the key used in `state.skills`.
 */
export declare function skillStateKey(source: string, skillName: string): string;
/** Read-modify-write store for the manager state file. */
export declare class StateStore {
    readonly path: string;
    private readonly logger;
    /**
     * @param path - absolute state file path.
     * @param logger - receives warnings for an unreadable state file.
     */
    constructor(path: string, logger: WarnLogger);
    /**
     * Read the current state, tolerating a missing or malformed file.
     * @returns the parsed state document.
     */
    read(): StateFile;
    /**
     * Apply a patch to one source and persist the result.
     * @param slug - source slug.
     * @param patch - fields to set; an empty note or category clears it.
     * @returns the persisted state.
     */
    patchSource(slug: string, patch: SourceStatePatch): StateFile;
    /**
     * Apply a patch to one skill and persist the result.
     * @param source - source slug.
     * @param skillName - skill directory name.
     * @param patch - fields to set; an empty note clears it.
     * @returns the persisted state.
     */
    patchSkill(source: string, skillName: string, patch: SkillStatePatch): StateFile;
    /**
     * Drop every state entry of one removed source.
     * @param slug - source slug.
     * @returns the persisted state.
     */
    dropSource(slug: string): StateFile;
    private write;
}
/**
 * Whether a source is enabled; an absent entry defaults to enabled.
 * @param state - current state document.
 * @param slug - source slug.
 * @returns the resolved flag.
 */
export declare function isSourceEnabled(state: StateFile, slug: string): boolean;
/**
 * Whether a skill is enabled; an absent entry defaults to enabled.
 * @param state - current state document.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the resolved flag.
 */
export declare function isSkillEnabled(state: StateFile, source: string, skillName: string): boolean;
/**
 * Whether a skill is enabled considering its source.
 * @param state - current state document.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the resolved flag.
 */
export declare function isSkillVisible(state: StateFile, source: string, skillName: string): boolean;
