// Writes agent-output.json into the workspace; argv[2] is the workspace path.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workspace = process.argv[2];
if (!workspace) {
  process.stderr.write('missing workspace argument\n');
  process.exit(2);
}

const submission = {
  position: {
    summary: 'Fake file worker recommends synchronous integration.',
    claims: [
      {
        id: 'file-1',
        statement: 'A single transaction boundary simplifies rollback.',
        type: 'fact',
        evidenceRefs: [],
        confidence: 0.8,
      },
    ],
    unknowns: [],
    artifactRefs: [],
    decisionConditions: [],
    confidence: 0.7,
  },
  artifacts: [
    {
      logicalName: 'file-design',
      type: 'markdown',
      content: '# File design note',
      visibility: 'shared',
    },
  ],
};

writeFileSync(join(workspace, 'agent-output.json'), JSON.stringify(submission, null, 2));
process.stdout.write('wrote agent-output.json\n');
