/**
 * The processing worker.
 *
 * Everything expensive happens here so the main thread stays responsive on a
 * 40 MB PDF. It is also a useful boundary to point at: the worker imports the
 * engine and nothing else, and the engine has no I/O surface, so there is no
 * code in this file's dependency graph that could send a file anywhere.
 */

import { clean, inspect, summarise, type CleanOptions } from '@unmarkk/core';

export interface WorkerRequest {
  readonly id: number;
  readonly action: 'inspect' | 'clean';
  readonly filename: string;
  readonly data: ArrayBuffer;
  readonly options: CleanOptions;
}

/**
 * `self` inside a worker is a `DedicatedWorkerGlobalScope`, but the DOM lib
 * types it as `Window`, whose `postMessage` has a different signature and no
 * transfer-list overload. The alias restores the real shape.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;

/**
 * `Omit` over a union collapses it to the keys the members share, which would
 * erase `residual` and `degraded` from the binary result. Distributing over the
 * union first keeps each member's own shape.
 */
type OmitDistributive<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type WorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly action: 'inspect';
      readonly report: Awaited<ReturnType<typeof inspect>>;
      readonly verdict: ReturnType<typeof summarise>;
    }
  | {
      readonly id: number;
      readonly ok: true;
      readonly action: 'clean';
      readonly output: ArrayBuffer;
      readonly result: OmitDistributive<Awaited<ReturnType<typeof clean>>, 'output'>;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  void (async () => {
    try {
      const bytes = new Uint8Array(request.data);
      const options = { ...request.options, filename: request.filename };

      if (request.action === 'inspect') {
        const report = await inspect(bytes, { ...options, stylometry: true });
        const response: WorkerResponse = {
          id: request.id,
          ok: true,
          action: 'inspect',
          report,
          verdict: summarise(report),
        };
        scope.postMessage(response);
        return;
      }

      const result = await clean(bytes, options);
      const { output, ...rest } = result;
      // The buffer is transferred rather than copied: a large file should not
      // exist twice in memory just to cross a thread boundary.
      const buffer = output.buffer.slice(
        output.byteOffset,
        output.byteOffset + output.byteLength,
      ) as ArrayBuffer;
      const response: WorkerResponse = {
        id: request.id,
        ok: true,
        action: 'clean',
        output: buffer,
        result: rest,
      };
      scope.postMessage(response, [buffer]);
    } catch (error) {
      const response: WorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(response);
    }
  })();
});
