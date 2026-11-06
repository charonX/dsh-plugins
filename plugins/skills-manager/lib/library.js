/**
 * Live scan of the managed skill library.
 *
 * Disk is the single source of truth: there is no index or install database.
 * A source is one direct child directory of the library, and it may hold a
 * root-level `SKILL.md`, `skills/<name>/SKILL.md`, or the nested
 * `skills/<category>/<name>/SKILL.md` layout carried over from the reference
 * implementation.
 *
 * @module dsh-skills-manager/library
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseSkillMarkdown } from './frontmatter.js';
const HIDDEN_PREFIX = '.';
/**
 * Discover skill directories under one source using the three supported layouts.
 * @param sourceDir - absolute source directory.
 * @returns discovered skill directories, unsorted.
 */
export function discoverSkillDirs(sourceDir) {
    const rootSkill = join(sourceDir, 'SKILL.md');
    if (isFile(rootSkill)) {
        return [{ skillName: basename(sourceDir), dir: sourceDir, relativePath: '.' }];
    }
    const skillsRoot = join(sourceDir, 'skills');
    if (!isDirectory(skillsRoot))
        return [];
    const results = [];
    for (const entry of readDirOrEmpty(skillsRoot)) {
        if (!entry.isDirectory())
            continue;
        const dir = join(skillsRoot, entry.name);
        const relativePath = relative(sourceDir, dir).split('\\').join('/');
        if (isFile(join(dir, 'SKILL.md'))) {
            results.push({ skillName: entry.name, dir, relativePath });
            continue;
        }
        // A directory without its own SKILL.md is a category; its skills live one
        // level deeper. Dirs already recognized as skills are never rescanned.
        for (const sub of readDirOrEmpty(dir)) {
            if (!sub.isDirectory())
                continue;
            const subDir = join(dir, sub.name);
            if (isFile(join(subDir, 'SKILL.md'))) {
                results.push({
                    skillName: sub.name,
                    dir: subDir,
                    relativePath: relative(sourceDir, subDir).split('\\').join('/'),
                });
            }
        }
    }
    return results;
}
/**
 * Scan every source inside the library.
 * @param libraryDir - absolute library root; a missing root scans as empty.
 * @param logger - receives warnings for unreadable directories.
 * @returns sources sorted by slug, with skills sorted by directory name.
 */
export function scanLibrary(libraryDir, logger) {
    if (!isDirectory(libraryDir))
        return [];
    const sources = [];
    for (const entry of readDirOrEmpty(libraryDir)) {
        if (entry.name.startsWith(HIDDEN_PREFIX))
            continue;
        const dir = join(libraryDir, entry.name);
        if (!isDirectory(dir))
            continue;
        try {
            sources.push(scanSource(entry.name, dir, logger));
        }
        catch (error) {
            // One bad source must never fail the whole listing.
            logger.warn(`skills-manager: skipping source ${entry.name}: ${errorMessage(error)}`);
            sources.push({
                slug: entry.name,
                dir,
                sourceType: 'local',
                problem: `unreadable source: ${errorMessage(error)}`,
                skills: [],
            });
        }
    }
    sources.sort((left, right) => left.slug.localeCompare(right.slug));
    return sources;
}
function scanSource(slug, dir, logger) {
    const git = existsSync(join(dir, '.git'));
    const discovered = discoverSkillDirs(dir);
    const skills = [];
    const seenNames = new Map();
    for (const discoveredSkill of discovered.sort((left, right) => left.skillName.localeCompare(right.skillName))) {
        let text;
        try {
            text = readFileSync(join(discoveredSkill.dir, 'SKILL.md'), 'utf8');
        }
        catch (error) {
            skills.push({
                ...discoveredSkill,
                invocation: { modelInvocable: true, userInvocable: true },
                valid: false,
                problem: `SKILL.md is unreadable: ${errorMessage(error)}`,
            });
            continue;
        }
        const parsed = parseSkillMarkdown(text);
        const duplicateOwner = parsed.name === undefined ? undefined : seenNames.get(parsed.name);
        if (parsed.name !== undefined) {
            if (duplicateOwner === undefined)
                seenNames.set(parsed.name, discoveredSkill.skillName);
        }
        const duplicateProblem = duplicateOwner === undefined
            ? undefined
            : `duplicate skill name "${parsed.name}" (also used by "${duplicateOwner}")`;
        const problem = parsed.problem ?? duplicateProblem;
        if (problem !== undefined) {
            logger.warn(`skills-manager: ${slug}/${discoveredSkill.skillName} ignored: ${problem}`);
        }
        skills.push({
            ...discoveredSkill,
            invocation: parsed.invocation,
            valid: problem === undefined,
            ...(problem === undefined ? {} : { problem }),
            ...(parsed.name === undefined ? {} : { name: parsed.name }),
            ...(parsed.description === undefined ? {} : { description: parsed.description }),
            ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        });
    }
    const version = readSourceVersion(dir, git);
    return {
        slug,
        dir,
        sourceType: git ? 'git' : 'local',
        ...(git ? { sourceUrl: readGitRemote(dir) } : {}),
        ...(version === undefined ? {} : { version }),
        ...(discovered.length === 0
            ? { problem: 'source contains no SKILL.md at its root, under skills/*/ or under skills/*/*/' }
            : {}),
        skills,
    };
}
/**
 * Read the `origin` remote of a git source from `.git/config`, without running git.
 * @param sourceDir - absolute source directory.
 * @returns the remote URL, if the source is a git clone with an origin.
 */
export function readGitRemote(sourceDir) {
    try {
        const config = readFileSync(join(sourceDir, '.git', 'config'), 'utf8');
        const section = /\[remote "origin"\]([^[]*)/u.exec(config);
        if (section === null)
            return undefined;
        const urlLine = /^\s*url\s*=\s*(.+)$/mu.exec(section[1] ?? '');
        return urlLine?.[1]?.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve a display version: `package.json` version, else the git short hash.
 * @param sourceDir - absolute source directory.
 * @param git - whether the source carries a `.git` entry.
 * @returns the version string, or undefined when neither source answers.
 */
export function readSourceVersion(sourceDir, git) {
    try {
        const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
        if (typeof manifest.version === 'string' && manifest.version !== '')
            return manifest.version;
    }
    catch {
        // Fall through to the git hash.
    }
    if (!git)
        return undefined;
    try {
        const described = execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
            cwd: sourceDir,
            encoding: 'utf8',
            timeout: 2_000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (described !== '')
            return described;
    }
    catch {
        // Fall through to the plain hash.
    }
    try {
        const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: sourceDir,
            encoding: 'utf8',
            timeout: 2_000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return hash === '' ? undefined : hash;
    }
    catch {
        return undefined;
    }
}
function readDirOrEmpty(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=library.js.map