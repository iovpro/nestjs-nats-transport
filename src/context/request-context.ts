import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContextStore {
  traceId: string;
  requestId?: string;
}

// Shared via globalThis so that duplicate copies of this package (e.g. `file:` link
// alongside a registry install) use the same storage. The store shape must stay
// compatible across versions that share this key.
const STORAGE_KEY = Symbol.for('nestjs-nats-transport:request-context');
const storage: AsyncLocalStorage<RequestContextStore> = ((globalThis as any)[STORAGE_KEY] ??=
  new AsyncLocalStorage<RequestContextStore>());

// Not exported from the public API: internal use only (e.g. ClientNats.connect).
// Uses run(undefined) instead of exit() because exit() is Stability 1 — Experimental.
export function runOutsideRequestContext<T>(fn: () => T): T {
  return storage.run(undefined as unknown as RequestContextStore, fn);
}

export const RequestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  getTraceId(): string | undefined {
    return storage.getStore()?.traceId;
  },

  getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};
