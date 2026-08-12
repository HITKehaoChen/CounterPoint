import type { Event } from '../../src/schemas.ts';
import type { RunUpdate } from '../../src/protocol-engine.ts';

export type BusMessage =
  | { type: 'event'; event: Event }
  | { type: 'run.update'; update: RunUpdate };

export interface EventBus {
  subscribe(listener: (message: BusMessage) => void): () => void;
  publish(message: BusMessage): void;
}

/** In-process pub/sub used by the SSE stream (single-user, local-first). */
export function createEventBus(): EventBus {
  const listeners = new Set<(message: BusMessage) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(message) {
      for (const listener of [...listeners]) listener(message);
    },
  };
}
