import { mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve, relative } from 'node:path';

export interface SourceFileInput {
  id: string;
  label: string;
  content: string;
}

export class WorkspaceManager {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  createRunWorkspace(deliberationId: string, runId: string): string {
    const path = this.resolveRunWorkspace(deliberationId, runId);
    mkdirSync(join(path, 'sources'), { recursive: true });
    mkdirSync(join(path, 'scratch'), { recursive: true });
    return path;
  }

  resolveRunWorkspace(deliberationId: string, runId: string): string {
    return resolve(this.root, deliberationId, runId);
  }

  writeSources(workspacePath: string, sources: SourceFileInput[]): void {
    for (const source of sources) {
      const safeName = source.id.replace(/[^a-zA-Z0-9._-]/g, '_');
      const extension = source.content.trimStart().startsWith('{') ? '.json' : '.txt';
      writeFileSync(join(workspacePath, 'sources', `${safeName}${extension}`), source.content, 'utf8');
    }
  }

  writeRunInput(workspacePath: string, fileName: string, content: string): string {
    const filePath = join(workspacePath, fileName);
    writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  /**
   * Isolation proof: every workspace must be a distinct directory and no
   * workspace may be an ancestor of another.
   */
  assertIsolation(workspacePaths: string[]): void {
    const normalized = workspacePaths.map((path) => normalize(resolve(path)));
    for (let i = 0; i < normalized.length; i++) {
      for (let j = 0; j < normalized.length; j++) {
        if (i === j) continue;
        const rel = relative(normalized[i], normalized[j]);
        if (!rel.startsWith('..') && rel !== '' && !relative(normalized[j], normalized[i]).startsWith('..')) {
          throw new Error(`Workspace isolation violated: ${normalized[i]} and ${normalized[j]} overlap`);
        }
      }
    }
  }
}
