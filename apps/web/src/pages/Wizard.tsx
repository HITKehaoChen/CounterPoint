import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WorkItemKind } from '../../../../src/schemas.ts';
import { api } from '../api.ts';

const KIND_LABELS: Record<WorkItemKind, string> = {
  problem: '问题',
  requirement: '需求',
  bug: 'Bug',
  hypothesis: '假设',
  decision: '技术决策',
};

const KIND_TEMPLATES: Record<
  WorkItemKind,
  Array<{ key: string; label: string; placeholder?: string }>
> = {
  problem: [{ key: 'knownBoundaries', label: '已知边界', placeholder: '例如：不涉及网络写操作' }],
  requirement: [
    { key: 'acceptanceCriteria', label: '验收标准', placeholder: '每行一条验收标准' },
    { key: 'priority', label: '优先级', placeholder: 'P0/P1/P2' },
  ],
  bug: [
    { key: 'reproSteps', label: '复现步骤', placeholder: '1. …' },
    { key: 'environment', label: '环境', placeholder: '版本、系统、配置' },
    { key: 'expected', label: '期望行为' },
    { key: 'actual', label: '实际行为' },
  ],
  hypothesis: [
    { key: 'prediction', label: '预测', placeholder: '如果…那么…' },
    { key: 'experiment', label: '实验设计', placeholder: '如何验证' },
    { key: 'measurement', label: '测量方式', placeholder: '指标与数据来源' },
  ],
  decision: [{ key: 'deliverable', label: '期望交付物', placeholder: '例如：ADR with conditions' }],
};

export function Wizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [kind, setKind] = useState<WorkItemKind>('problem');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [templateFields, setTemplateFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeKind = (next: WorkItemKind) => {
    setKind(next);
    setTemplateFields({});
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createWorkItem(id!, {
        kind,
        title,
        description: description.trim() || undefined,
        templateFields,
      });
      navigate(`/workspaces/${id}/items/${result.workItem.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="wizard">
      <h2>新建工作项</h2>
      <p className="muted">选择类型后按模板填写；工作项创建后可持续补充，必要时再发起深度研究。</p>
      {error && <div className="error-banner">{error}</div>}
      <section className="panel">
        <div className="form-row">
          <label>
            类型
            <select
              aria-label="类型"
              value={kind}
              onChange={(event) => changeKind(event.target.value as WorkItemKind)}
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            标题
            <input
              aria-label="标题"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="用一句话描述要解决的问题"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            详细描述
            <textarea
              aria-label="详细描述"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </label>
        </div>
        <h3>{KIND_LABELS[kind]}模板字段</h3>
        {KIND_TEMPLATES[kind].map((field) => (
          <div className="form-row" key={field.key}>
            <label>
              {field.label}
              <textarea
                aria-label={field.label}
                value={templateFields[field.key] ?? ''}
                onChange={(event) =>
                  setTemplateFields({ ...templateFields, [field.key]: event.target.value })
                }
                rows={2}
                placeholder={field.placeholder}
              />
            </label>
          </div>
        ))}
        <button className="button button-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '创建中…' : '创建工作项'}
        </button>
      </section>
    </div>
  );
}
