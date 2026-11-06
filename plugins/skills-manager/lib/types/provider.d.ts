/**
 * `ctx.skills` provider backed by the managed library.
 *
 * The provider reads the library on every observation: the registry caches a
 * completed catalog until the manager invalidates it, and external edits become
 * visible on the next invalidation or restart.
 *
 * @module dsh-skills-manager/provider
 */
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl, SkillSource } from '@deepseek-ai/dsh-skill';
import { type WarnLogger } from './library.js';
import { type StateFile } from './state.js';
/** Origin bucket reported for every skill this provider owns. */
export declare const MANAGED_SKILL_SOURCE: SkillSource;
/** Provider options resolved by the plugin. */
export interface ProviderOptions {
    /** Absolute library root. */
    readonly libraryDir: string;
    /** Provider name registered on `ctx.skills`. */
    readonly providerName: string;
    /** Precedence rank among providers; lower wins. */
    readonly rank: number;
    /** Reads the current manager state. */
    readonly readState: () => StateFile;
    /** Receives warnings for invalid or duplicate skills. */
    readonly logger: WarnLogger;
}
/**
 * Provider that maps library sources into `ctx.skills`.
 */
export declare class LibrarySkillProvider implements SkillProvider {
    private readonly options;
    private readonly control;
    readonly name: string;
    /**
     * @param options - resolved provider options.
     * @param control - registration-scoped invalidation capability.
     */
    constructor(options: ProviderOptions, control: SkillProviderControl);
    /**
     * List enabled, valid skills from every source.
     * @param lookup - caller context; unused beyond cancellation.
     * @returns provider candidates.
     */
    list(lookup: SkillLookupOptions): Promise<readonly SkillCandidate[]>;
    /**
     * Load one skill body by rereading its `SKILL.md`.
     * @param candidate - winning candidate returned by {@link list}.
     * @param lookup - caller context; unused beyond cancellation.
     * @returns the complete definition, or undefined when the skill is gone or invalid.
     */
    get(candidate: SkillCandidate, lookup: SkillLookupOptions): Promise<SkillDefinition | undefined>;
    /**
     * Invalidate the registry's completed catalog for this provider.
     */
    invalidate(): void;
}
