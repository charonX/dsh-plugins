/**
 * Apply manager state to a library scan, producing the observation the Web
 * Client renders.
 *
 * @module dsh-skills-manager/view
 */
import { isSkillEnabled, isSourceEnabled } from './state.js';
/**
 * Compose the library snapshot.
 * @param libraryDir - absolute library root.
 * @param statePath - absolute state file path.
 * @param sources - scanned sources.
 * @param state - current manager state.
 * @returns the snapshot served by `GET /api/library`.
 */
export function buildSnapshot(libraryDir, statePath, sources, state, updates = {}) {
    return {
        libraryDir,
        statePath,
        sources: sources.map((source) => toSourceView(source, state, updates[source.slug])),
    };
}
function toSourceView(source, state, update) {
    const sourceState = state.sources[source.slug];
    return {
        slug: source.slug,
        sourceType: source.sourceType,
        enabled: isSourceEnabled(state, source.slug),
        skills: source.skills.map((skill) => ({
            skillName: skill.skillName,
            invocation: skill.invocation,
            relativePath: skill.relativePath,
            valid: skill.valid,
            enabled: isSkillEnabled(state, source.slug, skill.skillName),
            ...(skill.name === undefined ? {} : { name: skill.name }),
            ...(skill.description === undefined ? {} : { description: skill.description }),
            ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
            ...(skill.problem === undefined ? {} : { problem: skill.problem }),
            ...(state.skills[`${source.slug}/${skill.skillName}`]?.note === undefined
                ? {}
                : { note: state.skills[`${source.slug}/${skill.skillName}`]?.note }),
        })),
        ...(source.sourceUrl === undefined ? {} : { sourceUrl: source.sourceUrl }),
        ...(source.version === undefined ? {} : { version: source.version }),
        ...(source.problem === undefined ? {} : { problem: source.problem }),
        ...(update === undefined ? {} : { update }),
        ...(sourceState?.category === undefined ? {} : { category: sourceState.category }),
        ...(sourceState?.note === undefined ? {} : { note: sourceState.note }),
    };
}
//# sourceMappingURL=view.js.map