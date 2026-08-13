import { readFileSync } from 'node:fs';

const promptFile = process.argv[2];
if (promptFile) readFileSync(promptFile, 'utf8');

const plan = {
  id: 'plan_fake_chrys',
  workItemId: 'wi_fake',
  goal: 'Verify the fake plan parses',
  rationale: 'single agent is enough for a simple question',
  nodes: [
    {
      id: 'answer',
      role: 'Analyst',
      objective: 'Answer with a code check',
      contextPolicy: { visibility: 'shared' },
      capabilityRequirements: ['code-analysis'],
      operator: { type: 'agent_task', instructions: 'Search and answer' },
      completionCriteria: [{ id: 'c1', kind: 'artifact', description: 'answer note', refs: ['artifact:answer'] }],
      failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
      allocatedBudget: { maxTimeMs: 60000 },
    },
  ],
  stopConditions: [{ id: 's1', kind: 'artifact', description: 'answer produced', refs: ['artifact:answer'], targetOutcome: 'resolved' }],
  budgetAllocation: { maxTotalTimeMs: 120000, maxTotalAgents: 1, maxTotalRounds: 1 },
  createdByRunId: 'run_planner',
};

process.stdout.write(JSON.stringify({ result: '```json\n' + JSON.stringify(plan) + '\n```', session_id: '00000000-0000-4000-8000-000000000000', duration: 1.5 }));
