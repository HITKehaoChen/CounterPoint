import { useState } from 'react';

const ACTIONS = [
  { value: 'approve', label: '批准推荐' },
  { value: 'override', label: '选择另一候选' },
  { value: 'merge', label: '合并候选' },
  { value: 'no_decision', label: '无法裁决' },
];

export function HumanGatePanel({
  state,
  unresolvedConflicts,
  onSubmit,
}: {
  state: string;
  unresolvedConflicts: string[];
  onSubmit: (payload: { action: string; rationale: string }) => void;
}) {
  const [action, setAction] = useState('approve');
  const [rationale, setRationale] = useState('');

  if (state !== 'reviewing' && state !== 'escalated') return null;

  return (
    <section className="human-gate">
      <h3>未解决分歧</h3>
      {unresolvedConflicts.length > 0 ? (
        <ul className="conflict-list">
          {unresolvedConflicts.map((conflict, index) => (
            <li key={index}>⚠ {conflict}</li>
          ))}
        </ul>
      ) : (
        <p className="conflict-none">暂无未解决分歧。</p>
      )}
      <h3>人工决策</h3>
      <div className="form-row">
        <label>
          决策动作
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            {ACTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          决策理由
          <textarea
            aria-label="决策理由"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            rows={4}
          />
        </label>
      </div>
      <button
        className="button button-primary"
        disabled={!rationale.trim()}
        onClick={() => onSubmit({ action, rationale })}
      >
        提交决策
      </button>
    </section>
  );
}
