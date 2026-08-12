import { useState } from 'react';
import type { HumanChallenge, HumanView } from '../../../../src/human-view.ts';
import { api } from '../api.ts';
import { CandidateView } from './CandidateView.tsx';

export function ClaimsPanel({
  view,
  refresh,
  onNotice,
}: {
  view: HumanView;
  refresh: () => void;
  onNotice: (message: string) => void;
}) {
  const revealed = !['draft', 'frozen', 'blind_run', 'committed'].includes(view.state);
  const canChallenge = ['revealed', 'challenging'].includes(view.state);
  const [targetRef, setTargetRef] = useState('');
  const [authorRunId, setAuthorRunId] = useState('');
  const [question, setQuestion] = useState('');
  const [requestedEvidence, setRequestedEvidence] = useState('');

  const participantLabel = (participantId: string) =>
    view.participants.find((participant) => participant.id === participantId)?.label ??
    participantId;

  const runForPosition = (positionId: string) =>
    view.runs.find((run) => run.positionId === positionId);

  const claimOptions = view.positions.flatMap((position) =>
    position.claims.map((claim) => ({
      value: `claim:${claim.id}`,
      label: `${position.label} · ${claim.statement}`,
    })),
  );
  const authorOptions = view.runs
    .filter((run) => run.status === 'committed')
    .map((run) => ({ value: run.id, label: participantLabel(run.participantId) }));

  const submitChallenge = async () => {
    if (!targetRef || !authorRunId || !question.trim()) {
      onNotice('请选择目标主张、发起方并填写质询内容');
      return;
    }
    try {
      await api.createChallenge(view.deliberation.id, {
        targetRef,
        authorRunId,
        question,
        requestedEvidence: requestedEvidence.trim() || undefined,
      });
      setQuestion('');
      setRequestedEvidence('');
      onNotice('质询已创建');
      refresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const respond = async (challenge: HumanChallenge, text: string) => {
    const claimId = challenge.targetRef.startsWith('claim:')
      ? challenge.targetRef.slice('claim:'.length)
      : '';
    const position = view.positions.find((item) => item.claims.some((claim) => claim.id === claimId));
    const targetRun = position ? runForPosition(position.id) : undefined;
    const runId = targetRun?.id ?? authorOptions[0]?.value;
    if (!runId || !text.trim()) {
      onNotice('无法确定被质询方，或回复为空');
      return;
    }
    try {
      await api.respondChallenge(challenge.id, { authorRunId: runId, text });
      onNotice('回复已提交');
      refresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="panel">
      <h3>候选与主张</h3>
      <CandidateView positions={view.positions} revealed={revealed} />

      {canChallenge && (
        <div className="challenge-form">
          <h4>发起定向质询</h4>
          <div className="form-row">
            <label>
              目标主张
              <select value={targetRef} onChange={(event) => setTargetRef(event.target.value)}>
                <option value="">请选择</option>
                {claimOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              发起方
              <select value={authorRunId} onChange={(event) => setAuthorRunId(event.target.value)}>
                <option value="">请选择</option>
                {authorOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              质询内容
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                rows={3}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              要求补证（可选）
              <input
                value={requestedEvidence}
                onChange={(event) => setRequestedEvidence(event.target.value)}
              />
            </label>
          </div>
          <button className="button button-primary" onClick={() => void submitChallenge()}>
            创建质询
          </button>
        </div>
      )}

      <h4>质询与回复</h4>
      {view.challenges.length === 0 && <p className="muted">暂无质询。</p>}
      {view.challenges.map((challenge) => (
        <article key={challenge.id} className="challenge-card">
          <div className="challenge-head">
            <strong>{challenge.question}</strong>
            <span className="muted">
              目标 {challenge.targetRef} · 发起方{' '}
              {challenge.author.candidateLabel ?? challenge.author.role} ·{' '}
              {challenge.status}
            </span>
          </div>
          {view.responses
            .filter((response) => response.challengeId === challenge.id)
            .map((response) => (
              <p key={response.createdAt} className="challenge-response">
                回复（{response.author.candidateLabel ?? response.author.role}）：{response.text}
                {response.concession && '（让步）'}
              </p>
            ))}
          {challenge.status !== 'answered' && (
            <ChallengeRespondForm challenge={challenge} onRespond={(text) => void respond(challenge, text)} />
          )}
        </article>
      ))}
    </section>
  );
}

function ChallengeRespondForm({
  challenge,
  onRespond,
}: {
  challenge: HumanChallenge;
  onRespond: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="respond-form">
      <textarea
        aria-label={`回复 ${challenge.question}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        placeholder="回复内容"
      />
      <button className="button" onClick={() => onRespond(text)}>
        提交回复
      </button>
    </div>
  );
}
