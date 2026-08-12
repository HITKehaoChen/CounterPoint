import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CliUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface CliMeta {
  costUsd?: number;
  durationMs?: number;
  model?: string;
  provider?: string;
  usage?: CliUsage;
}

export interface CostEstimateRates {
  inputPerMTokenUsd: number;
  outputPerMTokenUsd: number;
}

export function estimateCostUsd(usage: CliUsage | undefined, rates?: CostEstimateRates): number | undefined {
  if (!usage || !rates) return undefined;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return (input / 1_000_000) * rates.inputPerMTokenUsd + (output / 1_000_000) * rates.outputPerMTokenUsd;
}

/**
 * Parses `claude -p --output-format json` output. The stream is a single JSON
 * result object (or a JSONL stream of events); we collect every `type=result`
 * event and take the last one, along with billing metadata.
 */
export function extractClaudeResult(stdout: string): { text: string; meta: CliMeta } {
  let text = '';
  let meta: CliMeta = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'error') {
      throw new Error(`claude error: ${JSON.stringify(event.error ?? event)}`);
    }
    if (event.type !== 'result') continue;
    if (typeof event.result === 'string') {
      text += event.result;
    }
    const usage = event.usage as Record<string, unknown> | undefined;
    const modelUsage = event.modelUsage as Record<string, Record<string, unknown>> | undefined;
    const firstModel = modelUsage ? Object.keys(modelUsage)[0] : undefined;
    meta = {
      costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
      durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
      model: firstModel ?? meta.model,
      provider: 'claude-code',
      usage: {
        inputTokens:
          (typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined) ??
          (firstModel && typeof modelUsage?.[firstModel]?.inputTokens === 'number'
            ? (modelUsage[firstModel].inputTokens as number)
            : undefined),
        outputTokens:
          (typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined) ??
          (firstModel && typeof modelUsage?.[firstModel]?.outputTokens === 'number'
            ? (modelUsage[firstModel].outputTokens as number)
            : undefined),
        cacheReadInputTokens:
          typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
      },
    };
  }
  return { text, meta };
}

/**
 * Parses `chrys run --json` output and reads the persisted session file for
 * real token usage. Chrys does not report billing, so cost must be estimated
 * from usage with explicit rates when provided.
 */
export function extractChrysResult(
  stdout: string,
  options: { stateDir?: string; rates?: CostEstimateRates } = {},
): { text: string; meta: CliMeta } {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`chrys run did not emit JSON: ${stdout.slice(0, 400)} (${(error as Error).message})`);
  }
  const text = typeof payload.result === 'string' ? payload.result : '';
  if (!text) throw new Error(`chrys run result is empty: ${JSON.stringify(payload).slice(0, 400)}`);
  const durationMs = typeof payload.duration === 'number' ? Math.round(payload.duration * 1000) : undefined;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  const stateRoot = options.stateDir ?? process.env.APPDATA ?? process.cwd();
  const meta: CliMeta = { durationMs, model: 'deepseek-v4-pro', provider: 'chrys' };
  if (sessionId) {
    // Chrys persists sessions under a 12-char directory derived from the UUID.
    const shortId = sessionId.replaceAll('-', '').slice(0, 12);
    const sessionFile = join(stateRoot, 'chrys', 'sessions', shortId, 'session.json');
    try {
      const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
      const state = session.state as Record<string, unknown> | undefined;
      const lastUsage = (state?.last_usage ?? session.last_usage) as Record<string, unknown> | undefined;
      const sessionMeta = session.meta as Record<string, unknown> | undefined;
      if (typeof sessionMeta?.model_id === 'string') meta.model = sessionMeta.model_id as string;
      meta.usage = {
        inputTokens:
          typeof lastUsage?.input_token_count === 'number' ? (lastUsage.input_token_count as number) : undefined,
        outputTokens:
          typeof lastUsage?.output_token_count === 'number' ? (lastUsage.output_token_count as number) : undefined,
        cacheReadInputTokens:
          typeof lastUsage?.cache_hit_tokens === 'number' ? (lastUsage.cache_hit_tokens as number) : undefined,
      };
    } catch {
      // Session persistence is best-effort; usage stays undefined.
    }
  }
  const estimated = estimateCostUsd(meta.usage, options.rates);
  if (estimated !== undefined) meta.costUsd = estimated;
  return { text, meta };
}
