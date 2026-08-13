import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCliProcess } from '../adapters/cli-agent.ts';
import { extractChrysResult, extractClaudeResult, type CliMeta, type CostEstimateRates } from '../adapters/cli-meta.ts';
import { extractJsonPayload } from '../adapters/output.ts';
import { CollaborationPlanSchema } from './schemas.ts';
import type { Planner, PlannerInput, PlannerResult } from './planner.ts';
import { renderPlannerPrompt } from './planner-prompt.ts';

export type PlannerOutputMode = 'json_stdout' | 'claude_jsonl' | 'chrys_json';

export interface CliPlannerConfig {
  command: string;
  args?: string[];
  outputMode: PlannerOutputMode;
  promptViaStdin?: boolean;
  timeoutMs?: number;
  model?: string;
  provider?: string;
  promptVersion?: string;
  costEstimateRates?: CostEstimateRates;
  chrysStateDir?: string;
  workspacePath: string;
}

export class CliPlannerAdapter implements Planner {
  readonly name: string;
  private readonly config: CliPlannerConfig;

  constructor(config: CliPlannerConfig) {
    this.config = config;
    this.name = `cli-planner/${config.command}`;
  }

  async plan(input: PlannerInput): Promise<PlannerResult> {
    const prompt = renderPlannerPrompt(input);
    const promptFile = join(this.config.workspacePath, 'planner-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf8');
    const args = (this.config.args ?? []).map((arg) =>
      arg
        .replaceAll('{promptFile}', promptFile)
        .replaceAll('{workspace}', this.config.workspacePath),
    );
    const { stdout, stderr } = await runCliProcess({
      command: this.config.command,
      args,
      cwd: this.config.workspacePath,
      timeoutMs: this.config.timeoutMs ?? 600_000,
      stdinText: this.config.promptViaStdin ? prompt : undefined,
    });
    let text = stdout;
    let meta: CliMeta = {};
    if (this.config.outputMode === 'claude_jsonl') {
      ({ text, meta } = extractClaudeResult(stdout));
    } else if (this.config.outputMode === 'chrys_json') {
      ({ text, meta } = extractChrysResult(stdout, {
        stateDir: this.config.chrysStateDir,
        rates: this.config.costEstimateRates,
      }));
    }
    if (!text.trim()) throw new Error(`Planner produced no output; stderr: ${stderr.slice(0, 1000)}`);
    const plan = CollaborationPlanSchema.parse(extractJsonPayload(text));
    return {
      plan,
      meta: {
        costUsd: meta.costUsd,
        durationMs: meta.durationMs,
        model: meta.model ?? this.config.model,
        provider: meta.provider ?? this.config.provider,
        usage: meta.usage,
      },
    };
  }
}
