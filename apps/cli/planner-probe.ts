import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultAutonomyEnvelope, tightenEnvelope } from '../../src/autonomy/autonomy-envelope.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { validatePlan } from '../../src/planning/plan-validator.ts';
import { PlannerOrchestrator, type PlannerInput } from '../../src/planning/planner.ts';
import { CliPlannerAdapter } from '../../src/planning/cli-planner.ts';
import { PROBE_FIXTURES, topologySignature } from './planner-fixtures.ts';

const chrysBin = process.env.CHRYS_BIN ?? 'C:\\Users\\tgyzc\\project\\chrys\\.venv\\Scripts\\chrys.exe';
const claudeBin = process.env.CLAUDE_BIN ?? 'C:\\Users\\tgyzc\\.local\\bin\\claude.exe';
const claudeModel = process.env.PLANNER_MODEL ?? 'deepseek-v4-pro[1m]';
const budgetUsd = Number(process.env.PROBE_BUDGET_USD ?? 6);
const chrysCostRates = { inputPerMTokenUsd: 5, outputPerMTokenUsd: 25 };
const workspaceRoot = process.env.PROBE_WORKSPACE ?? join(process.cwd(), 'data', 'probe', 'workspaces');
const catalog = catalogFromEntries([
  { capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] },
  { capability: 'verification', adapterKind: 'mock', tools: ['node', 'npm'] },
  { capability: 'independent-review', adapterKind: 'mock', tools: ['read_candidates'] },
]);

interface PlannerEntry {
  name: string;
  adapter: CliPlannerAdapter;
}

interface FixtureResult {
  fixture: string;
  planner: string;
  verdict: string;
  attempts: number;
  issueCodes: string[];
  topology: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  error?: string;
}

async function main(): Promise<void> {
  mkdirSync(workspaceRoot, { recursive: true });
  const planners: PlannerEntry[] = [
    {
      name: 'chrys',
      adapter: new CliPlannerAdapter({
        command: chrysBin,
        args: ['run', '-a', 'Code', '--json', '-t', '{promptFile}', '-C', '{workspace}'],
        outputMode: 'chrys_json',
        timeoutMs: 600_000,
        model: 'deepseek-v4-pro',
        provider: 'chrys/deepseek-openai',
        costEstimateRates: chrysCostRates,
        workspacePath: join(workspaceRoot, 'chrys'),
      }),
    },
    {
      name: 'claude-code',
      adapter: new CliPlannerAdapter({
        command: claudeBin,
        args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', claudeModel],
        outputMode: 'claude_jsonl',
        promptViaStdin: true,
        timeoutMs: 600_000,
        model: claudeModel,
        provider: 'claude-code/anthropic-deepseek',
        workspacePath: join(workspaceRoot, 'claude'),
      }),
    },
  ];

  const results: FixtureResult[] = [];
  let spentUsd = 0;
  let budgetExceeded = false;

  for (const fixture of PROBE_FIXTURES) {
    const workspaceId = `probe_${fixture.id}`;
    const envelope = tightenEnvelope(defaultAutonomyEnvelope(workspaceId), fixture.envelopeOverrides);
    const input: PlannerInput = {
      workItem: {
        id: `wi_${fixture.id}`,
        workspaceId,
        kind: fixture.workItem.kind,
        title: fixture.workItem.title,
        ownerId: 'probe-operator',
        status: 'open',
        goal: fixture.workItem.goal,
        constraints: fixture.workItem.constraints,
        expectedOutcomes: fixture.workItem.expectedOutcomes,
        sourceRefs: fixture.workItem.sourceRefs,
        templateFields: {},
        currentConclusionRefs: [],
        knowledgeRefs: [],
        relations: [],
        entries: [],
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      envelope,
      catalog,
      sources: fixture.sources,
      reusableEvidence: [],
    };
    for (const planner of planners) {
      if (spentUsd >= budgetUsd) {
        budgetExceeded = true;
        break;
      }
      mkdirSync(join(workspaceRoot, planner.name), { recursive: true });
      const orchestrator = new PlannerOrchestrator({ planner: planner.adapter, validator: validatePlan, maxRepairAttempts: 2 });
      const startedAt = Date.now();
      try {
        const proposal = await orchestrator.propose(input);
        spentUsd += proposal.totalCostUsd;
        results.push({
          fixture: fixture.id,
          planner: planner.name,
          verdict: proposal.result.verdict,
          attempts: proposal.attempts,
          issueCodes: proposal.result.issues.map((issue) => issue.code),
          topology: proposal.plan ? topologySignature(proposal.plan) : '',
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        results.push({
          fixture: fixture.id,
          planner: planner.name,
          verdict: 'error',
          attempts: 0,
          issueCodes: [],
          topology: '',
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (budgetExceeded) break;
  }

  const diversityByPlanner = new Map<string, boolean>();
  for (const planner of planners) {
    const rows = results.filter((row) => row.planner === planner.name && row.verdict === 'accepted');
    const signatures = new Set(rows.map((row) => row.topology));
    diversityByPlanner.set(planner.name, signatures.size >= 2);
  }
  const acceptance = {
    chrys: results.some((row) => row.planner === 'chrys' && row.verdict === 'accepted'),
    claude: results.some((row) => row.planner === 'claude-code' && row.verdict === 'accepted'),
  };
  const report = {
    formatVersion: 'planner-probe/0.1.0',
    generatedAt: new Date().toISOString(),
    budgetUsd,
    spentUsd: Number(spentUsd.toFixed(6)),
    budgetExceeded,
    results,
    acceptance,
    diversity: Object.fromEntries(diversityByPlanner),
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'data', 'probe');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `probe-report-${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));

  const strict = process.argv.includes('--strict');
  const passed = acceptance.chrys && acceptance.claude && [...diversityByPlanner.values()].every(Boolean);
  if (strict && !passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[planner-probe] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
