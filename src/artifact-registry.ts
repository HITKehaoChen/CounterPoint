import type {
  Artifact,
  ArtifactType,
  ArtifactVersion,
  Database,
} from './schemas.ts';
import { formatVersionRef, hashJson, parseVersionRef, sha256 } from './hashing.ts';
import { newId } from './ids.ts';

export interface PublishArtifactInput {
  logicalName: string;
  type: ArtifactType;
  content: string;
  ownerRunId?: string;
  visibility?: 'private' | 'shared' | 'review';
  dependencies?: string[];
}

export interface ResolvedArtifactVersion {
  version: ArtifactVersion;
  content: string;
  ref: string;
}

export interface DiffResult {
  aRef: string;
  bRef: string;
  kind: 'text' | 'binary' | 'none';
  added: number;
  removed: number;
  hunks: Array<{ type: 'add' | 'remove' | 'context'; line: string }>;
  metadata?: { hashA: string; hashB: string; lengthA: number; lengthB: number };
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Artifact Registry (PRD FR-030..033, ADR-004).
 *
 * Artifacts are immutable and content-addressed. Publishing under an existing
 * logical name always creates a new version; nobody can silently overwrite a
 * published version. References like `design@v2` never drift to a newer
 * version.
 */
export class ArtifactRegistry {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  publish(input: PublishArtifactInput): ResolvedArtifactVersion {
    const name = input.logicalName.trim();
    if (!NAME_RE.test(name)) {
      throw new Error(
        `Invalid artifact logical name "${name}": use lowercase letters, digits, dots, dashes or underscores.`,
      );
    }
    const contentHash = sha256(input.content);
    const existing = this.db.artifacts.find((artifact) => artifact.logicalName === name);
    const nextVersion = existing
      ? Math.max(
          ...this.db.artifactVersions
            .filter((version) => version.artifactId === existing.id)
            .map((version) => version.version),
        ) + 1
      : 1;

    const artifact: Artifact = existing ?? {
      id: newId('art'),
      logicalName: name,
      type: input.type,
      ownerRunId: input.ownerRunId,
      visibility: input.visibility ?? 'shared',
    };
    if (!existing) {
      this.db.artifacts.push(artifact);
    } else {
      // Versioned update: logical metadata may be clarified, but old versions
      // are untouched.
      const nextVisibility = input.visibility ?? artifact.visibility;
      if (artifact.visibility !== 'shared' && nextVisibility === 'shared') {
        throw new Error('VISIBILITY_WIDENING_FORBIDDEN');
      }
      artifact.type = input.type;
      artifact.ownerRunId = input.ownerRunId ?? artifact.ownerRunId;
      artifact.visibility = nextVisibility;
    }

    const contentRef = `content_${contentHash}`;
    this.db.artifactContents[contentRef] = input.content;
    const version: ArtifactVersion = Object.freeze({
      id: newId('av'),
      artifactId: artifact.id,
      version: nextVersion,
      contentHash,
      contentRef,
      sourceRunId: input.ownerRunId,
      dependencies: [...(input.dependencies ?? [])],
      createdAt: new Date().toISOString(),
      byteLength: Buffer.byteLength(input.content, 'utf8'),
      encoding: 'utf8',
    });
    this.db.artifactVersions.push(version);
    return {
      version,
      content: input.content,
      ref: formatVersionRef(name, nextVersion),
    };
  }

  getArtifact(logicalName: string): Artifact | undefined {
    return this.db.artifacts.find((artifact) => artifact.logicalName === logicalName);
  }

  getVersion(ref: string): ResolvedArtifactVersion | undefined {
    const parsed = parseVersionRef(ref);
    if (!parsed) return undefined;
    const artifact = this.db.artifacts.find((item) => item.logicalName === parsed.name);
    if (!artifact) return undefined;
    const version = this.db.artifactVersions.find(
      (item) => item.artifactId === artifact.id && item.version === parsed.version,
    );
    if (!version) return undefined;
    const content = this.db.artifactContents[version.contentRef];
    if (content === undefined) {
      throw new Error(`Artifact content missing for ${ref} (${version.contentRef})`);
    }
    return { version, content, ref };
  }

  latestVersion(logicalName: string): ResolvedArtifactVersion | undefined {
    const artifact = this.getArtifact(logicalName);
    if (!artifact) return undefined;
    const versions = this.db.artifactVersions
      .filter((version) => version.artifactId === artifact.id)
      .sort((a, b) => a.version - b.version);
    const latest = versions[versions.length - 1];
    if (!latest) return undefined;
    return this.getVersion(formatVersionRef(logicalName, latest.version));
  }

  list(): Array<{ artifact: Artifact; latestVersion: number; versionCount: number }> {
    return this.db.artifacts.map((artifact) => {
      const versions = this.db.artifactVersions.filter(
        (version) => version.artifactId === artifact.id,
      );
      return {
        artifact,
        latestVersion: versions.length ? Math.max(...versions.map((v) => v.version)) : 0,
        versionCount: versions.length,
      };
    });
  }

  diff(refA: string, refB: string): DiffResult {
    const a = this.getVersion(refA);
    const b = this.getVersion(refB);
    if (!a || !b) {
      throw new Error(`Cannot diff unknown refs: ${refA} -> ${refB}`);
    }
    const metadata = {
      hashA: a.version.contentHash,
      hashB: b.version.contentHash,
      lengthA: a.version.byteLength,
      lengthB: b.version.byteLength,
    };
    if (a.version.contentHash === b.version.contentHash) {
      return { aRef: refA, bRef: refB, kind: 'none', added: 0, removed: 0, hunks: [], metadata };
    }
    if (a.version.encoding === 'base64' || b.version.encoding === 'base64') {
      return { aRef: refA, bRef: refB, kind: 'binary', added: 0, removed: 0, hunks: [], metadata };
    }
    const linesA = a.content.split(/\r?\n/);
    const linesB = b.content.split(/\r?\n/);
    const diff = lineDiff(linesA, linesB);
    return {
      aRef: refA,
      bRef: refB,
      kind: 'text',
      added: diff.filter((entry) => entry.type === 'add').length,
      removed: diff.filter((entry) => entry.type === 'remove').length,
      hunks: diff,
      metadata,
    };
  }

  resolveDependencyChain(ref: string): string[] {
    const seen = new Set<string>();
    const chain: string[] = [];
    const visit = (current: string) => {
      if (seen.has(current)) return;
      seen.add(current);
      chain.push(current);
      const resolved = this.getVersion(current);
      for (const dependency of resolved?.version.dependencies ?? []) {
        visit(dependency);
      }
    };
    visit(ref);
    return chain;
  }

  assertNoDrift(ref: string): ResolvedArtifactVersion {
    const resolved = this.getVersion(ref);
    if (!resolved) throw new Error(`Unresolvable artifact ref: ${ref}`);
    return resolved;
  }
}

function lineDiff(a: string[], b: string[]): DiffResult['hunks'] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks: DiffResult['hunks'] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      hunks.push({ type: 'context', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      hunks.push({ type: 'remove', line: a[i] });
      i++;
    } else {
      hunks.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) {
    hunks.push({ type: 'remove', line: a[i] });
    i++;
  }
  while (j < m) {
    hunks.push({ type: 'add', line: b[j] });
    j++;
  }
  return hunks;
}

export function artifactCommitmentPayload(ref: string, version: ArtifactVersion): unknown {
  return {
    ref,
    contentHash: version.contentHash,
    dependencies: version.dependencies,
    sourceRunId: version.sourceRunId ?? null,
  };
}

export function hashContent(content: string): string {
  return hashJson({ content });
}
