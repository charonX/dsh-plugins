/**
 * Typed failures and path identity rules shared by the manager's Host surface.
 *
 * @module dsh-skills-manager/errors
 */
/** Failure carrying the HTTP status and machine-readable code its route answers with. */
export declare class SkillManagerError extends Error {
    readonly status: number;
    readonly code: string;
    /**
     * @param status - HTTP status the route answers with.
     * @param code - machine-readable failure code.
     * @param message - human-readable message; callers may show it verbatim.
     */
    constructor(status: number, code: string, message: string);
}
