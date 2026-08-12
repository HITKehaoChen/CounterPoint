import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { HumanWorkItemEntry, HumanWorkItemView } from '../../../../src/human-view.ts';
import { api } from '../api.ts';

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

const CLAIM_STATUS: Record<string, { label: string; icon: string }> = {
  tentative: { label: '初步', icon: '○' },
  supported: { label: '有证据支持', icon: '◐' },
  contested: { label: '被质询', icon: '!' },
  refuted: { label: '被推翻', icon: '✕' },
  promoted: { label: '已提升', icon: '★' },
  superseded: { label: '已被替代', icon: '↗' },
};

function splitLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function WorkItemPage() {
  const { id: workspaceId, itemId } = useParams();
  const navigate = useNavigate();
  const [workItem, setWorkItem] = useState<HumanWorkItemView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRoundComposer, setShowRoundComposer] = useState(false);

  const load = async () => {
    try {
      const result = await api.getWorkItem(itemId!);
      setWorkItem(result.workItem);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, [itemId]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!workItem) return <div className="loading">加载中…</div>;

  const run = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      setNotice(message);
      setError(null);
      await load();
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const inviteAgent = async () => {
    try {
      await api.inviteAgent(itemId!);
      setNotice('已邀请 Agent 分析，正在等待结果…');
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await load();
      }
      setNotice(null);
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="work-item-page">
      <header className="workspace-header">
        <div>
          <h2>{workItem.title}</h2>
          <div className="console-meta">
            <span className="status-tag">{KIND_LABELS[workItem.kind] ?? workItem.kind}</span>
            <span className={`status-tag status-${workItem.status}`}>
              {STATUS_LABELS[workItem.status] ?? workItem.status}
            </span>
            <span className="muted">Owner：{workItem.ownerId}</span>
            <Link className="link" to={`/workspaces/${workspaceId}`}>
              ← 返回工作空间
            </Link>
          </div>
        </div>
        <button
          className="button button-primary"
          onClick={() => setShowRoundComposer((value) => !value)}
        >
          发起深度研究
        </button>
      </header>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error-banner">{error}</div>}

      {workItem.description && (
        <section className="panel">
          <h3>问题描述</h3>
          <p>{workItem.description}</p>
        </section>
      )}

      <section className="panel">
        <h3>当前结论</h3>
        {workItem.currentConclusionRefs.length > 0 ? (
          <ul>
            {workItem.currentConclusionRefs.map((ref) => (
              <li key={ref}>
                <code>{ref}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">尚无结论，可通过协作流或深度研究形成。</p>
        )}
      </section>

      {workItem.relations.length > 0 && (
        <section className="panel">
          <h3>关联项</h3>
          <ul>
            {workItem.relations.map((relation, index) => (
              <li key={index}>
                {relation.relation} → <code>{relation.targetRef}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h3>添加关联</h3>
        <RelationForm
          workItem={workItem}
          onAction={(action, message) => void run(action, message)}
        />
      </section>

      <section className="panel">
        <h3>协作流</h3>
        <CollaborationStream
          workItem={workItem}
          onAction={(action, message) => void run(action, message)}
          onInvite={() => void inviteAgent()}
        />
      </section>

      <section className="panel">
        <h3>知识（Promoted）</h3>
        <ul>
          {workItem.entries
            .filter((entry) => entry.kind === 'claim' && entry.status === 'promoted')
            .map((entry) => (
              <li key={entry.id}>{entry.statement}</li>
            ))}
        </ul>
        <ul>
          {workItem.knowledgeRefs.map((ref) => (
            <li key={ref.ref}>
              <code>{ref.ref}</code>
              <span className="muted">
                （{ref.scope} · {ref.status}
                {ref.appliesWhen ? ` · 适用：${ref.appliesWhen}` : ''}）
              </span>
            </li>
          ))}
        </ul>
        {workItem.knowledgeRefs.length === 0 &&
          !workItem.entries.some((entry) => entry.kind === 'claim' && entry.status === 'promoted') && (
            <p className="muted">暂无已提升的知识。</p>
          )}
      </section>

      <section className="panel">
        <h3>Research Rounds</h3>
        {workItem.rounds.length === 0 && (
          <p className="muted">尚未发起深度研究。</p>
        )}
        <ul className="work-item-list">
          {workItem.rounds.map((round) => (
            <li key={round.deliberationId}>
              <Link
                to={`/workspaces/${workspaceId}/items/${itemId}/rounds/${round.deliberationId}`}
              >
                {round.deliberationId}
              </Link>
              <span className="status-tag">{round.state}</span>
              {round.recommendation && (
                <span className="muted">推荐：{round.recommendation}</span>
              )}
              <span className="muted">{new Date(round.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
        {showRoundComposer && (
          <RoundComposer
            workspaceId={workspaceId!}
            itemId={itemId!}
            onCreated={(roundId) =>
              navigate(`/workspaces/${workspaceId}/items/${itemId}/rounds/${roundId}`)
            }
            onError={(message) => setError(message)}
          />
        )}
      </section>
    </div>
  );
}

function RelationForm({
  workItem,
  onAction,
}: {
  workItem: HumanWorkItemView;
  onAction: (action: () => Promise<unknown>, message: string) => void;
}) {
  const [relation, setRelation] = useState<'related_to' | 'depends_on' | 'supersedes'>(
    'related_to',
  );
  const [targetRef, setTargetRef] = useState('');

  const submit = () => {
    if (!targetRef.trim()) return;
    const relations = [
      ...workItem.relations,
      { relation, targetRef: targetRef.trim() },
    ];
    onAction(
      () => api.patchWorkItem(workItem.id, { relations }),
      '关联已添加',
    );
    setTargetRef('');
  };

  return (
    <div className="relation-form">
      <div className="form-row">
        <label>
          关系
          <select
            aria-label="关系"
            value={relation}
            onChange={(event) => setRelation(event.target.value as typeof relation)}
          >
            <option value="related_to">相关（related_to）</option>
            <option value="depends_on">依赖（depends_on）</option>
            <option value="supersedes">替代（supersedes）</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          目标引用
          <input
            aria-label="目标引用"
            value={targetRef}
            onChange={(event) => setTargetRef(event.target.value)}
            placeholder="wi_xxx 或 evidence:xxx"
          />
        </label>
      </div>
      <button className="button" onClick={submit}>
        添加关联
      </button>
    </div>
  );
}

function CollaborationStream({
  workItem,
  onAction,
  onInvite,
}: {
  workItem: HumanWorkItemView;
  onAction: (action: () => Promise<unknown>, message: string) => void;
  onInvite: () => void;
}) {
  const [kind, setKind] = useState<'claim' | 'question' | 'update'>('claim');
  const [statement, setStatement] = useState('');
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState<'human' | 'agent'>('agent');

  const submit = () => {
    const author = 'human-owner';
    if (kind === 'claim') {
      onAction(
        () => api.addWorkItemEntry(workItem.id, { kind, statement, author }),
        '主张已追加',
      );
      setStatement('');
    } else {
      onAction(
        () => api.addWorkItemEntry(workItem.id, { kind, text, assignee, author }),
        '条目已追加',
      );
      setText('');
    }
  };

  return (
    <div>
      <div className="entry-list">
        {workItem.entries.length === 0 && <p className="muted">还没有协作条目。</p>}
        {workItem.entries.map((entry) => (
          <EntryCard key={entry.id} entry={entry} workItem={workItem} onAction={onAction} />
        ))}
      </div>
      <div className="entry-composer">
        <div className="form-row">
          <label>
            类型
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="claim">主张（Claim）</option>
              <option value="question">问题（Question）</option>
              <option value="update">进展（Update）</option>
            </select>
          </label>
        </div>
        {kind === 'claim' ? (
          <div className="form-row">
            <label>
              主张内容
              <textarea
                aria-label="主张内容"
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
                rows={2}
              />
            </label>
          </div>
        ) : (
          <>
            <div className="form-row">
              <label>
                {kind === 'question' ? '问题内容' : '进展说明'}
                <textarea
                  aria-label={kind === 'question' ? '问题内容' : '进展说明'}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={2}
                />
              </label>
            </div>
            {kind === 'question' && (
              <div className="form-row">
                <label>
                  指派给
                  <select
                    value={assignee}
                    onChange={(event) => setAssignee(event.target.value as typeof assignee)}
                  >
                    <option value="agent">Agent</option>
                    <option value="human">Human</option>
                  </select>
                </label>
              </div>
            )}
          </>
        )}
        <button className="button button-primary" onClick={submit}>
          追加条目
        </button>
        <button className="button" onClick={onInvite}>
          邀请 Agent 分析
        </button>
      </div>
    </div>
  );
}

function EntryCard({
  entry,
  workItem,
  onAction,
}: {
  entry: HumanWorkItemEntry;
  workItem: HumanWorkItemView;
  onAction: (action: () => Promise<unknown>, message: string) => void;
}) {
  if (entry.kind === 'claim') {
    const meta = CLAIM_STATUS[entry.status ?? 'tentative'] ?? { label: entry.status ?? '', icon: '?' };
    return (
      <div className="entry-card">
        <div className="entry-head">
          <span className={`status-tag status-${entry.status}`}>
            <span aria-hidden="true">{meta.icon}</span> {meta.label}
          </span>
          <span className="muted">
            {entry.author} · {new Date(entry.createdAt).toLocaleString()}
          </span>
        </div>
        <p>{entry.statement}</p>
        <div className="entry-actions">
          {entry.status === 'tentative' && (
            <button
              className="button button-small"
              onClick={() =>
                onAction(
                  () => api.transitionWorkItemEntry(workItem.id, entry.id, 'supported'),
                  '已标记为有证据支持',
                )
              }
            >
              标记有证据支持
            </button>
          )}
          {entry.status === 'supported' && (
            <button
              className="button button-small button-primary"
              onClick={() =>
                onAction(
                  () => api.promoteWorkItemEntry(workItem.id, entry.id),
                  '已提升为 Promoted',
                )
              }
            >
              提升为 Promoted
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="entry-card">
      <div className="entry-head">
        <span className="status-tag">{entry.kind === 'question' ? '问题' : '进展'}</span>
        <span className="muted">
          {entry.author} · {new Date(entry.createdAt).toLocaleString()}
        </span>
      </div>
      <p>{entry.text}</p>
    </div>
  );
}

function RoundComposer({
  workspaceId,
  itemId,
  onCreated,
  onError,
}: {
  workspaceId: string;
  itemId: string;
  onCreated: (roundId: string) => void;
  onError: (message: string) => void;
}) {
  const [problem, setProblem] = useState('');
  const [goalsText, setGoalsText] = useState('');
  const [constraintsText, setConstraintsText] = useState('');
  const [rubricName, setRubricName] = useState('Correctness');
  const [maxScore, setMaxScore] = useState(5);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.createRound(workspaceId, {
        ownerId: 'human-owner',
        problem,
        goals: splitLines(goalsText),
        constraints: splitLines(constraintsText),
        rubric: {
          items: [{ id: 'correctness', name: rubricName, weight: 1 }],
          maxScore,
        },
        workItemId: itemId,
      });
      onCreated(result.deliberation.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="round-composer">
      <h4>发起一轮深度研究（Research Round）</h4>
      <p className="muted">
        系统将从工作项当前上下文生成冻结的任务包，并启动两个隔离 Worker 执行完整协议。
      </p>
      <div className="form-row">
        <label>
          本轮研究问题
          <textarea
            aria-label="本轮研究问题"
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
            rows={2}
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          目标（每行一个）
          <textarea
            aria-label="目标"
            value={goalsText}
            onChange={(event) => setGoalsText(event.target.value)}
            rows={2}
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          约束（每行一个）
          <textarea
            aria-label="约束"
            value={constraintsText}
            onChange={(event) => setConstraintsText(event.target.value)}
            rows={2}
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          Rubric 名称
          <input
            aria-label="Rubric 名称"
            value={rubricName}
            onChange={(event) => setRubricName(event.target.value)}
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          最高分
          <input
            type="number"
            min={1}
            value={maxScore}
            onChange={(event) => setMaxScore(Number(event.target.value))}
          />
        </label>
      </div>
      <button className="button button-primary" disabled={busy} onClick={() => void submit()}>
        {busy ? '创建中…' : '创建并进入 Round'}
      </button>
    </div>
  );
}
