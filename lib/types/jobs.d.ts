/**
 * In-memory registry of asynchronous install and update jobs with a bounded
 * output log the Web Client polls.
 *
 * @module dsh-skills-manager/jobs
 */
import type { JobError, JobStatus, JobView } from './shared/api.js';
/** Mutable job record shared with the running task. */
export interface JobRecord {
    readonly id: string;
    status: JobStatus;
    error: JobError | null;
    log: string | null;
}
/** Job table for one plugin instance. */
export declare class JobRegistry {
    private readonly jobs;
    /**
     * Create a pending job.
     * @returns the new record, also visible to pollers.
     */
    create(): JobRecord;
    /**
     * Poll one job.
     * @param jobId - id returned by the accepted request.
     * @returns the polling view, or undefined for an unknown id.
     */
    view(jobId: string): JobView | undefined;
    /**
     * Append command output, keeping the newest characters.
     * @param job - job receiving the output.
     * @param chunk - decoded stdout or stderr text.
     */
    append(job: JobRecord, chunk: string): void;
    /**
     * Run one task and settle the job from its outcome, without awaiting it.
     * @param job - job created for the task.
     * @param task - the work; throwing settles the job as an error.
     * @returns the accepted-job envelope returned to the HTTP caller.
     */
    start(job: JobRecord, task: () => Promise<void>): {
        jobId: string;
    };
}
