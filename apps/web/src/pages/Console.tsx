import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDeliberation } from '../hooks/useDeliberation.ts';
import { api } from '../api.ts';
import { StateBadge } from '../components/StateBadge.tsx';
import { OverviewPanel } from '../components/OverviewPanel.tsx';
import { RunList } from '../components/RunList.tsx';
import { ArtifactsPanel } from '../components/ArtifactsPanel.tsx';
import { ClaimsPanel } from '../components/ClaimsPanel.tsx';
import { EvidencePanel } from '../components/EvidencePanel.tsx';
import { DecisionPanel } from '../components/DecisionPanel.tsx';
import { TimelinePanel } from '../components/TimelinePanel.tsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Runs' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'claims', label: 'Claims' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'decision', label: 'Decision' },
  { id: 'timeline', label: 'Timeline' },
];

export default function Console() {
  const { id, roundId } = useParams();
  const activeId = id ?? roundId;
  const { view, error, refresh } = useDeliberation(activeId);
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [notice, setNotice] = useState<string | null>(null);

  if (error) return <div className="error-banner">{error}</div>;
  if (!view) return <div className="loading">加载中…</div>;

  const showNotice = (message: string) => setNotice(message);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      setNotice(null);
      refresh();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const actions: Array<{ label: string; onClick: () => void }> = [];
  if (view.state === 'draft') {
    actions.push({
      label: '冻结任务包',
      onClick: () => void run('freeze', () => api.freeze(activeId!)),
    });
  }
  if (view.state === 'frozen') {
    actions.push({
      label: '启动盲态运行',
      onClick: () => void run('start', () => api.start(activeId!)),
    });
  }
  if (view.state === 'revealed' || view.state === 'challenging') {
    actions.push({
      label: '完成质询',
      onClick: () => void run('finalize', () => api.finalizeChallenges(activeId!)),
    });
  }
  if (view.state === 'verifying') {
    actions.push({
      label: '冻结证据包',
      onClick: () => void run('freeze-evidence', () => api.freezeEvidence(activeId!)),
    });
  }
  if (view.state === 'reviewing') {
    actions.push({
      label: '运行评审',
      onClick: () => void run('review', () => api.runReview(activeId!)),
    });
  }
  if (view.state === 'decided') {
    const packPath = view.deliberation.workItemId
      ? `/workspaces/${view.deliberation.projectId}/items/${view.deliberation.workItemId}/rounds/${activeId}/pack`
      : `/deliberations/${activeId}/pack`;
    actions.push({
      label: '查看 Decision Pack',
      onClick: () => navigate(packPath),
    });
  }

  return (
    <div className="console">
      <header className="console-header">
        <div className="console-title">
          <h2>{view.taskPacket.problem}</h2>
          <div className="console-meta">
            <StateBadge state={view.state} />
            <span className="muted">Deliberation {view.deliberation.id}</span>
            <Link className="link" to="/">
              ← 返回项目列表
            </Link>
          </div>
        </div>
        <div className="action-bar">
          {actions.map((action) => (
            <button key={action.label} className="button button-primary" onClick={action.onClick}>
              {action.label}
            </button>
          ))}
        </div>
      </header>
      {notice && <div className="notice">{notice}</div>}
      <nav className="tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'tab tab-active' : 'tab'}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'overview' && <OverviewPanel view={view} />}
        {tab === 'runs' && <RunList view={view} refresh={refresh} onNotice={showNotice} />}
        {tab === 'artifacts' && <ArtifactsPanel view={view} onNotice={showNotice} />}
        {tab === 'claims' && <ClaimsPanel view={view} refresh={refresh} onNotice={showNotice} />}
        {tab === 'evidence' && <EvidencePanel view={view} refresh={refresh} onNotice={showNotice} />}
        {tab === 'decision' && <DecisionPanel view={view} refresh={refresh} onNotice={showNotice} />}
        {tab === 'timeline' && <TimelinePanel view={view} onNotice={showNotice} />}
      </div>
    </div>
  );
}
