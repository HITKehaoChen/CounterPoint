import { useState } from 'react';
import type { HumanView } from '../../../../src/human-view.ts';
import { api } from '../api.ts';

const EVIDENCE_STATUS: Record<string, { label: string; icon: string }> = {
  pending: { label: '待验证', icon: '○' },
  verified: { label: '已验证', icon: '✓' },
  failed: { label: '失败', icon: '✕' },
  inconclusive: { label: '无法判定', icon: '!' },
  superseded: { label: '已被替代', icon: '↗' },
};

export function EvidencePanel({
  view,
  refresh,
  onNotice,
}: {
  view: HumanView;
  refresh: () => void;
  onNotice: (message: string) => void;
}) {
  const claimRefs = view.claims.map((claim) => `claim:${claim.id}`);
  const targetOptions = [...claimRefs, ...view.artifacts.map((artifact) => artifact.ref)];
  const [verifyForm, setVerifyForm] = useState({
    command: 'node',
    args: '',
    description: '',
    targetRef: targetOptions[0] ?? '',
  });
  const [manualForm, setManualForm] = useState({
    status: 'verified',
    resultSummary: '',
    sourceDescription: '',
    targetRefs: '',
  });

  const submitVerify = async () => {
    if (!verifyForm.targetRef || !verifyForm.command.trim()) {
      onNotice('请填写命令与目标引用');
      return;
    }
    try {
      await api.verify(view.deliberation.id, {
        command: verifyForm.command.trim(),
        args: verifyForm.args.split(/\s+/).filter(Boolean),
        targetRefs: [verifyForm.targetRef],
        description: verifyForm.description.trim() || undefined,
      });
      onNotice('验证任务已提交');
      refresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const submitManual = async () => {
    const targetRefs = manualForm.targetRefs
      .split(',')
      .map((ref) => ref.trim())
      .filter(Boolean);
    if (!targetRefs.length || !manualForm.resultSummary.trim()) {
      onNotice('人工证据需要目标引用与结果摘要');
      return;
    }
    try {
      await api.addEvidence(view.deliberation.id, {
        targetRefs,
        status: manualForm.status,
        resultSummary: manualForm.resultSummary,
        sourceDescription: manualForm.sourceDescription.trim() || undefined,
      });
      setManualForm({ ...manualForm, resultSummary: '', sourceDescription: '', targetRefs: '' });
      onNotice('人工证据已记录');
      refresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="panel">
      <h3>证据台账（Evidence Ledger）</h3>
      <table className="evidence-table">
        <thead>
          <tr>
            <th>状态</th>
            <th>类型</th>
            <th>目标</th>
            <th>摘要</th>
            <th>可复现性</th>
          </tr>
        </thead>
        <tbody>
          {view.evidence.map((evidence) => {
            const meta = EVIDENCE_STATUS[evidence.status] ?? { label: evidence.status, icon: '?' };
            return (
              <tr key={evidence.id}>
                <td>
                  <span className={`status-tag status-${evidence.status}`}>
                    <span aria-hidden="true">{meta.icon}</span> {meta.label}
                  </span>
                </td>
                <td>{evidence.kind}</td>
                <td>
                  <code>{evidence.targetRefs.join(', ')}</code>
                </td>
                <td>{evidence.result.summary ?? '—'}</td>
                <td>{evidence.reproducibility ?? 'unknown'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {view.evidence.length === 0 && <p className="muted">暂无证据。</p>}

      {view.state === 'verifying' && (
        <>
          <h4>运行命令验证器</h4>
          <div className="form-row">
            <label>
              命令
              <input
                value={verifyForm.command}
                onChange={(event) => setVerifyForm({ ...verifyForm, command: event.target.value })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              参数（空格分隔）
              <input
                value={verifyForm.args}
                onChange={(event) => setVerifyForm({ ...verifyForm, args: event.target.value })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              说明
              <input
                value={verifyForm.description}
                onChange={(event) =>
                  setVerifyForm({ ...verifyForm, description: event.target.value })
                }
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              目标引用
              <select
                value={verifyForm.targetRef}
                onChange={(event) => setVerifyForm({ ...verifyForm, targetRef: event.target.value })}
              >
                {targetOptions.map((ref) => (
                  <option key={ref} value={ref}>
                    {ref}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="button button-primary" onClick={() => void submitVerify()}>
            运行验证
          </button>

          <h4>录入人工证据</h4>
          <div className="form-row">
            <label>
              状态
              <select
                value={manualForm.status}
                onChange={(event) => setManualForm({ ...manualForm, status: event.target.value })}
              >
                {['verified', 'failed', 'inconclusive'].map((status) => (
                  <option key={status} value={status}>
                    {EVIDENCE_STATUS[status].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              结果摘要
              <textarea
                value={manualForm.resultSummary}
                onChange={(event) =>
                  setManualForm({ ...manualForm, resultSummary: event.target.value })
                }
                rows={3}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              目标引用（逗号分隔）
              <input
                value={manualForm.targetRefs}
                onChange={(event) => setManualForm({ ...manualForm, targetRefs: event.target.value })}
                placeholder="claim:id, design-a@v1"
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              来源说明
              <input
                value={manualForm.sourceDescription}
                onChange={(event) =>
                  setManualForm({ ...manualForm, sourceDescription: event.target.value })
                }
              />
            </label>
          </div>
          <button className="button" onClick={() => void submitManual()}>
            记录人工证据
          </button>
        </>
      )}
    </section>
  );
}
