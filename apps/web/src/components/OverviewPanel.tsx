import type { HumanView } from '../../../../src/human-view.ts';

export function OverviewPanel({ view }: { view: HumanView }) {
  const packet = view.taskPacket;
  return (
    <section className="panel">
      <h3>任务包（Task Packet v{packet.version}）</h3>
      <p className="problem">{packet.problem}</p>
      <h4>目标</h4>
      <ul>
        {packet.goals.map((goal, index) => (
          <li key={index}>{goal}</li>
        ))}
      </ul>
      <h4>约束</h4>
      <ul>
        {packet.constraints.map((constraint, index) => (
          <li key={index}>{constraint}</li>
        ))}
      </ul>
      <h4>Rubric</h4>
      <ul>
        {packet.rubric.items.map((item) => (
          <li key={item.id}>
            {item.name}（权重 {item.weight}）
          </li>
        ))}
      </ul>
      {packet.deliverable && <p>交付物：{packet.deliverable}</p>}
      <h4>参与者</h4>
      <ul>
        {view.participants.map((participant) => (
          <li key={participant.id}>
            {participant.role} · {participant.label ?? participant.id}
          </li>
        ))}
      </ul>
      <h4>权威来源</h4>
      <ul>
        {packet.sources.map((source) => (
          <li key={source}>
            <code>{source}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
