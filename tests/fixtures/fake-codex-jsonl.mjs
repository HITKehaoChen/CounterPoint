// Emits codex exec --json style JSONL events with the submission in text.
import { readFileSync } from 'node:fs';

const promptFile = process.argv[2];
if (promptFile) readFileSync(promptFile, 'utf8');

const submission = {
  position: {
    summary: 'Fake codex worker recommends events with an outbox.',
    claims: [
      {
        id: 'codex-1',
        statement: 'An outbox decouples the write path from downstream failure.',
        type: 'fact',
        evidenceRefs: [],
        confidence: 0.76,
      },
    ],
    unknowns: ['Exactly-once'],
    artifactRefs: [],
    decisionConditions: [],
    confidence: 0.72,
  },
  artifacts: [],
};

process.stdout.write(`${JSON.stringify({ type: 'init', payload: { model: 'fake-codex' } })}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: 'agent_message',
    payload: { type: 'text', text: `\`\`\`json\n${JSON.stringify(submission)}\n\`\`\`` },
  })}\n`,
);
process.stdout.write(`${JSON.stringify({ type: 'result', payload: { text: 'done' } })}\n`);
