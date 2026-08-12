#!/usr/bin/env node
// Sample local-process worker for the LocalProcessAgentAdapter.
//
// Contract:
//   node apps/worker-sample.mjs <input.json>
// The input JSON contains the task packet, context view, authority sources
// and visible artifacts. The worker writes agent-output.json into its
// isolated workspace (the directory containing input.json).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: node apps/worker-sample.mjs <input.json>');
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const { taskPacket, workspacePath, runId } = input;
const sources = (input.authoritySources ?? [])
  .map((source) => `- ${source.binding?.label ?? source.ref}`)
  .join('\n');

const position = {
  summary: `Local sample worker proposes an approach for: ${taskPacket.problem}`,
  claims: [
    {
      id: `sample-${runId}-1`,
      statement: 'Start with the simplest integration that satisfies the constraints.',
      type: 'design',
      evidenceRefs: [],
      confidence: 0.6,
    },
    {
      id: `sample-${runId}-2`,
      statement: 'Any chosen path must keep rollback and idempotency explicit.',
      type: 'risk',
      evidenceRefs: [],
      confidence: 0.7,
    },
  ],
  unknowns: ['Operational load profile is not provided'],
  artifactRefs: [],
  decisionConditions: ['Re-evaluate when load data is available'],
  confidence: 0.62,
};

const artifact = {
  logicalName: `local-note-${runId}`,
  type: 'markdown',
  content: `# Local sample worker\n\nSources seen:\n${sources}\n`,
  visibility: 'shared',
};

const output = {
  position,
  artifacts: [artifact],
  fingerprint: {
    adapter: 'local-process-agent',
    model: 'sample-worker',
    provider: 'local',
    promptVersion: 'sample-1',
    toolset: ['read_sources'],
  },
  logs: `sample worker processed ${taskPacket.problem}`,
  cost: 0,
};

writeFileSync(join(workspacePath ?? dirname(inputPath), 'agent-output.json'), JSON.stringify(output, null, 2));
console.log(`sample worker ${runId} wrote agent-output.json`);
