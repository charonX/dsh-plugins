/**
 * Discovery of skills already installed globally by this or other agents.
 *
 * The scanner only reads: importing is an explicit copy into the library, so an
 * external tool can never change a managed skill behind the manager's back.
 *
 * @module dsh-skills-manager/scan
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { parseSkillMarkdown } from './frontmatter.js';
import { scanLibrary } from './library.js';
import { canonicalPath } from './paths.js';
/**
 * Build the built-in global roots: DSH's own user directory plus the common
 * agent homes, following each tool's environment override when set.
 * @param env - environment used to resolve overrides.
 * @returns one root per known agent, in display order.
 */
export function defaultScanRoots(env = process.env) {
    const home = env.HOME ?? '';
    const dshHome = resolveDshHome(undefined, env);
    const roots = [
        { key: 'dsh', label: 'DeepSeek Harness', path: join(dshHome, 'skills'), skip: '.system' },
        { key: 'agents', label: 'Shared agents', path: join(home, '.agents', 'skills') },
        {
            key: 'claude',
            label: 'Claude Code',
            path: join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'skills'),
        },
        {
            key: 'codex',
            label: 'Codex',
            path: join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'skills'),
        },
        { key: 'cursor', label: 'Cursor', path: join(home, '.cursor', 'skills') },
        { key: 'gemini', label: 'Gemini CLI', path: join(home, '.gemini', 'skills') },
        {
            key: 'opencode',
            label: 'OpenCode',
            path: join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'opencode', 'skills'),
        },
        { key: 'windsurf', label: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'skills') },
    ];
    return roots;
}
/**
 * Scan global roots and classify candidates against the current library.
 * @param options - roots, library, provenance, and logger.
 * @returns roots with existence and one row per discovered skill.
 */
export function scanGlobalSkills(options) {
    const builtIn = defaultScanRoots();
    const extra = options.extraRoots.map((path, index) => ({
        key: `custom-${String(index + 1)}`,
        label: basename(expandHomePath(path)) || `custom-${String(index + 1)}`,
        path: expandHomePath(path),
    }));
    const roots = [...builtIn, ...extra];
    const library = buildLibraryIndex(options);
    const skills = [];
    const views = [];
    for (const root of roots) {
        const exists = isDirectory(root.path);
        views.push({ key: root.key, label: root.label, path: root.path, exists });
        if (!exists)
            continue;
        for (const entry of readdirSync(root.path, { withFileTypes: true })) {
            if (entry.name.startsWith('.') && entry.name !== root.skip)
                continue;
            if (root.skip !== undefined && entry.name === root.skip)
                continue;
            const skill = readCandidate(root, entry.name, entry.isDirectory());
            if (skill === undefined)
                continue;
            const existing = library.byName.get(skill.name);
            const status = skill.problem !== undefined
                ? 'invalid'
                : existing === undefined
                    ? 'importable'
                    : existing.hash === skill.hash
                        ? 'imported'
                        : 'conflict';
            skills.push({
                ...skill,
                originKey: root.key,
                originLabel: root.label,
                originPath: root.path,
                status,
                ...(existing === undefined
                    ? {}
                    : { existing: { source: existing.source, skillName: existing.skillName, hash: existing.hash } }),
            });
        }
    }
    skills.sort((left, right) => left.originKey.localeCompare(right.originKey) || left.name.localeCompare(right.name));
    return { roots: views, skills };
}
/**
 * Hash one SKILL.md body; the unit of conflict detection.
 * @param text - file contents.
 * @returns lowercase sha256 hex.
 */
export function hashSkillText(text) {
    return createHash('sha256').update(text).digest('hex');
}
function readCandidate(root, entryName, isDir) {
    const path = join(root.path, entryName);
    let text;
    let name;
    let skillPath;
    if (isDir) {
        skillPath = join(path, 'SKILL.md');
        if (!isFile(skillPath))
            return undefined;
        name = entryName;
    }
    else {
        if (!entryName.endsWith('.md'))
            return undefined;
        skillPath = path;
        name = entryName.slice(0, -'.md'.length);
    }
    try {
        text = readFileSync(skillPath, 'utf8');
    }
    catch {
        return undefined;
    }
    const parsed = parseSkillMarkdown(text);
    const catalogName = parsed.name ?? name;
    return {
        path: skillPath,
        name: catalogName,
        dirName: name,
        description: parsed.description,
        hash: hashSkillText(text),
        ...(parsed.problem === undefined ? {} : { problem: parsed.problem }),
    };
}
export function buildLibraryIndex(options) {
    const byName = new Map();
    for (const source of scanLibrary(options.libraryDir, options.logger)) {
        for (const skill of source.skills) {
            if (!skill.valid || skill.name === undefined)
                continue;
            let hash;
            try {
                hash = hashSkillText(readFileSync(join(skill.dir, 'SKILL.md'), 'utf8'));
            }
            catch {
                continue;
            }
            const ref = {
                source: source.slug,
                skillName: skill.skillName,
                name: skill.name,
                dir: skill.dir,
                hash,
                imported: options.importedKeys.has(`${source.slug}/${skill.skillName}`),
            };
            const current = byName.get(skill.name);
            if (current === undefined || (!current.imported && ref.imported))
                byName.set(skill.name, ref);
        }
    }
    return { byName };
}
/**
 * Whether a candidate path lives inside one of the configured scan roots.
 * @param path - absolute candidate path.
 * @param extraRoots - configured extra roots.
 * @returns the matching root, or undefined when the path is outside every root.
 */
export function rootForPath(path, extraRoots) {
    const key = canonicalPath(path);
    return [...defaultScanRoots(), ...extraRoots.map((entry, index) => ({
            key: `custom-${String(index + 1)}`,
            label: basename(entry),
            path: expandHomePath(entry),
        }))].find((root) => {
        const rootKey = canonicalPath(root.path);
        return key === rootKey || key.startsWith(`${rootKey}/`);
    });
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
//# sourceMappingURL=scan.js.map