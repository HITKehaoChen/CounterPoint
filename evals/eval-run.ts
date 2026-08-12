import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReport,
  reportToMarkdown,
  runConditionA,
  runConditionB,
  runConditionC,
  type EvalFixture,
} from './eval-core.ts';

async function main(): Promise<void> {
  const fixturesDir = join(process.cwd(), 'evals', 'fixtures');
  const files = readdirSync(fixturesDir).filter((file) => file.endsWith('.json'));
  const fixtures: EvalFixture[] = files.map((file) =>
    JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as EvalFixture,
  );
  const results = [];
  for (const fixture of fixtures) {
    results.push(await runConditionA(fixture));
    results.push(await runConditionB(fixture));
    results.push(await runConditionC(fixture));
  }
  const report = buildReport(fixtures, results);
  const outDir = join(process.cwd(), 'evals', 'reports');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(outDir, `report-${stamp}.json`);
  const markdownPath = join(outDir, `report-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(markdownPath, reportToMarkdown(report), 'utf8');
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
  console.table(report.summary);
}

await main();
