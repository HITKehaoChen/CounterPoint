import { hashJson } from './hashing.ts';
import type { Database, Event } from './schemas.ts';

export interface NewEvent {
  type: string;
  actor: string;
  objectRef?: string;
  payload?: unknown;
}

export function appendEvent(db: Database, input: NewEvent): Event {
  const last = db.events[db.events.length - 1];
  const event: Event = {
    id: `evt_${db.events.length + 1}_${Math.random().toString(36).slice(2, 10)}`,
    type: input.type,
    actor: input.actor,
    objectRef: input.objectRef,
    payload: input.payload ?? {},
    timestamp: new Date().toISOString(),
    previousHash: last ? hashJson(last) : undefined,
  };
  db.events.push(event);
  return event;
}

export function verifyEventChain(db: Database): boolean {
  let previousHash: string | undefined;
  for (const event of db.events) {
    if (event.previousHash !== previousHash) return false;
    previousHash = hashJson(event);
  }
  return true;
}
