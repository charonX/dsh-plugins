/**
 * Directory-identity validation and containment checks for library paths.
 *
 * Identities arrive from HTTP clients, so every route validates them here
 * before a path is composed.
 *
 * @module dsh-skills-manager/paths
 */
/**
 * Assert that a client-supplied value is exactly one directory name.
 * @param value - untrusted identity from a route or body.
 * @param kind - noun used in the failure message.
 * @returns the validated identity.
 * @throws {SkillManagerError} when the value is not one safe directory name.
 */
export declare function assertDirectoryName(value: unknown, kind: string): string;
/**
 * Whether `child` is `parent` or lies below it.
 * @param parent - absolute candidate ancestor.
 * @param child - absolute candidate descendant.
 * @returns whether the descendant relationship holds by lexical path resolution.
 */
export declare function isInsideOrEqual(parent: string, child: string): boolean;
/**
 * Canonical comparison key for an existing path, falling back to resolution.
 * @param path - path to canonicalize.
 * @returns the real path when it exists, otherwise the resolved absolute path.
 */
export declare function canonicalPath(path: string): string;
/**
 * Sanitize a directory name into the accepted alphabet.
 * @param value - raw name derived from a URL or directory.
 * @returns a non-empty safe directory name.
 */
export declare function sanitizeDirectoryName(value: string): string;
