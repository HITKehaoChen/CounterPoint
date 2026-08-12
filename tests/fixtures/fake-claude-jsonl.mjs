// Emits claude -p --output-format json style JSONL events.
import { readFileSync } from 'node:fs';

const promptFile = process.argv[2];
if (promptFile) readFileSync(promptFile, 'utf8');

const submission = {
  position: {
    summary: 'Fake claude worker recommends a phased migration.',
    claims: [
      {
        id: 'claude-1',
        statement: 'Incremental migration reduces blast radius.',
        type: 'design',
        evidenceRefs: [],
        confidence: 0.79,
      },
    ],
    unknowns: ['Client coordination cost'],
    artifactRefs: [],
    decisionConditions: [],
    confidence: 0.74,
  },
  artifacts: [],
};

process.stdout.write(`${JSON.stringify({ type: 'result', result: `\`\`\`json\n${JSON.stringify(submission)}\n\`\`\`` })}\n`);
