/**
 * Promisified `execFile` with a captured stdout/stderr pair.
 *
 * The install and update paths never use a shell, so this is the only child
 * process helper they need outside the streaming clone.
 *
 * @module dsh-skills-manager/process
 */
import { execFile } from 'node:child_process';
/**
 * Run one command without a shell and resolve its captured output.
 * @param command - executable name or absolute path.
 * @param args - argument array, passed verbatim.
 * @param options - optional working directory and timeout.
 * @returns the captured stdout and stderr.
 */
export function execFileAsync(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, [...args], {
            cwd: options.cwd,
            timeout: options.timeout,
            maxBuffer: 4 * 1024 * 1024,
            encoding: 'utf8',
        }, (error, stdout, stderr) => {
            if (error === null) {
                resolve({ stdout, stderr });
                return;
            }
            Object.assign(error, { stdout, stderr });
            reject(error);
        });
    });
}
//# sourceMappingURL=process.js.map