/**
 * Request/response plumbing over the worker.
 *
 * The worker keeps parsing off the main thread, which matters once someone
 * drops a 40 MB PDF in. Everything else here is bookkeeping: tag each request,
 * resolve the matching reply.
 */

import UnmarkWorker from './worker.ts?worker';
import type { WorkerRequest, WorkerResponse } from './worker.js';

export class WorkerBridge {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (response: WorkerResponse) => void>();
  private nextId = 0;

  constructor() {
    this.worker = new UnmarkWorker();
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const resolve = this.pending.get(event.data.id);
      if (resolve === undefined) return;
      this.pending.delete(event.data.id);
      resolve(event.data);
    });
  }

  /** Send one request. The data buffer is transferred, not copied. */
  send(request: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ ...request, id } satisfies WorkerRequest, [request.data]);
    });
  }
}
