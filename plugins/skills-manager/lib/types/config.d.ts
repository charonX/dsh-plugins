/**
 * Plugin configuration schema.
 *
 * @module dsh-skills-manager/config
 */
import type Schema from '@deepseek-ai/schemastery';
/** Skill manager configuration accepted from `cordis.yml`. */
export interface Config {
    /** Managed library root; defaults to `<dshHome>/skills-manager/library`. */
    libraryDir?: string;
    /** Manager state file; defaults to `<dshHome>/skills-manager/manager-state.json`. */
    statePath?: string;
    /** Per-project link record; defaults to `<dshHome>/skills-manager/links.json`. */
    linksPath?: string;
    /** Last update-check record; defaults to `<dshHome>/skills-manager/updates.json`. */
    updatesPath?: string;
    /** Import provenance record; defaults to `<dshHome>/skills-manager/imports.json`. */
    importsPath?: string;
    /** Provider name registered on `ctx.skills`; defaults to `skills-manager`. */
    providerName?: string;
    /** Provider precedence rank; lower wins against other providers. */
    rank?: number;
    /** HTTP prefix the routes and the Web Client payload use. */
    routePrefix?: string;
    /** Whether `file://` git identifiers are accepted for local repositories. */
    allowFileProtocol?: boolean;
    /** Extra global skill roots offered by the import scanner, on top of the built-in agent roots. */
    scanSkillDirs?: string[];
}
/** Validated configuration schema. */
export declare const Config: Schema<Config>;
