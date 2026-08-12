const STATE_META: Record<string, { label: string; icon: string }> = {
  draft: { label: '草稿', icon: '○' },
  frozen: { label: '已冻结', icon: '◇' },
  blind_run: { label: '盲态运行中', icon: '▶' },
  committed: { label: '已提交待披露', icon: '◫' },
  revealed: { label: '已披露', icon: '◉' },
  challenging: { label: '质询中', icon: '?' },
  verifying: { label: '验证中', icon: '✓' },
  reviewing: { label: '评审中', icon: '★' },
  escalated: { label: '已升级', icon: '▲' },
  decided: { label: '已决策', icon: '●' },
};

export function StateBadge({ state }: { state: string }) {
  const meta = STATE_META[state] ?? { label: state, icon: '?' };
  return (
    <span className={`state-badge state-${state}`}>
      <span className="state-icon" aria-hidden="true">
        {meta.icon}
      </span>
      <span>{meta.label}</span>
    </span>
  );
}
