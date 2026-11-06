/**
 * Project distribution: symlinks from a project's agent skills directories
 * straight into the managed library.
 *
 * Disk is the truth for what a project sees. A small record file remembers the
 * *intent* per project — which skills were asked for and which agents were
 * targeted — because a deleted link leaves no trace to repair from.
 *
 * Only symlinks this manager can attribute to the library are ever removed.
 * A real directory, a file, or a symlink pointing elsewhere is reported as a
 * conflict and left untouched.
 *
 * @module dsh-skills-manager/links
 */
import { type AgentTarget } from './agent-registry.js';
import { type WarnLogger } from './library.js';
import type { LinkReport, ProjectLinkView } from './shared/api.js';
import { type StateFile } from './state.js';
/** Link manager inputs resolved by the plugin. */
export interface LinkManagerOptions {
    /** Absolute library root. */
    readonly libraryDir: string;
    /** Absolute record file path. */
    readonly recordPath: string;
    /** Receives warnings that must not fail an operation. */
    readonly logger: WarnLogger;
    /** Reads the current manager state. */
    readonly readState: () => StateFile;
}
/** Values a link request must provide. */
export interface LinkRequest {
    /** Absolute project directory. */
    readonly project: string;
    /** Source slug. */
    readonly source: string;
    /** One skill of the source; omitted links every enabled skill of the source. */
    readonly skillName?: string | undefined;
    /** Agent keys to target; omitted keeps the project's recorded agents. */
    readonly agents?: readonly string[] | undefined;
}
/** Project distribution service. */
export declare class LinkManager {
    private readonly options;
    /**
     * @param options - resolved library, record, state, and logger dependencies.
     */
    constructor(options: LinkManagerOptions);
    /**
     * Read every recorded project, refreshed from disk.
     * @returns one view per recorded project, sorted by path.
     */
    listProjects(): ProjectLinkView[];
    /**
     * Link one skill, or every enabled skill of a source, into a project.
     * @param request - project, source, optional skill, and agent targets.
     * @returns the refreshed project view and per-state counts.
     * @throws {SkillManagerError} for an unusable project, unknown source, disabled skill, or occupied positions.
     */
    link(request: LinkRequest): LinkReport;
    /**
     * Remove links this manager placed for one skill or a whole source.
     * @param request - project, source, optional skill, and optional agent subset.
     * @returns the refreshed project view and per-state counts.
     */
    unlink(request: LinkRequest): LinkReport;
    /**
     * Rebuild every recorded association for a project.
     * @param projectInput - absolute project directory.
     * @returns the refreshed project view and per-state counts;
     *   an unrecorded project yields an empty view.
     */
    resync(projectInput: string): LinkReport;
    /**
     * Turn this project's distribution of a skill (or a whole source) on or off.
     * Disabling removes the symlinks but keeps the record; enabling validates the
     * skill and recreates the links.
     * @param request - project, source, optional skill, and the desired switch.
     * @returns the refreshed project view and per-state counts.
     */
    setEnabled(request: LinkRequest & {
        readonly enabled: boolean;
    }): LinkReport;
    /**
     * Remove links of a source (or skill) from every project while keeping the
     * records, so a later restore can recreate them.
     * @param source - source slug.
     * @param skillName - optional single skill.
     */
    detach(source: string, skillName?: string): void;
    /**
     * Recreate links for a source (or skill) in every project whose entry is
     * enabled and whose skill is currently usable.
     * @param source - source slug.
     * @param skillName - optional single skill.
     */
    restore(source: string, skillName?: string): void;
    /**
     * Remove every link resolving into a source, across all recorded projects,
     * and drop the records. Called before the source directory is deleted so no
     * dangling link remains.
     * @param source - source slug being removed.
     */
    forgetSource(source: string): void;
    /**
     * Remove links of one skill, across all recorded projects.
     * @param source - source slug.
     * @param skillName - skill directory name that is being disabled or removed.
     */
    forgetSkill(source: string, skillName: string): void;
    private forget;
    private report;
    private view;
    private entriesToLink;
    private scannedSource;
    private skillDirectory;
    private skillDirectoryIfPresent;
    private placeLink;
    private repairOrPlace;
    private readFile;
    private writeFile;
}
/**
 * Registry rows exposed to the Web Client.
 * @returns agent conventions with DSH first.
 */
export declare function listAgentTargets(): readonly AgentTarget[];
