/**
 * Install, update, and remove library sources.
 *
 * Every child process is started with an argument array — never a shell — and
 * git identifiers are restricted to transports that cannot execute commands.
 *
 * @module dsh-skills-manager/installer
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expandHomePath } from '@deepseek-ai/dsh-home-paths';
import { SkillManagerError } from './errors.js';
import { discoverSkillDirs, readGitRemote } from './library.js';
import { canonicalPath, isInsideOrEqual, sanitizeDirectoryName } from './paths.js';
import { execFileAsync } from './process.js';
/** Git transports that cannot execute arbitrary commands. */
const ALLOWED_GIT_IDENTIFIER = /^(?:https:\/\/\S+|ssh:\/\/\S+|file:\/\/\S+|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:\S+)$/u;
/** Git transports accepted regardless of `allowFileProtocol`. */
const NETWORK_GIT_IDENTIFIER = /^(?:https:\/\/\S+|ssh:\/\/\S+|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:\S+)$/u;
/** Bytes of command output kept per job. */
const MAX_LOG_CHARS = 256 * 1024;
/**
 * Strips command runners like `npx skill add`, `npx skills add`, `bunx skills add`,
 * as well as common CLI flags so that pasting a terminal command works cleanly.
 *
 * @param input - raw user input string.
 * @returns sanitized input string.
 */
export function cleanSkillCommandInput(input) {
    let cleaned = input.trim();
    cleaned = cleaned.replace(/^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:skills?)\s+add\s+/u, '');
    cleaned = cleaned.replace(/(?:^|\s+)(?:-y|--yes|-g|--global)(?=\s|$)/gu, ' ');
    cleaned = cleaned.replace(/(?:^|\s+)(?:-a|--agent|--skill)\s+\S+/gu, ' ');
    return cleaned.trim();
}
/**
 * Normalize an identifier (which may be a GitHub shorthand like `citrolabs/ego-lite`,
 * a GitHub browser URL with branch/tree, or a raw git transport) into a cloneable target.
 *
 * @param input - user-supplied clone source, command, or shorthand.
 * @returns normalized target with cloneable url and optional ref.
 */
export function normalizeGitSource(input) {
    const cleaned = cleanSkillCommandInput(input);
    if (cleaned === '') {
        return { url: '' };
    }
    // 1. GitHub web URL with tree: https://github.com/owner/repo/tree/branch/...
    const treeMatch = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/tree\/([^/]+)(?:\/.*)?$/iu.exec(cleaned);
    if (treeMatch) {
        const [, owner, repo, ref] = treeMatch;
        return {
            url: `https://github.com/${owner}/${repo}.git`,
            ref,
        };
    }
    // 2. GitHub web URL without tree: https://github.com/owner/repo or https://github.com/owner/repo.git or https://github.com/owner/repo@ref
    const webMatch = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:@([A-Za-z0-9._/-]+))?$/iu.exec(cleaned);
    if (webMatch) {
        const [, owner, repo, ref] = webMatch;
        return {
            url: `https://github.com/${owner}/${repo}.git`,
            ref,
        };
    }
    // 3. GitHub shorthand: owner/repo or owner/repo@ref
    // Exclude scp syntax (user@host:path), URLs (proto://...), or local paths (/..., ~..., ....)
    if (!cleaned.includes(':') && !cleaned.startsWith('/') && !cleaned.startsWith('~') && !cleaned.startsWith('.')) {
        const shorthandMatch = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:@([A-Za-z0-9._/-]+))?$/u.exec(cleaned);
        if (shorthandMatch) {
            const [, owner, repo, ref] = shorthandMatch;
            return {
                url: `https://github.com/${owner}/${repo}.git`,
                ref,
            };
        }
    }
    // 4. Raw git URL or transport
    return { url: cleaned };
}
/**
 * Validate a git identifier or shorthand, resolving it to a cloneable target.
 *
 * @param identifier - user-supplied clone source, command, or shorthand.
 * @param allowFile - whether `file://` identifiers are allowed.
 * @returns the validated and normalized target.
 * @throws {SkillManagerError} when the source or ref is invalid or forbidden.
 */
export function resolveGitSource(identifier, allowFile) {
    const normalized = normalizeGitSource(identifier);
    const trimmedUrl = normalized.url.trim();
    if (trimmedUrl === '' || trimmedUrl.startsWith('-') || !ALLOWED_GIT_IDENTIFIER.test(trimmedUrl)) {
        throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', 'Git identifier must be an https://, ssh://, file:// URL, owner/repo shorthand, or scp-like <user>@<host>:<path>');
    }
    if (!allowFile && !NETWORK_GIT_IDENTIFIER.test(trimmedUrl)) {
        throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', 'file:// git identifiers are disabled by configuration');
    }
    if (normalized.ref !== undefined) {
        const ref = normalized.ref.trim();
        if (ref === '' || ref.startsWith('-') || !/^[A-Za-z0-9._/-]+$/u.test(ref)) {
            throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', `Invalid git ref: "${normalized.ref}"`);
        }
    }
    return normalized;
}
/**
 * Validate a git identifier before any command runs.
 * @param identifier - user-supplied clone source, command, or shorthand.
 * @param allowFile - whether `file://` identifiers are allowed.
 * @returns the resolved, cloneable git URL.
 * @throws {SkillManagerError} when the transport is not on the allow list.
 */
export function assertGitIdentifier(identifier, allowFile) {
    return resolveGitSource(identifier, allowFile).url;
}
/**
 * Ensure a `git` executable is available.
 * @throws {SkillManagerError} with `GIT_UNAVAILABLE` when git cannot be started.
 */
export async function ensureGitAvailable() {
    try {
        await execFileAsync('git', ['--version']);
    }
    catch {
        throw new SkillManagerError(503, 'GIT_UNAVAILABLE', 'System git is not available on PATH');
    }
}
/**
 * Derive a stable directory name from a git identifier (`owner-repo`).
 * @param identifier - validated git identifier, shorthand, or target object.
 * @returns the sanitized slug.
 */
export function deriveGitSlug(identifier) {
    const raw = typeof identifier === 'string' ? normalizeGitSource(identifier).url : identifier.url;
    if (raw.startsWith('file://')) {
        const pathname = raw.slice('file://'.length).replace(/[/\\]+$/u, '');
        const last = pathname.split(/[/\\]/u).filter(Boolean).pop() ?? 'skill-source';
        return sanitizeDirectoryName(last.replace(/\.git$/iu, ''));
    }
    const trimmed = raw.replace(/[/\\]+$/u, '').replace(/\.git$/iu, '');
    const segments = trimmed.split(/[/:]+/u).filter(Boolean);
    const last = segments[segments.length - 1] ?? 'skill-source';
    const owner = segments.length > 1 ? segments[segments.length - 2] : undefined;
    return sanitizeDirectoryName(owner === undefined ? last : `${owner}-${last}`);
}
/**
 * Pick a free slug by appending a numeric suffix.
 * @param libraryDir - absolute library root.
 * @param base - desired slug.
 * @returns a slug whose directory does not exist yet.
 */
export function resolveFreeSlug(libraryDir, base) {
    let candidate = base;
    for (let index = 2; existsSync(join(libraryDir, candidate)); index += 1) {
        candidate = `${base}-${index}`;
    }
    return candidate;
}
/**
 * Clone a git source into the library and validate its contents.
 * @param job - job receiving live command output.
 * @param options - library and protocol configuration.
 * @param identifier - validated git identifier, shorthand, or target.
 * @returns the created source slug.
 * @throws {SkillManagerError} when git fails or the clone holds no skill.
 */
export async function installGitSource(job, options, identifier) {
    await ensureGitAvailable();
    mkdirSync(options.libraryDir, { recursive: true });
    const targetSource = typeof identifier === 'string'
        ? resolveGitSource(identifier, options.allowFileProtocol)
        : identifier;
    const slug = resolveFreeSlug(options.libraryDir, deriveGitSlug(targetSource));
    const target = join(options.libraryDir, slug);
    await clone(job, targetSource.url, target, options.libraryDir, targetSource.ref);
    try {
        assertSourceContents(target);
    }
    catch (error) {
        rmSync(target, { recursive: true, force: true });
        throw error;
    }
    return slug;
}
/**
 * Copy a local directory into the library and validate its contents.
 * @param job - job receiving progress output.
 * @param options - library configuration.
 * @param identifier - absolute or `~`-prefixed source directory.
 * @param force - replace an existing source with the same slug.
 * @returns the created source slug.
 * @throws {SkillManagerError} when the directory is unusable, overlaps the library, or conflicts.
 */
export async function installLocalSource(job, options, identifier, force) {
    const sourceDir = validateLocalSource(identifier, options.libraryDir);
    mkdirSync(options.libraryDir, { recursive: true });
    const slug = sanitizeDirectoryName(basename(sourceDir));
    const target = join(options.libraryDir, slug);
    if (existsSync(target) && !force) {
        throw new SkillManagerError(409, 'SKILL_SLUG_CONFLICT', `A source named "${slug}" already exists in the skill library; enable overwrite to replace it`);
    }
    if (force)
        rmSync(target, { recursive: true, force: true });
    appendLog(job, `copy ${sourceDir} -> ${target}\n`);
    try {
        cpSync(sourceDir, target, {
            recursive: true,
            dereference: false,
            // A copied source is local-type; never bring a nested repository along.
            filter: (path) => basename(path) !== '.git',
        });
        assertSourceContents(target);
    }
    catch (error) {
        rmSync(target, { recursive: true, force: true });
        throw error instanceof SkillManagerError
            ? error
            : new SkillManagerError(502, 'SKILL_FETCH_FAILED', errorMessage(error));
    }
    return slug;
}
/**
 * Update a git source in place with `git pull --ff-only`.
 * @param job - job receiving live command output.
 * @param options - library configuration.
 * @param sourceDir - absolute source directory.
 * @throws {SkillManagerError} when the source is not a git clone, its remote is
 *   not an allowed transport, or the pull fails.
 */
export async function updateGitSource(job, options, sourceDir) {
    if (!existsSync(join(sourceDir, '.git'))) {
        throw new SkillManagerError(400, 'SKILL_UPDATE_UNSUPPORTED', 'Local skill sources cannot be updated automatically; reinstall the source with overwrite enabled');
    }
    // The remote lives in a file inside the library and could have been rewritten
    // to an executable transport; revalidate before any fetch.
    const remote = readGitRemote(sourceDir);
    if (remote !== undefined)
        assertGitIdentifier(remote, options.allowFileProtocol);
    await ensureGitAvailable();
    try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', sourceDir, 'pull', '--ff-only'], { timeout: 120_000 });
        const output = `${stdout}${stderr}`.trim();
        if (output !== '')
            appendLog(job, output);
    }
    catch (error) {
        const failure = error;
        const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
        job.log = output === '' ? (failure.message ?? 'git pull failed') : output;
        throw new SkillManagerError(502, 'SKILL_UPDATE_FAILED', failure.stderr?.trim() || failure.message || 'git pull failed');
    }
}
/**
 * Delete one source directory.
 * @param sourceDir - absolute source directory inside the library.
 */
export function removeSourceDirectory(sourceDir) {
    rmSync(sourceDir, { recursive: true, force: true });
}
function validateLocalSource(identifier, libraryDir) {
    const expanded = expandHomePath(identifier.trim());
    let stats;
    try {
        stats = statSync(expanded);
    }
    catch {
        throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', `Local source does not exist: ${identifier}`);
    }
    if (!stats.isDirectory()) {
        throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', `Local source is not a directory: ${identifier}`);
    }
    const sourceKey = canonicalPath(expanded);
    const libraryKey = canonicalPath(libraryDir);
    if (isInsideOrEqual(libraryKey, sourceKey) || isInsideOrEqual(sourceKey, libraryKey)) {
        throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', 'Local source must not equal, contain, or live inside the skill library');
    }
    if (discoverSkillDirs(sourceKey).length === 0) {
        throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', 'Local source contains no SKILL.md at its root, under skills/*/ or under skills/*/*/');
    }
    return sourceKey;
}
function assertSourceContents(target) {
    if (discoverSkillDirs(target).length > 0)
        return;
    throw new SkillManagerError(502, 'SKILL_SOURCE_INVALID', 'Installed source contains no SKILL.md at its root, under skills/*/ or under skills/*/*/');
}
async function clone(job, identifier, target, libraryDir, ref) {
    const args = ['clone', '--depth', '1', '--progress'];
    if (ref !== undefined && ref.trim() !== '') {
        args.push('--branch', ref.trim());
    }
    args.push('--', identifier, target);
    await new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd: libraryDir,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => appendLog(job, chunk));
        child.stderr.on('data', (chunk) => appendLog(job, chunk));
        child.on('error', (error) => {
            reject(new SkillManagerError(502, 'SKILL_FETCH_FAILED', `cannot start git: ${error.message}`));
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            const detail = (job.log ?? '').trim();
            rmSync(target, { recursive: true, force: true });
            reject(new SkillManagerError(502, 'SKILL_FETCH_FAILED', detail === '' ? `git clone exited ${String(code)}` : detail));
        });
    });
}
function appendLog(job, chunk) {
    const next = (job.log ?? '') + chunk;
    job.log = next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=installer.js.map