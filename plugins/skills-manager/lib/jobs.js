/**
 * In-memory registry of asynchronous install and update jobs with a bounded
 * output log the Web Client polls.
 *
 * @module dsh-skills-manager/jobs
 */
import { randomUUID } from 'node:crypto';
import { SkillManagerError } from './errors.js';
/** Bytes of command output kept per job; older output is dropped first. */
const MAX_LOG_CHARS = 256 * 1024;
/** Job table for one plugin instance. */
export class JobRegistry {
    jobs = new Map();
    /**
     * Create a pending job.
     * @returns the new record, also visible to pollers.
     */
    create() {
        const job = {
            id: `skill-job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
            status: 'pending',
            error: null,
            log: null,
        };
        this.jobs.set(job.id, job);
        return job;
    }
    /**
     * Poll one job.
     * @param jobId - id returned by the accepted request.
     * @returns the polling view, or undefined for an unknown id.
     */
    view(jobId) {
        const job = this.jobs.get(jobId);
        if (job === undefined)
            return undefined;
        return { id: job.id, status: job.status, error: job.error, log: job.log };
    }
    /**
     * Append command output, keeping the newest characters.
     * @param job - job receiving the output.
     * @param chunk - decoded stdout or stderr text.
     */
    append(job, chunk) {
        const next = (job.log ?? '') + chunk;
        job.log = next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next;
    }
    /**
     * Run one task and settle the job from its outcome, without awaiting it.
     * @param job - job created for the task.
     * @param task - the work; throwing settles the job as an error.
     * @returns the accepted-job envelope returned to the HTTP caller.
     */
    start(job, task) {
        job.status = 'running';
        void task().then(() => {
            job.status = 'success';
            job.error = null;
        }, (error) => {
            job.status = 'error';
            job.error = toJobError(error);
        });
        return { jobId: job.id };
    }
}
function toJobError(error) {
    if (error instanceof SkillManagerError)
        return { code: error.code, message: error.message };
    if (error instanceof Error)
        return { code: 'SKILL_JOB_FAILED', message: error.message };
    return { code: 'SKILL_JOB_FAILED', message: String(error) };
}
//# sourceMappingURL=jobs.js.map