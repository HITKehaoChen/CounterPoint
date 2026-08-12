import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveArgument, resolveExecutable } from './command.ts';
import type { AgentAdapter, AgentRunInput, AgentRunResult } from './agent.ts';
import { extractJsonPayload, parseAgentResultJson } from './output.ts';
import { renderAgentPrompt } from './prompt.ts';
import type { AgentFingerprint } from '../schemas.ts';

export type CliOutputMode = 'json_stdout' | 'json_file' | 'codex_jsonl' | 'claude_jsonl';

export interface CliAgentConfig {
  /** CLI executable, e.g. "codex", "claude", or a test script. */
  command: string;
  /**
   * Arguments. Placeholders are replaced per run:
   * {workspace} {promptFile} {runId} {participantId}
   */
  args?: string[];
  timeoutMs?: number;
  outputMode?: CliOutputMode;
  /** For outputMode "json_file"; defaults to agent-output.json in the workspace. */
  outputFile?: string;
  promptVersion?: string;
  model?: string;
  provider?: string;
  env?: Record<string, string>;
}

/**
 * CLI Agent Adapter: drives any coding-agent CLI (Codex, Claude Code, ...)
 * from the isolated workspace. The prompt is written to a file whose path can
 * be passed through {promptFile}; the agent's stdout is parsed according to
 * the configured output mode:
 *
 * - json_stdout: a JSON document (possibly fenced) on stdout
 * - json_file: agent writes {outputFile} into the workspace
 * - codex_jsonl: `codex exec --json` style JSONL events
 * - claude_jsonl: `claude -p --output-format json` style events
 */
export class CliAgentAdapter implements AgentAdapter {
  readonly name = 'cli-agent';
  private readonly config: CliAgentConfig;

  constructor(config: CliAgentConfig) {
    this.config = config;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const promptFile = join(input.workspacePath, 'agent-prompt.txt');
    writeFileSync(promptFile, renderAgentPrompt(input), 'utf8');
    const args = (this.config.args ?? []).map((arg) =>
      arg
        .replaceAll('{workspace}', input.workspacePath)
        .replaceAll('{promptFile}', promptFile)
        .replaceAll('{runId}', input.runId)
        .replaceAll('{participantId}', input.participantId),
    );
    const { stdout, stderr } = await runProcess({
      command: this.config.command,
      args,
      cwd: input.workspacePath,
      timeoutMs: this.config.timeoutMs ?? 120_000,
      env: this.config.env,
    });
    const outputMode = this.config.outputMode ?? 'json_stdout';
    let parsed;
    if (outputMode === 'json_file') {
      const outputPath = join(input.workspacePath, this.config.outputFile ?? 'agent-output.json');
      if (!existsSync(outputPath)) {
        throw new Error(`CLI agent did not write ${outputPath}; stderr: ${stderr.slice(0, 1000)}`);
      }
      parsed = parseAgentResultJson(JSON.parse(readFileSync(outputPath, 'utf8')));
    } else if (outputMode === 'json_stdout') {
      parsed = parseAgentResultJson(extractJsonPayload(stdout));
    } else if (outputMode === 'codex_jsonl') {
      parsed = parseAgentResultJson(extractJsonPayload(collectCodexText(stdout)));
    } else if (outputMode === 'claude_jsonl') {
      parsed = parseAgentResultJson(extractJsonPayload(collectClaudeText(stdout)));
    } else {
      throw new Error(`Unknown CLI output mode: ${outputMode}`);
    }
    const fingerprint: AgentFingerprint = {
      adapter: this.name,
      model: this.config.model ?? this.config.command,
      provider: this.config.provider ?? 'cli',
      promptVersion: this.config.promptVersion ?? 'counterpoint-prompt-1',
      toolset: ['cli_process'],
      contextViewHash: input.contextView.hash,
    };
    return {
      position: parsed.position,
      artifacts: parsed.artifacts,
      fingerprint,
      logs: `cli=${this.config.command} mode=${outputMode} stdout=${stdout.length} bytes stderr=${stderr.length} bytes`,
      cost: 0,
    };
  }
}

function collectCodexText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'error') {
      throw new Error(`codex exec error: ${JSON.stringify(event.payload ?? event)}`);
    }
    if (event.type === 'agent_message' || event.type === 'result') {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (typeof payload.text === 'string') parts.push(payload.text);
    }
  }
  return parts.join('\n');
}

function collectClaudeText(stdout: string): string {
  const parts: string[] = [];
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
    if (event.type === 'result' && typeof event.result === 'string') {
      parts.push(event.result);
    }
  }
  return parts.join('\n');
}

async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(resolveExecutable(input.command), input.args.map(resolveArgument), {
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(input.env ?? {}) },
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const finished = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
  const timer = setTimeout(() => child.kill(), input.timeoutMs);
  try {
    const code = await finished;
    if (code !== 0) {
      throw new Error(
        `CLI agent exited with code ${code}; stderr: ${stderr.slice(0, 2000)}`,
      );
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
