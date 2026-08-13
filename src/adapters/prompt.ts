import type { AgentRunInput } from './agent.ts';

/**
 * Renders the Counterpoint task contract as a prompt for an external coding
 * agent. The prompt asks for exactly one JSON document matching the
 * AgentRunResult contract, so any CLI/ACP agent can be wrapped without
 * agent-specific glue beyond output parsing.
 */
export function renderAgentPrompt(input: AgentRunInput): string {
  const packet = input.taskPacket;
  const lines: string[] = [];
  lines.push('You are a Counterpoint execution node.');
  lines.push(`Run: ${input.runId} (phase: ${input.phase})`);
  lines.push('');
  const isolation = input.isolationMode ?? 'blind';
  if (isolation === 'blind') {
    lines.push('You are in BLIND isolation: other nodes\' outputs are hidden from you.');
    lines.push('Do not assume the existence of other candidates. Produce your own independent analysis.');
  } else if (isolation === 'shared') {
    lines.push('You are in SHARED mode: upstream artifacts listed below are visible to you. Build on them explicitly.');
  } else if (isolation === 'private') {
    lines.push('You are in PRIVATE mode: your outputs will not be shared automatically with other nodes.');
  } else {
    lines.push('You are in SEALED mode: your outputs are sealed until explicitly revealed.');
  }
  lines.push('');
  lines.push('## Task');
  lines.push('');
  lines.push(packet.problem);
  lines.push('');
  lines.push('### Goals');
  for (const goal of packet.goals) lines.push(`- ${goal}`);
  lines.push('');
  lines.push('### Constraints');
  for (const constraint of packet.constraints) lines.push(`- ${constraint}`);
  lines.push('');
  lines.push('### Rubric');
  for (const item of packet.rubric.items) {
    lines.push(`- ${item.name}${item.description ? `: ${item.description}` : ''} (weight ${item.weight})`);
  }
  if (packet.deliverable) {
    lines.push('');
    lines.push(`### Deliverable`);
    lines.push(packet.deliverable);
  }
  lines.push('');
  lines.push('## Authority Sources');
  lines.push('');
  if (!input.authoritySources.length) lines.push('(none)');
  for (const source of input.authoritySources) {
    lines.push(`### ${source.ref} — ${source.binding.label}`);
    if (source.content) {
      lines.push('');
      lines.push(source.content);
      lines.push('');
    }
  }
  lines.push('## Shared Artifacts Visible To You');
  lines.push('');
  if (!input.visibleArtifacts.length) lines.push('(none)');
  for (const artifact of input.visibleArtifacts) {
    lines.push(`### ${artifact.ref}`);
    lines.push(artifact.content);
    lines.push('');
  }
  lines.push('## Workspace');
  lines.push('');
  lines.push(`Your isolated workspace is: ${input.workspacePath}`);
  lines.push('You may create scratch files there. Do NOT read or write outside this workspace.');
  lines.push('');
  lines.push('## Output Contract');
  lines.push('');
  lines.push('Respond with ONLY a single JSON document (no prose before or after) with this shape:');
  lines.push('');
  lines.push('```json');
  lines.push(`{
  "position": {
    "summary": "one-paragraph recommendation",
    "claims": [
      {
        "id": "claim-1",
        "statement": "a claim that can be supported or refuted",
        "type": "fact | preference | risk | design | unknown",
        "evidenceRefs": [],
        "confidence": 0.7
      }
    ],
    "unknowns": ["what you do not know"],
    "artifactRefs": [],
    "decisionConditions": ["conditions that would change your recommendation"],
    "confidence": 0.7
  },
  "artifacts": [
    {
      "logicalName": "design-note",
      "type": "markdown",
      "content": "# Design note",
      "visibility": "shared"
    }
  ]
}`);
  lines.push('```');
  lines.push('');
  lines.push('You may write additional scratch files in your workspace, but the final JSON');
  lines.push('document above is the only thing that will be parsed as your submission.');
  return lines.join('\n');
}
