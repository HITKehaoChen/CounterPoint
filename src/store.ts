import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database } from './schemas.ts';
import { DatabaseSchema, emptyDatabase } from './schemas.ts';

export interface Store {
  load(): Database;
  save(db: Database): void;
}

export class InMemoryStore implements Store {
  private db: Database = emptyDatabase();

  load(): Database {
    return this.db;
  }

  save(db: Database): void {
    this.db = db;
  }
}

/**
 * Local-first JSON persistence (ADR-001 / ADR-003).
 * MVP stores the full database as one JSON document; artifact content is kept
 * in the same document so the whole system is recoverable and testable on one
 * machine. File layout:
 *
 *   data/store.json
 *   data/workspaces/<deliberationId>/<runId>/...
 *   data/logs/<deliberationId>/...
 */
export class JsonFileStore implements Store {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): Database {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = DatabaseSchema.parse(JSON.parse(raw));
      return parsed;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot load database from ${this.filePath}: ${cause}`);
    }
  }

  save(db: Database): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(db, null, 2), 'utf8');
    writeFileSync(this.filePath, JSON.stringify(db, null, 2), 'utf8');
    try {
      // Best-effort cleanup; failing to remove a temp file is not fatal.
      const { rmSync } = require('node:fs') as typeof import('node:fs');
      rmSync(temp, { force: true });
    } catch {
      // ignore
    }
  }
}

export function storeExists(store: Store): boolean {
  if (store instanceof JsonFileStore) {
    try {
      const { existsSync } = require('node:fs') as typeof import('node:fs');
      return existsSync((store as unknown as { filePath: string }).filePath);
    } catch {
      return false;
    }
  }
  return true;
}
