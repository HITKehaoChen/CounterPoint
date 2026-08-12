import { useState } from 'react';
import type { HumanView } from '../../../../src/human-view.ts';
import { api } from '../api.ts';
import { HumanGatePanel } from './HumanGatePanel.tsx';

export function DecisionPanel({
  view,
  refresh,
  onNotice,
}: {
  view: HumanView;
  refresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [escalateRationale, setEscalateRationale] = useState('');
  const [evidenceRationale, setEvidenceRationale] = useState('');
  const review = view.reviews[view.reviews.length - 1];
  const decision = view.decisions[view.decisions.length - 1];

  const submitDecision = async (payload: { action: string; rationale: string }) => {
    try {
      await api.humanDecision(view.deliberation.id, payload);
      onNotice('决策已记录');
      refresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const escalate = async () => {
    if (!escalateRationale.trim()) {
      onNotice('请填写升级理由');
      return;
    }
    try {
      await api.escalate(view.deliberation.id, escalateRationale);
      setEscalateRationale('');
      onNotice('已升级给人工 Owner');
      refresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const requestEvidence = async () => {
    if (!evidenceRationale.trim()) {
      onNotice('请填写补证理由');
      return;
    }
    try {
      await api.requestMoreEvidence(view.deliberation.id, evidenceRationale);
      setEvidenceRationale('');
      onNotice('已回到验证阶段请求补证');
      refresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="panel">
      <h3>Reviewer 评审</h3>
      {review ? (
        <article className="review-card">
          <p>
            推荐：<strong>{review.recommendation}</strong>（证据充分度：{review.evidenceSufficiency}）
          </p>
          <ul>
            {Object.entries(review.rubricScores).map(([itemId, score]) => (
              <li key={itemId}>
                {itemId}：{score}
              </li>
            ))}
          </ul>
          <p>{review.rationale}</p>
          {review.unresolvedRisks.length > 0 && (
            <ul>
              {review.unresolvedRisks.map((risk, index) => (
                <li key={index}>⚠ {risk}</li>
              ))}
            </ul>
          )}
        </article>
      ) : (
        <p className="muted">评审尚未提交。</p>
      )}

      <HumanGatePanel
        state={view.state}
        unresolvedConflicts={view.unresolvedConflicts}
        onSubmit={(payload) => void submitDecision(payload)}
      />

      {view.state === 'reviewing' && (
        <div className="gate-actions">
          <h4>升级</h4>
          <input
            aria-label="升级理由"
            value={escalateRationale}
            onChange={(event) => setEscalateRationale(event.target.value)}
            placeholder="升级理由"
          />
          <button className="button button-danger" onClick={() => void escalate()}>
            升级给人工 Owner
          </button>
          <h4>请求补证</h4>
          <input
            aria-label="补证理由"
            value={evidenceRationale}
            onChange={(event) => setEvidenceRationale(event.target.value)}
            placeholder="补证理由"
          />
          <button className="button" onClick={() => void requestEvidence()}>
            返回验证并请求补证
          </button>
        </div>
      )}

      {view.state === 'decided' && decision && (
        <article className="decision-record">
          <h3>决策记录</h3>
          <p>
            动作：<strong>{decision.humanAction}</strong>
          </p>
          <p>理由：{decision.rationale}</p>
          {decision.selectedRefs.length > 0 && (
            <p>选择引用：{decision.selectedRefs.join(', ')}</p>
          )}
          {decision.conditions.length > 0 && (
            <ul>
              {decision.conditions.map((condition, index) => (
                <li key={index}>条件：{condition}</li>
              ))}
            </ul>
          )}
          {decision.dissent.length > 0 && (
            <ul>
              {decision.dissent.map((item, index) => (
                <li key={index}>异议/保留风险：{item}</li>
              ))}
            </ul>
          )}
          <h4>未解决分歧（不会被摘要隐藏）</h4>
          {view.unresolvedConflicts.length > 0 ? (
            <ul className="conflict-list">
              {view.unresolvedConflicts.map((conflict, index) => (
                <li key={index}>⚠ {conflict}</li>
              ))}
            </ul>
          ) : (
            <p className="conflict-none">无未解决分歧。</p>
          )}
        </article>
      )}
    </section>
  );
}
