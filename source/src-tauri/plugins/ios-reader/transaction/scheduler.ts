export interface RequestContext { id: string; generation: number; priority: number; deadline: number; authentication?: boolean }
interface Job { context: RequestContext; write: boolean; sent: boolean; key: string; run: (signal: AbortSignal, sent: () => void) => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void; controller: AbortController; timer: ReturnType<typeof setTimeout> }
const cancelled = () => new Error('Request cancelled or expired.');

/** One provider request at a time; deadlines include time spent waiting. */
export class RequestScheduler {
  private jobs: Job[] = [];
  private active: Job | null = null;
  private reads = new Map<string, Promise<unknown>>();
  enqueue<T>(context: RequestContext, write: boolean, key: string, run: (signal: AbortSignal, sent: () => void) => Promise<T>): Promise<T> {
    // A resumed identity check must never join the aborted check's promise.
    // Ordinary account reads still coalesce across their identical callers.
    const readKey = `${context.generation}:${context.authentication ? `login:${context.id}` : 'read'}:${key}`;
    if (!write && this.reads.has(readKey)) {
      const queued = this.jobs.find(job => job.key === readKey);
      if (queued) queued.context.priority = Math.min(queued.context.priority, context.priority);
      return this.reads.get(readKey)! as Promise<T>;
    }
    if (context.deadline <= Date.now() || this.jobs.length >= 64) return Promise.reject(cancelled());
    const promise = new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const job: Job = { context, write, sent: false, key: readKey, run, resolve: value => resolve(value as T), reject, controller,
        timer: setTimeout(() => {
          controller.abort();
          this.jobs = this.jobs.filter(value => value !== job);
          reject(cancelled());
        }, Math.min(75000, context.deadline - Date.now())) };
      this.jobs.push(job);
      // Batch synchronous enqueues so an interactive request can overtake prefetch.
      queueMicrotask(() => void this.drain());
    });
    if (!write) {
      this.reads.set(readKey, promise);
      void promise.finally(() => { if (this.reads.get(readKey) === promise) this.reads.delete(readKey); }).catch(() => {});
    }
    return promise;
  }
  cancel(id?: string, all = false, beforeGeneration = Infinity) {
    for (const job of [...this.jobs]) {
      if ((id ? job.context.id === id : job.context.generation < beforeGeneration && (all || (!job.write && !job.context.authentication)))) {
        clearTimeout(job.timer); job.controller.abort(); job.reject(cancelled());
        this.jobs = this.jobs.filter(value => value !== job);
      }
    }
    if (this.active && (id ? this.active.context.id === id : this.active.context.generation < beforeGeneration && ((!this.active.write && (all || !this.active.context.authentication)) || (all && !this.active.sent)))) this.active.controller.abort();
  }
  private async drain() {
    if (this.active) return;
    this.jobs.sort((a,b) => a.context.priority - b.context.priority);
    const job = this.jobs.shift();
    if (!job) return;
    this.active = job;
    try {
      if (job.controller.signal.aborted || Date.now() >= job.context.deadline) throw cancelled();
      const result = await job.run(job.controller.signal, () => { job.sent = true; });
      if (job.controller.signal.aborted || Date.now() >= job.context.deadline) throw cancelled();
      job.resolve(result);
    } catch (error) { job.reject(error instanceof Error ? error : cancelled()); }
    finally { clearTimeout(job.timer); this.active = null; void this.drain(); }
  }
}
