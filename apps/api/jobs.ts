import { newId } from '../../src/ids.ts';

export interface Job {
  id: string;
  kind: string;
  deliberationId?: string;
  status: 'running' | 'done' | 'failed';
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * In-memory background job registry. Jobs run in the API process; on server
 * restart they are lost and the affected deliberation can be retried
 * (FR-014). State is never authoritative here - the engine's store is.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  start(
    kind: string,
    deliberationId: string | undefined,
    fn: () => Promise<unknown> | unknown,
  ): Job {
    const job: Job = {
      id: newId('job'),
      kind,
      deliberationId,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    void Promise.resolve()
      .then(() => fn())
      .then(
        () => {
          job.status = 'done';
          job.finishedAt = new Date().toISOString();
        },
        (error: unknown) => {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : String(error);
          job.finishedAt = new Date().toISOString();
        },
      );
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }
}
