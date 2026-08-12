import { useState } from 'react';
import type { HumanRun, HumanView } from '../../../../src/human-view.ts';
import { api } from '../api.ts';

const STATUS_META: Record<string, { label: string; icon: string }> = {
  pending: { label: '等待', icon: '○' },
  running: { label: '运行中', icon: '▶' },
  committed: { label: '已提交', icon: '✓' },
  failed: { label: '失败', icon: '✕' },
  timed_out: { label: '超时', icon: '!' },
  cancelled: { label: '已取消', icon: '−' },
};

export function RunList({
  view,
  refresh,
  onNotice,
}: {
  view: HumanView;
  refresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [contextView, setContextView] = useState<unknown>(null);

  const participantLabel = (participantId: string) =>
    view.participants.find((participant) => participant.id === participantId)?.label ??
    participantId;

  const toggleContextView = async (run: HumanRun) => {
    if (expanded === run.id) {
      setExpanded(null);
      return;
    }
    try {
      const result = await api.contextViews(view.deliberation.id, run.id);
      setContextView(result.contextViews[0]);
      setExpanded(run.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const cancel = async (run: HumanRun) => {
    try {
      await api.cancelRun(view.deliberation.id, run.id);
      onNotice(`已取消 ${run.id}`);
      refresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="run-list">
      {view.runs.map((run) => {
        const meta = STATUS_META[run.status] ?? { label: run.status, icon: '?' };
        return (
          <article key={run.id} className="run-card">
            <div className="run-card-head">
              <span className={`status-tag status-${run.status}`}>
                <span aria-hidden="true">{meta.icon}</span> {meta.label}
              </span>
              <strong>{participantLabel(run.participantId)}</strong>
              <span className="muted">{run.phase}</span>
            </div>
            <dl className="run-meta">
              <div>
                <dt>Run</dt>
                <dd>
                  <code>{run.id}</code>
                </dd>
              </div>
              <div>
                <dt>启动</dt>
                <dd>{run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}</dd>
              </div>
              <div>
                <dt>结束</dt>
                <dd>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}</dd>
              </div>
              <div>
                <dt>成本</dt>
                <dd>{run.cost ?? 0}</dd>
              </div>
            </dl>
            {run.error && <p className="run-error">错误：{run.error}</p>}
            {view.state !== 'blind_run' && view.state !== 'committed' && run.fingerprint && (
              <details>
                <summary>Fingerprint</summary>
                <pre>{JSON.stringify(run.fingerprint, null, 2)}</pre>
              </details>
            )}
            <div className="run-actions">
              <button className="button" onClick={() => void toggleContextView(run)}>
                {expanded === run.id ? '收起 Context View' : '查看 Context View'}
              </button>
              {(run.status === 'pending' || run.status === 'running') && (
                <button className="button button-danger" onClick={() => void cancel(run)}>
                  取消运行
                </button>
              )}
            </div>
            {expanded === run.id && (
              <pre className="context-view">{JSON.stringify(contextView, null, 2)}</pre>
            )}
          </article>
        );
      })}
    </div>
  );
}
