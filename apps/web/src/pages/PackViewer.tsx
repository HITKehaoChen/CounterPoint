import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { DecisionPack } from '../../../../src/decision-pack.ts';
import { api } from '../api.ts';

export default function PackViewer() {
  const { id, roundId } = useParams();
  const activeId = id ?? roundId;
  const [pack, setPack] = useState<DecisionPack | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void api
      .decisionPack(activeId!)
      .then((result) => {
        if (!disposed) setPack(result.pack);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, [id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!pack) return <div className="loading">加载中…</div>;

  return (
    <div className="pack-viewer">
      <header className="pack-header">
        <h2>Decision Pack</h2>
        <div className="pack-actions">
          <a className="button" href={`/api/deliberations/${activeId}/decision-pack.md`} download>
            下载 Markdown
          </a>
          <a className="button" href={`/api/deliberations/${activeId}/decision-pack`} download>
            下载 JSON
          </a>
          <Link className="button" to={`/deliberations/${activeId}`}>
            返回控制台
          </Link>
        </div>
      </header>

      <section className="panel">
        <h3>任务包</h3>
        <p className="problem">{pack.taskPacket.problem}</p>
        <h4>目标</h4>
        <ul>
          {pack.taskPacket.goals.map((goal, index) => (
            <li key={index}>{goal}</li>
          ))}
        </ul>
        <h4>约束</h4>
        <ul>
          {pack.taskPacket.constraints.map((constraint, index) => (
            <li key={index}>{constraint}</li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h3>候选方案</h3>
        {pack.candidates.map((candidate) => (
          <article key={candidate.positionId} className="candidate-card">
            <h4>Candidate {candidate.label}</h4>
            <p>{candidate.summary}</p>
            <p className="muted">
              置信度 {candidate.confidence} · 承诺 {candidate.commitmentHash.slice(0, 16)}…
            </p>
            <ul>
              {candidate.claims.map((claim) => (
                <li key={claim.id}>
                  [{claim.type}] {claim.statement}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="panel">
        <h3>分歧矩阵</h3>
        <h4>共同结论</h4>
        <ul>
          {pack.divergence.sharedStatements.map((statement, index) => (
            <li key={index}>{statement}</li>
          ))}
        </ul>
        <h4>独有主张</h4>
        <ul>
          {pack.divergence.uniqueClaims.map((claim, index) => (
            <li key={index}>{claim.statement}</li>
          ))}
        </ul>
        <h4>未解决冲突</h4>
        {pack.divergence.unresolvedConflicts.length > 0 ? (
          <ul className="conflict-list">
            {pack.divergence.unresolvedConflicts.map((conflict, index) => (
              <li key={index}>⚠ {conflict}</li>
            ))}
          </ul>
        ) : (
          <p className="conflict-none">无未解决冲突。</p>
        )}
      </section>

      <section className="panel">
        <h3>质询与回复</h3>
        {pack.challenges.length === 0 && <p className="muted">无质询。</p>}
        {pack.challenges.map((challenge) => (
          <div key={challenge.id}>
            <p>
              <strong>{challenge.question}</strong>（{challenge.status}）
            </p>
            {challenge.response && <p className="muted">回复：{challenge.response.text}</p>}
          </div>
        ))}
      </section>

      <section className="panel">
        <h3>证据</h3>
        {pack.evidence.length === 0 && <p className="muted">无证据。</p>}
        {pack.evidence.map((evidence) => (
          <p key={evidence.id}>
            <span className={`status-tag status-${evidence.status}`}>{evidence.status}</span>{' '}
            {evidence.result.summary ?? '—'}
          </p>
        ))}
      </section>

      <section className="panel">
        <h3>评审</h3>
        {pack.reviews.length === 0 && <p className="muted">无评审。</p>}
        {pack.reviews.map((review) => (
          <article key={review.id}>
            <p>
              推荐：<strong>{review.recommendation}</strong>（{review.evidenceSufficiency}）
            </p>
            <p>{review.rationale}</p>
          </article>
        ))}
      </section>

      <section className="panel">
        <h3>决策</h3>
        {pack.decision ? (
          <article>
            <p>
              动作：<strong>{pack.decision.humanAction}</strong>
            </p>
            <p>{pack.decision.rationale}</p>
            {pack.decision.conditions.length > 0 && (
              <ul>
                {pack.decision.conditions.map((condition, index) => (
                  <li key={index}>{condition}</li>
                ))}
              </ul>
            )}
          </article>
        ) : (
          <p className="muted">尚未决策。</p>
        )}
      </section>

      <section className="panel">
        <h3>可追溯性</h3>
        <p>
          已解析引用 {pack.traceability.resolvedRefs.length} 条；未解析引用{' '}
          {pack.traceability.unresolvedRefs.length} 条。
        </p>
        {pack.traceability.unresolvedRefs.length > 0 && (
          <ul className="conflict-list">
            {pack.traceability.unresolvedRefs.map((ref) => (
              <li key={ref}>{ref}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
