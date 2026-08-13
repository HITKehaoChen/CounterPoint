import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const claudeModel = process.env.PLANNER_MODEL ?? 'deepseek-v4-flash';
const budgetUsd = Number(process.env.PROBE_BUDGET_USD ?? 6);
const plannerTimeoutMs = Number(process.env.PLANNER_TIMEOUT_MS ?? 600_000);
const timeBudgetMs = Number(process.env.PROBE_TIME_BUDGET_MS ?? 1_200_000);
const fixtureFilter = (process.env.PROBE_FIXTURES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const plannerFilter = (process.env.PROBE_PLANNERS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const chrysCostRates = { inputPerMTokenUsd: 5, outputPerMTokenUsd: 25 };
const workspaceRoot = process.env.PROBE_WORKSPACE ?? join(process.cwd(), 'data', 'probe', 'workspaces');
const catalog = catalogFromEntries([
  { capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] },
  { capability: 'verification', adapterKind: 'mock', tools: ['node', 'npm'] },
  { capability: 'independent-review', adapterKind: 'mock', tools: ['read_candidates'] },
]);

interface PlannerEntry {
  name: string;
  workspaceDir: string;
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
  resumed?: boolean;
}

function loadResumedResults(): FixtureResult[] {
  const dir = join(process.cwd(), 'data', 'probe');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => /^probe-report-.+\.json$/.test(name))
    .sort()
    .reverse();
  for (const file of files) {
    try {
      const report = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { results?: FixtureResult[] };
      if (!Array.isArray(report.results) || report.results.length === 0) continue;
      return report.results
        .filter((row) => row.verdict === 'accepted')
        .map((row) => ({ ...row, resumed: true }));
    } catch {
      continue;
    }
  }
  return [];
}

async function main(): Promise<void> {
  const probeStartedAt = Date.now();
  mkdirSync(workspaceRoot, { recursive: true });
  const planners: PlannerEntry[] = [
    {
      name: 'chrys',
      workspaceDir: join(workspaceRoot, 'chrys'),
      adapter: new CliPlannerAdapter({
        command: chrysBin,
        args: ['run', '-a', 'Code', '--json', '-t', '{promptFile}', '-C', '{workspace}'],
        outputMode: 'chrys_json',
        timeoutMs: plannerTimeoutMs,
        model: 'deepseek-v4-pro',
        provider: 'chrys/deepseek-openai',
        costEstimateRates: chrysCostRates,
        workspacePath: join(workspaceRoot, 'chrys'),
      }),
    },
    {
      name: 'claude-code',
      workspaceDir: join(workspaceRoot, 'claude-code'),
      adapter: new CliPlannerAdapter({
        command: claudeBin,
        args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', claudeModel],
        outputMode: 'claude_jsonl',
        promptViaStdin: true,
        timeoutMs: plannerTimeoutMs,
        model: claudeModel,
        provider: 'claude-code/anthropic-deepseek',
        workspacePath: join(workspaceRoot, 'claude-code'),
      }),
    },
  ];

  const results: FixtureResult[] = loadResumedResults();
  let spentUsd = 0;
  let budgetExceeded = false;
  let timeBudgetExceeded = false;

  for (const fixture of PROBE_FIXTURES.filter((item) => fixtureFilter.length === 0 || fixtureFilter.includes(item.id))) {
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
    for (const planner of planners.filter((item) => plannerFilter.length === 0 || plannerFilter.includes(item.name))) {
      const alreadyAccepted = results.some(
        (row) => row.fixture === fixture.id && row.planner === planner.name && row.verdict === 'accepted',
      );
      if (alreadyAccepted) {
        console.log(`[probe] skip ${fixture.id}/${planner.name} (already accepted in prior report)`);
        continue;
      }
      if (Date.now() - probeStartedAt > timeBudgetMs) {
        timeBudgetExceeded = true;
        break;
      }
      if (spentUsd >= budgetUsd) {
        budgetExceeded = true;
        break;
      }
      mkdirSync(planner.workspaceDir, { recursive: true });
      const orchestrator = new PlannerOrchestrator({ planner: planner.adapter, validator: validatePlan, maxRepairAttempts: 1 });
      const startedAt = Date.now();
      console.log(`[probe] start ${fixture.id}/${planner.name} at ${new Date().toISOString()}`);
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
        console.log(
          `[probe] done ${fixture.id}/${planner.name} verdict=${proposal.result.verdict} attempts=${proposal.attempts} elapsed=${Date.now() - startedAt}ms spent=$ ${spentUsd.toFixed(4)}`,
        );
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
        console.log(`[probe] failed ${fixture.id}/${planner.name} elapsed=${Date.now() - startedAt}ms: ${results[results.length - 1].error}`);
      }
    }
    if (budgetExceeded || timeBudgetExceeded) break;
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
    timeBudgetMs,
    spentUsd: Number(spentUsd.toFixed(6)),
    budgetExceeded,
    timeBudgetExceeded,
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
