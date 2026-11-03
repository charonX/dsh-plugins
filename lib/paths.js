/**
 * Directory-identity validation and containment checks for library paths.
 *
 * Identities arrive from HTTP clients, so every route validates them here
 * before a path is composed.
 *
 * @module dsh-skills-manager/paths
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { SkillManagerError } from './errors.js';
/** One directory name: no separators, whitespace, control characters or traversal. */
const DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * Assert that a client-supplied value is exactly one directory name.
 * @param value - untrusted identity from a route or body.
 * @param kind - noun used in the failure message.
 * @returns the validated identity.
 * @throws {SkillManagerError} when the value is not one safe directory name.
 */
export function assertDirectoryName(value, kind) {
    if (typeof value !== 'string'
        || value === ''
        || value === '.'
        || value === '..'
        || !DIRECTORY_NAME.test(value)
        || isAbsolute(value)) {
        throw new SkillManagerError(400, 'SKILL_IDENTITY_INVALID', `Illegal ${kind}: ${JSON.stringify(value)} (a single directory name is required)`);
    }
    return value;
}
/**
 * Whether `child` is `parent` or lies below it.
 * @param parent - absolute candidate ancestor.
 * @param child - absolute candidate descendant.
 * @returns whether the descendant relationship holds by lexical path resolution.
 */
export function isInsideOrEqual(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/**
 * Canonical comparison key for an existing path, falling back to resolution.
 * @param path - path to canonicalize.
 * @returns the real path when it exists, otherwise the resolved absolute path.
 */
export function canonicalPath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
}
/**
 * Sanitize a directory name into the accepted alphabet.
 * @param value - raw name derived from a URL or directory.
 * @returns a non-empty safe directory name.
 */
export function sanitizeDirectoryName(value) {
    const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+/u, '');
    return cleaned === '' ? 'skill-source' : cleaned;
}
//# sourceMappingURL=paths.js.map