import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReport,
  reportToMarkdown,
  runConditionA,
  runConditionB,
  runConditionC,
  type EvalFixture,
} from '../../evals/eval-core.ts';

function loadFixture(name: string): EvalFixture {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'evals', 'fixtures', name), 'utf8'),
  ) as EvalFixture;
}

test('eval harness runs A/B/C conditions and produces a report', async () => {
  const fixtures = [loadFixture('sync-vs-events.json'), loadFixture('migration-approach.json')];
  const results = [];
  for (const fixture of fixtures) {
    results.push(await runConditionA(fixture));
    results.push(await runConditionB(fixture));
    results.push(await runConditionC(fixture));
  }
  const report = buildReport(fixtures, results);
  assert.equal(report.results.length, 6);
  assert.equal(report.summary.length, 3);
  for (const row of report.summary) {
    assert.equal(row.totalContextLeaks, 0, `condition ${row.condition} must have zero context leaks`);
  }
  const conditionC = report.results.filter((row) => row.condition === 'C');
  for (const row of conditionC) {
    assert.equal(row.decided, true);
    assert.ok(row.positions >= 2);
  }
  const markdown = reportToMarkdown(report);
  assert.ok(markdown.includes('# Counterpoint A/B/C Evaluation Report'));
  assert.ok(markdown.includes('Directional harness demonstration'));
  assert.ok(markdown.includes('sync-vs-events'));
});

test('baseline B models false consensus when a shared-context script is present', async () => {
  const fixture = loadFixture('sync-vs-events.json');
  const result = await runConditionB(fixture);
  assert.equal(result.falseConsensus, true);
  assert.equal(result.condition, 'B');
});
