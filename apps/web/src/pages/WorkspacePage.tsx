import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Project } from '../../../../src/schemas.ts';
import type { HumanWorkItemBoard, WorkspaceKnowledge } from '../../../../src/human-view.ts';
import { api } from '../api.ts';
import { StateBadge } from '../components/StateBadge.tsx';

const KIND_LABELS: Record<string, string> = {
  problem: '问题',
  requirement: '需求',
  bug: 'Bug',
  hypothesis: '假设',
  decision: '技术决策',
};

const STATUS_LABELS: Record<string, string> = {
  open: '开放',
  investigating: '调查中',
  resolved: '已解决',
  rejected: '已拒绝',
  needs_evidence: '需要证据',
};

export default function WorkspacePage() {
  const { id } = useParams();
  const [workspace, setWorkspace] = useState<Project | null>(null);
  const [board, setBoard] = useState<HumanWorkItemBoard | null>(null);
  const [knowledge, setKnowledge] = useState<WorkspaceKnowledge | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [projectResult, boardResult] = await Promise.all([
        api.getProject(id!),
        api.listWorkItems(id!),
      ]);
      const knowledgeResult = await api.workspaceKnowledge(id!).catch(() => null);
      setWorkspace(projectResult.project);
      setBoard(boardResult.board);
      setKnowledge(knowledgeResult?.knowledge ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, [id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!workspace || !board) return <div className="loading">加载中…</div>;

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div>
          <h2>{workspace.name}</h2>
          {workspace.description && <p className="muted">{workspace.description}</p>}
        </div>
        <Link className="button button-primary" to={`/workspaces/${id}/items/new`}>
          新建工作项
        </Link>
      </header>

      {Object.entries(board.groups).map(([kind, items]) => (
        <section key={kind} className="panel">
          <h3>
            {KIND_LABELS[kind] ?? kind}
            <span className="muted">（{items.length}）</span>
          </h3>
          {items.length === 0 && <p className="muted">暂无。</p>}
          <ul className="work-item-list">
            {items.map((item) => (
              <li key={item.id}>
                <Link to={`/workspaces/${id}/items/${item.id}`}>{item.title}</Link>
                <span className={`status-tag status-${item.status}`}>
                  {STATUS_LABELS[item.status] ?? item.status}
                </span>
                <span className="muted">
                  {item.roundCount} 轮研究 · {new Date(item.updatedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="panel">
        <h3>决策档案</h3>
        {Object.values(board.groups)
          .flat()
          .filter((item) => item.status === 'resolved')
          .map((item) => (
            <p key={item.id}>
              <Link to={`/workspaces/${id}/items/${item.id}`}>{item.title}</Link>
              <span className="muted"> · 已解决 · {item.roundCount} 轮研究</span>
            </p>
          ))}
        {!Object.values(board.groups).flat().some((item) => item.status === 'resolved') && (
          <p className="muted">暂无已决策的工作项。</p>
        )}
      </section>

      <section className="panel">
        <h3>知识</h3>
        <h4>已提升主张（Promoted Claims）</h4>
        {knowledge?.promotedClaims.length ? (
          <ul>
            {knowledge.promotedClaims.map((claim) => (
              <li key={claim.claimId}>
                {claim.statement}
                <span className="muted">（{claim.workItemTitle}）</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">暂无已提升主张。</p>
        )}
        <h4>知识引用（Scoped Refs）</h4>
        {knowledge?.knowledgeRefs.length ? (
          <ul>
            {knowledge.knowledgeRefs.map((item) => (
              <li key={`${item.workItemId}-${item.ref.ref}`}>
                <code>{item.ref.ref}</code>
                <span className="muted">
                  （{item.ref.scope} · {item.ref.status}
                  {item.ref.appliesWhen ? ` · 适用：${item.ref.appliesWhen}` : ''}）
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">暂无知识引用。</p>
        )}
      </section>
    </div>
  );
}
