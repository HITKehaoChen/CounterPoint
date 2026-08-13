import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliPlannerAdapter } from '../../src/planning/cli-planner.ts';
import { renderPlannerPrompt } from '../../src/planning/planner-prompt.ts';
import type { PlannerInput } from '../../src/planning/planner.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { validEnvelope, validWorkItem } from '../helpers/plan-fixtures.ts';

const fixturesDir = join(process.cwd(), 'tests', 'fixtures');

function input(): PlannerInput {
  return {
    workItem: validWorkItem(),
    envelope: validEnvelope(),
    catalog: catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] }]),
    sources: [{ id: 'src_1', label: 'inventory', excerpt: 'sync', versionRef: 'src_1@v1' }],
    reusableEvidence: [],
  };
}

test('prompt includes constraints, envelope limits and no chain-of-thought request', () => {
  const prompt = renderPlannerPrompt(input());
  assert.ok(prompt.includes('No production access'));
  assert.ok(prompt.includes('maxAgents'));
  assert.ok(!/chain.of.thought|思维链|step by step reasoning/i.test(prompt));
});

test('cli planner parses claude jsonl output', async () => {
  const adapter = new CliPlannerAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-planner-claude.mjs'), '{promptFile}'],
    outputMode: 'claude_jsonl',
    promptViaStdin: false,
    timeoutMs: 10_000,
    workspacePath: mkdtempSync(join(tmpdir(), 'counterpoint-planner-')),
  });
  const result = await adapter.plan(input());
  assert.equal(result.plan.id, 'plan_fake_claude');
  assert.equal(result.meta.provider, 'claude-code');
});

test('cli planner parses chrys json output', async () => {
  const adapter = new CliPlannerAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-planner-chrys.mjs'), '{promptFile}'],
    outputMode: 'chrys_json',
    timeoutMs: 10_000,
    workspacePath: mkdtempSync(join(tmpdir(), 'counterpoint-planner-')),
  });
  const result = await adapter.plan(input());
  assert.equal(result.plan.id, 'plan_fake_chrys');
});
