import { readFileSync } from 'node:fs';

const promptFile = process.argv[2];
if (promptFile) readFileSync(promptFile, 'utf8');

const plan = {
  id: 'plan_fake_invalid',
  workItemId: 'wi_fake',
  goal: 'Invalid plan',
  rationale: 'bad enum on purpose',
  nodes: [
    {
      id: 'answer',
      role: 'Analyst',
      objective: 'Answer',
      contextPolicy: { visibility: 'public' },
      capabilityRequirements: ['code-analysis'],
      operator: { type: 'agent_task', instructions: 'Search' },
      completionCriteria: [{ id: 'c1', kind: 'artifact', description: 'note', refs: ['artifact:answer'] }],
      failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
      allocatedBudget: { maxTimeMs: 60000 },
    },
  ],
  stopConditions: [{ id: 's1', kind: 'artifact', description: 'answer', refs: ['artifact:answer'], targetOutcome: 'resolved' }],
  budgetAllocation: { maxTotalTimeMs: 120000, maxTotalAgents: 1, maxTotalRounds: 1 },
  createdByRunId: 'run_planner',
};

process.stdout.write(`${JSON.stringify({ type: 'result', result: '```json\n' + JSON.stringify(plan) + '\n```' })}`);
