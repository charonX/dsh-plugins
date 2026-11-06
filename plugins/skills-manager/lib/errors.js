/**
 * Typed failures and path identity rules shared by the manager's Host surface.
 *
 * @module dsh-skills-manager/errors
 */
/** Failure carrying the HTTP status and machine-readable code its route answers with. */
export class SkillManagerError extends Error {
    status;
    code;
    /**
     * @param status - HTTP status the route answers with.
     * @param code - machine-readable failure code.
     * @param message - human-readable message; callers may show it verbatim.
     */
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'SkillManagerError';
    }
}
//# sourceMappingURL=errors.js.map