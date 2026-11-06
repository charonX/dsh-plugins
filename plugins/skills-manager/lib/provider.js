/**
 * `ctx.skills` provider backed by the managed library.
 *
 * The provider reads the library on every observation: the registry caches a
 * completed catalog until the manager invalidates it, and external edits become
 * visible on the next invalidation or restart.
 *
 * @module dsh-skills-manager/provider
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMarkdown } from './frontmatter.js';
import { scanLibrary } from './library.js';
import { isSkillVisible } from './state.js';
/** Origin bucket reported for every skill this provider owns. */
export const MANAGED_SKILL_SOURCE = 'skills-manager';
/**
 * Provider that maps library sources into `ctx.skills`.
 */
export class LibrarySkillProvider {
    options;
    control;
    name;
    /**
     * @param options - resolved provider options.
     * @param control - registration-scoped invalidation capability.
     */
    constructor(options, control) {
        this.options = options;
        this.control = control;
        this.name = options.providerName;
    }
    /**
     * List enabled, valid skills from every source.
     * @param lookup - caller context; unused beyond cancellation.
     * @returns provider candidates.
     */
    async list(lookup) {
        lookup.signal?.throwIfAborted();
        const state = this.options.readState();
        const candidates = [];
        const owners = new Map();
        for (const source of scanLibrary(this.options.libraryDir, this.options.logger)) {
            lookup.signal?.throwIfAborted();
            collectCandidates(source, state, this, this.options, candidates, owners);
        }
        return candidates;
    }
    /**
     * Load one skill body by rereading its `SKILL.md`.
     * @param candidate - winning candidate returned by {@link list}.
     * @param lookup - caller context; unused beyond cancellation.
     * @returns the complete definition, or undefined when the skill is gone or invalid.
     */
    async get(candidate, lookup) {
        lookup.signal?.throwIfAborted();
        const locator = readLocator(candidate.locator);
        if (locator === undefined)
            return undefined;
        let text;
        try {
            text = readFileSync(join(locator.dir, 'SKILL.md'), 'utf8');
        }
        catch {
            return undefined;
        }
        const parsed = parseSkillMarkdown(text);
        if (parsed.problem !== undefined || parsed.name === undefined || parsed.description === undefined)
            return undefined;
        if (parsed.name !== candidate.name)
            return undefined;
        return {
            name: parsed.name,
            description: parsed.description,
            invocation: parsed.invocation,
            source: MANAGED_SKILL_SOURCE,
            provider: this.name,
            content: parsed.content,
            path: join(locator.dir, 'SKILL.md'),
            resourceBase: { kind: 'directory', path: locator.dir },
            ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        };
    }
    /**
     * Invalidate the registry's completed catalog for this provider.
     */
    invalidate() {
        this.control.invalidate();
    }
}
function collectCandidates(source, state, provider, options, candidates, owners) {
    for (const skill of source.skills) {
        if (!skill.valid || skill.name === undefined || skill.description === undefined)
            continue;
        if (!isSkillVisible(state, source.slug, skill.skillName))
            continue;
        const owner = owners.get(skill.name);
        if (owner !== undefined) {
            options.logger.warn(`skills-manager: ${source.slug}/${skill.skillName} ignored: skill name "${skill.name}" already provided by ${owner}`);
            continue;
        }
        owners.set(skill.name, `${source.slug}/${skill.skillName}`);
        const locator = { dir: skill.dir, name: skill.name };
        candidates.push({
            name: skill.name,
            description: skill.description,
            invocation: skill.invocation,
            source: MANAGED_SKILL_SOURCE,
            provider: provider.name,
            rank: options.rank,
            path: join(skill.dir, 'SKILL.md'),
            resourceBase: { kind: 'directory', path: skill.dir },
            locator,
            ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        });
    }
}
function readLocator(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    if (typeof record.dir !== 'string' || typeof record.name !== 'string')
        return undefined;
    return { dir: record.dir, name: record.name };
}
//# sourceMappingURL=provider.js.map