/**
 * Promisified `execFile` with a captured stdout/stderr pair.
 *
 * The install and update paths never use a shell, so this is the only child
 * process helper they need outside the streaming clone.
 *
 * @module dsh-skills-manager/process
 */
/** Result of one finished child process. */
export interface ExecResult {
    /** Decoded standard output. */
    readonly stdout: string;
    /** Decoded standard error. */
    readonly stderr: string;
}
/**
 * Run one command without a shell and resolve its captured output.
 * @param command - executable name or absolute path.
 * @param args - argument array, passed verbatim.
 * @param options - optional working directory and timeout.
 * @returns the captured stdout and stderr.
 */
export declare function execFileAsync(command: string, args: readonly string[], options?: {
    cwd?: string;
    timeout?: number;
}): Promise<ExecResult>;
