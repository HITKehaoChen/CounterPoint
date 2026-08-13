import { readFileSync } from 'node:fs';

const promptFile = process.argv[2];
if (promptFile) readFileSync(promptFile, 'utf8');

const plan = {
  id: 'plan_fake_claude',
  workItemId: 'wi_fake',
  version: 1,
  goal: 'Verify the fake plan parses',
  assumptions: [],
  rationale: 'single agent is enough for a simple question',
  nodes: [
    {
      id: 'answer',
      role: 'Analyst',
      objective: 'Answer with a code check',
      dependsOn: [],
      inputRefs: [],
      contextPolicy: { visibility: 'shared' },
      capabilityRequirements: ['code-analysis'],
      operator: { type: 'agent_task', instructions: 'Search and answer' },
      completionCriteria: [{ id: 'c1', kind: 'artifact', description: 'answer note', refs: ['artifact:answer'] }],
      failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
      allocatedBudget: { maxTimeMs: 60000 },
    },
  ],
  stopConditions: [{ id: 's1', kind: 'artifact', description: 'answer produced', refs: ['artifact:answer'], targetOutcome: 'resolved' }],
  escalationConditions: [],
  budgetAllocation: { maxTotalTimeMs: 120000, maxTotalAgents: 1, maxTotalRounds: 1 },
  createdByRunId: 'run_planner',
  status: 'proposed',
};

process.stdout.write(
  `${JSON.stringify({ type: 'result', result: '```json\n' + JSON.stringify(plan) + '\n```', usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.001 })}`,
);
