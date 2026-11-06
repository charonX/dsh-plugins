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
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SkillManagerError } from './errors.js';
import { parseSkillMarkdown } from './frontmatter.js';
import { buildLibraryIndex, hashSkillText, rootForPath } from './scan.js';
/** Provenance storage, written atomically next to the other state files. */
export class ImportStore {
    path;
    logger;
    /**
     * @param path - absolute JSON file path.
     * @param logger - receives warnings for an unreadable file.
     */
    constructor(path, logger) {
        this.path = path;
        this.logger = logger;
    }
    /**
     * Read every recorded import.
     * @returns provenance keyed by `source/skillName`.
     */
    read() {
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null)
                return {};
            const entries = parsed.entries;
            return typeof entries === 'object' && entries !== null ? entries : {};
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.warn(`skills-manager: ignoring unreadable import record ${this.path}: ${message(error)}`);
            }
            return {};
        }
    }
    /**
     * Keys already owned by an import.
     * @returns the provenance keys.
     */
    keys() {
        return new Set(Object.keys(this.read()));
    }
    /**
     * Whether a source holds at least one imported skill.
     * @param source - source slug.
     * @returns true when the source was created by an import.
     */
    ownsSource(source) {
        return Object.keys(this.read()).some((key) => key.startsWith(`${source}/`));
    }
    /**
     * Record one import.
     * @param source - imported source slug.
     * @param skillName - skill directory name.
     * @param record - provenance row.
     */
    set(source, skillName, record) {
        this.write({ ...this.read(), [`${source}/${skillName}`]: record });
    }
    /**
     * Drop the provenance of a removed source.
     * @param source - source slug.
     */
    dropSource(source) {
        const entries = this.read();
        let changed = false;
        for (const key of Object.keys(entries)) {
            if (!key.startsWith(`${source}/`))
                continue;
            delete entries[key];
            changed = true;
        }
        if (changed)
            this.write(entries);
    }
    write(entries) {
        mkdirSync(dirname(this.path), { recursive: true });
        const temporary = join(dirname(this.path), `.${Date.now()}-${process.pid}.imports.tmp`);
        try {
            writeFileSync(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
            renameSync(temporary, this.path);
        }
        catch (error) {
            rmSync(temporary, { force: true });
            throw error;
        }
    }
}
/**
 * Copy the selected skills into `imported-<origin>` sources.
 * @param options - library, store, roots, and logger.
 * @param request - requested paths and the overwrite flag.
 * @returns one outcome per requested path.
 * @throws {SkillManagerError} when the request is empty or malformed.
 */
export function importSkills(options, request) {
    if (!Array.isArray(request.paths) || request.paths.length === 0) {
        throw new SkillManagerError(400, 'IMPORT_EMPTY', 'Select at least one skill to import');
    }
    const outcomes = [];
    const library = buildLibraryIndex({
        extraRoots: options.extraRoots,
        libraryDir: options.libraryDir,
        importedKeys: options.store.keys(),
        logger: options.logger,
    });
    const sourceSlugs = new Map();
    for (const rawPath of [...new Set(request.paths)]) {
        const path = typeof rawPath === 'string' ? rawPath : '';
        try {
            const candidate = resolveCandidate(path, options);
            if (candidate.problem !== undefined) {
                outcomes.push(failure(path, candidate.name, 'INVALID_SKILL', candidate.problem));
                continue;
            }
            const existing = library.byName.get(candidate.name);
            if (existing !== undefined && existing.hash === candidate.hash) {
                outcomes.push({
                    path: candidate.path,
                    name: candidate.name,
                    status: 'skipped',
                    source: existing.source,
                    skillName: existing.skillName,
                    code: 'ALREADY_IMPORTED',
                });
                continue;
            }
            if (existing !== undefined) {
                if (request.overwrite === true && existing.imported) {
                    const replaced = replaceSkill(options, existing, candidate);
                    library.byName.set(candidate.name, replaced);
                    outcomes.push({
                        path: candidate.path,
                        name: candidate.name,
                        status: 'overwritten',
                        source: replaced.source,
                        skillName: replaced.skillName,
                    });
                    continue;
                }
                outcomes.push({
                    path: candidate.path,
                    name: candidate.name,
                    status: 'conflict',
                    source: existing.source,
                    skillName: existing.skillName,
                    code: 'SKILL_NAME_CONFLICT',
                    message: `A different "${candidate.name}" already exists in ${existing.source}/${existing.skillName}${existing.imported ? '' : ' (not an import; remove it or import under another name)'}`,
                });
                continue;
            }
            const slug = sourceSlug(options, sourceSlugs, candidate.originKey);
            const skillName = copyInto(options, slug, candidate);
            options.store.set(slug, skillName, provenance(candidate));
            const imported = {
                source: slug,
                skillName,
                name: candidate.name,
                dir: join(options.libraryDir, slug, 'skills', skillName),
                hash: candidate.hash,
                imported: true,
            };
            library.byName.set(candidate.name, imported);
            outcomes.push({
                path: candidate.path,
                name: candidate.name,
                status: 'imported',
                source: slug,
                skillName,
            });
        }
        catch (error) {
            outcomes.push(failure(path, basename(path), error instanceof SkillManagerError ? error.code : 'IMPORT_FAILED', message(error)));
        }
    }
    return { outcomes };
}
function resolveCandidate(path, options) {
    const root = rootForPath(path, options.extraRoots);
    if (root === undefined) {
        throw new SkillManagerError(400, 'IMPORT_PATH_INVALID', `Path is outside the configured scan roots: ${path}`);
    }
    let stats;
    try {
        stats = statSync(path);
    }
    catch {
        throw new SkillManagerError(400, 'IMPORT_PATH_INVALID', `Path does not exist: ${path}`);
    }
    const isDirectory = stats.isDirectory();
    const skillPath = isDirectory ? join(path, 'SKILL.md') : path;
    if (isDirectory && !existsSync(skillPath)) {
        throw new SkillManagerError(400, 'IMPORT_PATH_INVALID', `Directory has no SKILL.md: ${path}`);
    }
    if (!isDirectory && !path.endsWith('.md')) {
        throw new SkillManagerError(400, 'IMPORT_PATH_INVALID', `A flat skill must be a .md file: ${path}`);
    }
    const text = readFileSync(skillPath, 'utf8');
    const parsed = parseSkillMarkdown(text);
    // The scan reports SKILL.md paths for directory bundles; either shape is
    // accepted here so callers can pass a scan row verbatim.
    const bundleDir = isDirectory || basename(skillPath) === 'SKILL.md' ? dirname(skillPath) : undefined;
    const dirName = bundleDir === undefined ? basename(path, '.md') : basename(bundleDir);
    return {
        path: skillPath,
        originKey: root.key,
        name: parsed.name ?? dirName,
        dirName,
        hash: hashSkillText(text),
        ...(bundleDir === undefined ? {} : { directory: bundleDir }),
        ...(parsed.problem === undefined ? {} : { problem: parsed.problem }),
    };
}
function sourceSlug(options, cache, originKey) {
    const cached = cache.get(originKey);
    if (cached !== undefined)
        return cached;
    const base = `imported-${originKey}`;
    let candidate = base;
    for (let index = 2; existsSync(join(options.libraryDir, candidate)) && !options.store.ownsSource(candidate); index += 1) {
        candidate = `${base}-${String(index)}`;
    }
    cache.set(originKey, candidate);
    return candidate;
}
function copyInto(options, slug, candidate) {
    const skillName = candidate.dirName;
    const targetDir = join(options.libraryDir, slug, 'skills', skillName);
    if (existsSync(targetDir)) {
        throw new SkillManagerError(409, 'SKILL_SLUG_CONFLICT', `Target already exists: ${slug}/skills/${skillName}`);
    }
    mkdirSync(dirname(targetDir), { recursive: true });
    copyCandidate(candidate, targetDir);
    return skillName;
}
function replaceSkill(options, existing, candidate) {
    rmSync(existing.dir, { recursive: true, force: true });
    const skillName = copyIntoAt(existing.dir, candidate);
    options.store.set(existing.source, existing.skillName, provenance(candidate));
    return { ...existing, skillName, hash: candidate.hash };
}
function copyIntoAt(targetDir, candidate) {
    mkdirSync(dirname(targetDir), { recursive: true });
    copyCandidate(candidate, targetDir);
    return basename(targetDir);
}
function copyCandidate(candidate, targetDir) {
    mkdirSync(targetDir, { recursive: true });
    if (candidate.directory !== undefined) {
        cpSync(candidate.directory, targetDir, {
            recursive: true,
            dereference: false,
            filter: (path) => basename(path) !== '.git',
        });
    }
    else {
        cpSync(candidate.path, join(targetDir, 'SKILL.md'));
    }
}
function provenance(candidate) {
    return {
        originPath: candidate.path,
        originKey: candidate.originKey,
        contentHash: candidate.hash,
        importedAt: new Date().toISOString(),
    };
}
function failure(path, name, code, message) {
    return { path, name, status: 'failed', code, message };
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=imports.js.map