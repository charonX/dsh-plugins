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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const STATE_VERSION = 1;
/**
 * Compose the state key of one skill.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the key used in `state.skills`.
 */
export function skillStateKey(source, skillName) {
    return `${source}/${skillName}`;
}
/** Read-modify-write store for the manager state file. */
export class StateStore {
    path;
    logger;
    /**
     * @param path - absolute state file path.
     * @param logger - receives warnings for an unreadable state file.
     */
    constructor(path, logger) {
        this.path = path;
        this.logger = logger;
    }
    /**
     * Read the current state, tolerating a missing or malformed file.
     * @returns the parsed state document.
     */
    read() {
        let raw;
        try {
            raw = readFileSync(this.path, 'utf8');
        }
        catch {
            return emptyState();
        }
        try {
            return normalizeState(JSON.parse(raw));
        }
        catch (error) {
            this.logger.warn(`skills-manager: ignoring unreadable state file ${this.path}: ${errorMessage(error)}`);
            return emptyState();
        }
    }
    /**
     * Apply a patch to one source and persist the result.
     * @param slug - source slug.
     * @param patch - fields to set; an empty note or category clears it.
     * @returns the persisted state.
     */
    patchSource(slug, patch) {
        const state = this.read();
        const current = state.sources[slug] ?? {};
        const next = pruneSourceState({ ...current, ...patch });
        const sources = { ...state.sources };
        if (next === undefined)
            delete sources[slug];
        else
            sources[slug] = next;
        return this.write({ ...state, sources });
    }
    /**
     * Apply a patch to one skill and persist the result.
     * @param source - source slug.
     * @param skillName - skill directory name.
     * @param patch - fields to set; an empty note clears it.
     * @returns the persisted state.
     */
    patchSkill(source, skillName, patch) {
        const state = this.read();
        const key = skillStateKey(source, skillName);
        const current = state.skills[key] ?? {};
        const next = pruneSkillState({ ...current, ...patch });
        const skills = { ...state.skills };
        if (next === undefined)
            delete skills[key];
        else
            skills[key] = next;
        return this.write({ ...state, skills });
    }
    /**
     * Drop every state entry of one removed source.
     * @param slug - source slug.
     * @returns the persisted state.
     */
    dropSource(slug) {
        const state = this.read();
        const sources = { ...state.sources };
        delete sources[slug];
        const skills = {};
        for (const [key, value] of Object.entries(state.skills)) {
            if (!key.startsWith(`${slug}/`))
                skills[key] = value;
        }
        return this.write({ ...state, sources, skills });
    }
    write(state) {
        mkdirSync(dirname(this.path), { recursive: true });
        const temporary = join(dirname(this.path), `.${Date.now()}-${process.pid}.state.tmp`);
        try {
            writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
            renameSync(temporary, this.path);
        }
        catch (error) {
            rmSync(temporary, { force: true });
            throw error;
        }
        return state;
    }
}
/**
 * Whether a source is enabled; an absent entry defaults to enabled.
 * @param state - current state document.
 * @param slug - source slug.
 * @returns the resolved flag.
 */
export function isSourceEnabled(state, slug) {
    return state.sources[slug]?.enabled !== false;
}
/**
 * Whether a skill is enabled; an absent entry defaults to enabled.
 * @param state - current state document.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the resolved flag.
 */
export function isSkillEnabled(state, source, skillName) {
    return state.skills[skillStateKey(source, skillName)]?.enabled !== false;
}
/**
 * Whether a skill is enabled considering its source.
 * @param state - current state document.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the resolved flag.
 */
export function isSkillVisible(state, source, skillName) {
    return isSourceEnabled(state, source) && isSkillEnabled(state, source, skillName);
}
function emptyState() {
    return { version: STATE_VERSION, sources: {}, skills: {} };
}
function normalizeState(value) {
    if (typeof value !== 'object' || value === null)
        return emptyState();
    const record = value;
    return {
        version: STATE_VERSION,
        sources: normalizeRecord(record.sources, pruneSourceState),
        skills: normalizeRecord(record.skills, pruneSkillState),
    };
}
function normalizeRecord(value, prune) {
    if (typeof value !== 'object' || value === null)
        return {};
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const pruned = prune(entry);
        if (pruned !== undefined)
            result[key] = pruned;
    }
    return result;
}
function pruneSourceState(value) {
    const next = {};
    if (value.enabled === false)
        next.enabled = false;
    const category = text(value.category);
    if (category !== undefined)
        next.category = category;
    const note = text(value.note);
    if (note !== undefined)
        next.note = note;
    return Object.keys(next).length === 0 ? undefined : next;
}
function pruneSkillState(value) {
    const next = {};
    if (value.enabled === false)
        next.enabled = false;
    const note = text(value.note);
    if (note !== undefined)
        next.note = note;
    return Object.keys(next).length === 0 ? undefined : next;
}
function text(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=state.js.map