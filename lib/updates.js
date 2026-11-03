/**
 * Git update checks for library sources.
 *
 * A check fetches the source's remote, compares the local HEAD with its
 * upstream, and records the result for the Web Client. Results are advisory:
 * updating stays an explicit `git pull --ff-only`.
 *
 * @module dsh-skills-manager/updates
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readGitRemote } from './library.js';
import { SkillManagerError } from './errors.js';
import { assertGitIdentifier, ensureGitAvailable } from './installer.js';
import { execFileAsync } from './process.js';
/** Persistent last-check results, keyed by source slug. */
export class UpdateStore {
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
     * Read the recorded checks.
     * @returns checks keyed by source slug.
     */
    read() {
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null)
                return {};
            const record = parsed;
            if (typeof record.checks !== 'object' || record.checks === null)
                return {};
            return record.checks;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.warn(`skills-manager: ignoring unreadable update record ${this.path}: ${message(error)}`);
            }
            return {};
        }
    }
    /**
     * Record one check.
     * @param slug - source slug.
     * @param check - the observation.
     */
    set(slug, check) {
        this.write({ ...this.read(), [slug]: check });
    }
    /**
     * Drop a removed source's check.
     * @param slug - source slug.
     */
    drop(slug) {
        const checks = { ...this.read() };
        if (!(slug in checks))
            return;
        delete checks[slug];
        this.write(checks);
    }
    write(checks) {
        mkdirSync(dirname(this.path), { recursive: true });
        const temporary = join(dirname(this.path), `.${Date.now()}-${process.pid}.updates.tmp`);
        try {
            writeFileSync(temporary, `${JSON.stringify({ version: 1, checks }, null, 2)}\n`, 'utf8');
            renameSync(temporary, this.path);
        }
        catch (error) {
            rmSync(temporary, { force: true });
            throw error;
        }
    }
}
/**
 * Fetch a source and compare its local HEAD with its upstream.
 * @param sourceDir - absolute source directory inside the library.
 * @param options - protocol configuration.
 * @returns the observation; a git failure becomes `error` on the record.
 * @throws {SkillManagerError} when the source is not a git clone or its remote is not allowed.
 */
export async function checkGitSource(sourceDir, options) {
    if (!isGitSource(sourceDir)) {
        throw new SkillManagerError(400, 'SKILL_UPDATE_UNSUPPORTED', 'Local skill sources have no upstream; reinstall the source with overwrite enabled to pick up changes');
    }
    const remote = readGitRemote(sourceDir);
    if (remote === undefined) {
        throw new SkillManagerError(400, 'SKILL_CHECK_UNSUPPORTED', 'This git source has no origin remote to check');
    }
    assertGitIdentifier(remote, options.allowFileProtocol);
    await ensureGitAvailable();
    const checkedAt = new Date().toISOString();
    const localCommit = await git(sourceDir, ['rev-parse', 'HEAD']).then((value) => value.trim()).catch(() => undefined);
    const dirty = await git(sourceDir, ['status', '--porcelain'])
        .then((value) => value.trim() !== '')
        .catch(() => undefined);
    try {
        await git(sourceDir, ['fetch', '--quiet', '--tags', '--prune', 'origin'], 120_000);
    }
    catch (error) {
        return { checkedAt, ...(localCommit === undefined ? {} : { localCommit }), ...(dirty === undefined ? {} : { dirty }), error: failureOf(error) };
    }
    const upstream = await resolveUpstream(sourceDir);
    if (upstream === undefined) {
        return {
            checkedAt,
            ...(localCommit === undefined ? {} : { localCommit }),
            ...(dirty === undefined ? {} : { dirty }),
            error: { code: 'SKILL_CHECK_UNSUPPORTED', message: 'The checked-out branch has no upstream to compare with' },
        };
    }
    const remoteCommit = await git(sourceDir, ['rev-parse', upstream]).then((value) => value.trim()).catch(() => undefined);
    const counts = await git(sourceDir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
        .then((value) => value.trim().split(/\s+/u))
        .catch(() => undefined);
    const ahead = counts?.[0] === undefined ? undefined : Number(counts[0]);
    const behind = counts?.[1] === undefined ? undefined : Number(counts[1]);
    const remoteVersion = await git(sourceDir, ['describe', '--tags', '--always', upstream])
        .then((value) => value.trim())
        .catch(() => undefined);
    return {
        checkedAt,
        ...(localCommit === undefined ? {} : { localCommit }),
        ...(remoteCommit === undefined ? {} : { remoteCommit }),
        ...(ahead === undefined ? {} : { ahead }),
        ...(behind === undefined ? {} : { behind }),
        ...(dirty === undefined ? {} : { dirty }),
        ...(remoteVersion === undefined ? {} : { remoteVersion }),
    };
}
function isGitSource(sourceDir) {
    try {
        readFileSync(join(sourceDir, '.git', 'HEAD'), 'utf8');
        return true;
    }
    catch {
        // A worktree or submodule keeps `.git` as a file; fall back to the entry.
        try {
            return readFileSync(join(sourceDir, '.git'), 'utf8').length > 0;
        }
        catch {
            return false;
        }
    }
}
async function resolveUpstream(sourceDir) {
    const symbolic = await git(sourceDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
        .then((value) => value.trim())
        .catch(() => '');
    if (symbolic !== '')
        return symbolic;
    for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master']) {
        const resolved = await git(sourceDir, ['rev-parse', '--verify', '--quiet', candidate])
            .then((value) => value.trim())
            .catch(() => '');
        if (resolved !== '')
            return candidate;
    }
    return undefined;
}
async function git(sourceDir, args, timeout = 60_000) {
    const result = await execFileAsync('git', ['-C', sourceDir, ...args], { timeout });
    return result.stdout;
}
function failureOf(error) {
    const failure = error;
    return {
        code: 'SKILL_CHECK_FAILED',
        message: failure.stderr?.trim() || failure.message || 'git fetch failed',
    };
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=updates.js.map