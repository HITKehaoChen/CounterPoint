import { useState } from 'react';
import type { HumanArtifact, HumanView } from '../../../../src/human-view.ts';
import type { DiffResult } from '../../../../src/artifact-registry.ts';
import { api } from '../api.ts';

export function ArtifactsPanel({
  view,
  onNotice,
}: {
  view: HumanView;
  onNotice: (message: string) => void;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffLabel, setDiffLabel] = useState('');

  const groups = new Map<string, HumanArtifact[]>();
  for (const artifact of view.artifacts) {
    const list = groups.get(artifact.logicalName) ?? [];
    list.push(artifact);
    groups.set(artifact.logicalName, list);
  }

  const compare = async (artifact: HumanArtifact) => {
    const versions = [...(groups.get(artifact.logicalName) ?? [])].sort(
      (a, b) => a.version - b.version,
    );
    if (versions.length < 2) return;
    const latest = versions[versions.length - 1];
    const previous = versions[versions.length - 2];
    try {
      const result = await api.artifactDiff(latest.ref, previous.ref);
      setDiff(result.diff);
      setDiffLabel(`${latest.ref} → ${previous.ref}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="panel">
      <h3>共享产物（Artifact Registry）</h3>
      {[...groups.entries()].map(([name, versions]) => (
        <div key={name} className="artifact-group">
          <h4>{name}</h4>
          <ul className="artifact-versions">
            {versions.map((artifact) => (
              <li key={artifact.ref}>
                <code>{artifact.ref}</code>
                <span className="muted">
                  {artifact.visibility} · {artifact.byteLength} 字节 ·{' '}
                  {artifact.contentHash.slice(0, 12)}…
                </span>
                {versions.length >= 2 && (
                  <button className="button button-small" onClick={() => void compare(artifact)}>
                    对比
                  </button>
                )}
              </li>
            ))}
          </ul>
          {versions.map((artifact) => (
            <div key={`content-${artifact.ref}`} className="artifact-content">
              <h5>{artifact.ref} 内容</h5>
              {artifact.content !== undefined ? (
                <pre>{artifact.content}</pre>
              ) : (
                <p className="muted">内容将在候选披露后可见。</p>
              )}
            </div>
          ))}
        </div>
      ))}
      {view.artifacts.length === 0 && <p className="muted">暂无共享产物。</p>}
      {diff && (
        <div className="diff-panel">
          <h4>
            Diff：{diffLabel}（+{diff.added} / -{diff.removed}）
          </h4>
          <pre className="diff-pre">
            {diff.hunks.map((hunk, index) => {
              const sign = hunk.type === 'add' ? '+' : hunk.type === 'remove' ? '-' : ' ';
              return (
                <div key={index} className={`diff-line diff-${hunk.type}`}>
                  {sign} {hunk.line}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </section>
  );
}
