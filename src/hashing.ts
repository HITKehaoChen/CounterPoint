import { createHash } from 'node:crypto';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashJson(value: unknown): string {
  return sha256(canonicalStringify(value));
}

export interface VersionRef {
  name: string;
  version: number;
}

const VERSION_REF_RE = /^([a-z0-9][a-z0-9._-]*)@v(\d+)$/;

export function parseVersionRef(ref: string): VersionRef | undefined {
  const match = VERSION_REF_RE.exec(ref);
  if (!match) return undefined;
  const version = Number(match[2]);
  if (version < 1) return undefined;
  return { name: match[1], version };
}

export function formatVersionRef(name: string, version: number): string {
  return `${name}@v${version}`;
}
