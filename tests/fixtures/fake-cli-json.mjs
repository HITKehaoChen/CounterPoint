// Prints a fenced JSON submission to stdout; argv[2] is the prompt file path.
import { readFileSync } from 'node:fs';

const promptFile = process.argv[2];
if (promptFile) {
  readFileSync(promptFile, 'utf8'); // ensure the prompt file exists
}

const submission = {
  position: {
    summary: 'Fake CLI worker chooses the strangler pattern.',
    claims: [
      {
        id: 'cli-1',
        statement: 'Strangler migration avoids a big-bang cutover.',
        type: 'design',
        evidenceRefs: [],
        confidence: 0.8,
      },
      {
        id: 'cli-2',
        statement: 'Feature flags give rollback safety.',
        type: 'fact',
        evidenceRefs: [],
        confidence: 0.75,
      },
    ],
    unknowns: ['Shadow traffic cost'],
    artifactRefs: [],
    decisionConditions: ['Gate rollout if shadow traffic exceeds 2x'],
    confidence: 0.77,
  },
  artifacts: [
    {
      logicalName: 'cli-design',
      type: 'markdown',
      content: '# CLI design note',
      visibility: 'shared',
    },
  ],
};

process.stdout.write(`Here is my analysis:\n\`\`\`json\n${JSON.stringify(submission, null, 2)}\n\`\`\`\n`);
