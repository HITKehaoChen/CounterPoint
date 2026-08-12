import type { HumanPosition } from '../../../../src/human-view.ts';

export function CandidateView({
  positions,
  revealed,
}: {
  positions: HumanPosition[];
  revealed: boolean;
}) {
  if (!revealed) {
    return (
      <div className="candidate-locked" role="status">
        候选正文将在全部 Worker 提交并披露后展示。
      </div>
    );
  }
  return (
    <div className="candidate-list">
      {positions.map((position) => (
        <article key={position.id} className="candidate-card">
          <h3>{position.label}</h3>
          <p className="candidate-summary">{position.summary}</p>
          <dl className="candidate-meta">
            <div>
              <dt>置信度</dt>
              <dd>{position.confidence.toFixed(2)}</dd>
            </div>
            <div>
              <dt>承诺哈希</dt>
              <dd>
                <code>{position.commitmentHash.slice(0, 16)}…</code>
              </dd>
            </div>
          </dl>
          <h4>主张（Claims）</h4>
          <ul className="claim-list">
            {position.claims.map((claim) => (
              <li key={claim.id}>
                <span className={`claim-type claim-type-${claim.type}`}>{claim.type}</span>
                <span>{claim.statement}</span>
                {claim.confidence !== undefined && (
                  <span className="claim-confidence">置信度 {claim.confidence.toFixed(2)}</span>
                )}
                {claim.evidenceRefs.length > 0 && (
                  <span className="claim-evidence">证据：{claim.evidenceRefs.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
          {position.unknowns.length > 0 && (
            <>
              <h4>未知项</h4>
              <ul>
                {position.unknowns.map((unknown, index) => (
                  <li key={index}>{unknown}</li>
                ))}
              </ul>
            </>
          )}
          {position.decisionConditions.length > 0 && (
            <>
              <h4>决策条件</h4>
              <ul>
                {position.decisionConditions.map((condition, index) => (
                  <li key={index}>{condition}</li>
                ))}
              </ul>
            </>
          )}
        </article>
      ))}
    </div>
  );
}
