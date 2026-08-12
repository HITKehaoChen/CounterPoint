import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFingerprintSchema } from '../schemas.ts';
import type { AgentAdapter, AgentRunInput, AgentRunResult } from './agent.ts';
import type { AgentFingerprint } from '../schemas.ts';

export interface LocalProcessAgentConfig {
  /** Executable, e.g. "node". */
  command: string;
  /** Extra fixed arguments. The input JSON path is appended last. */
  args?: string[];
  timeoutMs?: number;
}

export const LOCAL_PROCESS_OUTPUT_FILE = 'agent-output.json';

/**
 * Local Process Adapter (FR-010/FR-011): runs any CLI Agent in the isolated
 * workspace. The Agent receives a JSON task on stdin/file and must write
 * `agent-output.json` in the workspace. Used with our sample worker or any
 * CLI agent that implements the same contract.
 */
export class LocalProcessAgentAdapter implements AgentAdapter {
  readonly name = 'local-process-agent';
  private readonly config: LocalProcessAgentConfig;

  constructor(config: LocalProcessAgentConfig) {
    this.config = config;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const inputPath = join(input.workspacePath, 'agent-input.json');
    writeFileSync(
      inputPath,
      JSON.stringify(
        {
          runId: input.runId,
          phase: input.phase,
          taskPacket: input.taskPacket,
          contextView: input.contextView,
          authoritySources: input.authoritySources,
          visibleArtifacts: input.visibleArtifacts,
          workspacePath: input.workspacePath,
        },
        null,
        2,
      ),
      'utf8',
    );

    const timeoutMs = this.config.timeoutMs ?? 60_000;
    const child = spawn(this.config.command, [...(this.config.args ?? []), inputPath], {
      cwd: input.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
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

    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);

    try {
      const exitCode = await finished;
      if (exitCode !== 0) {
        throw new Error(
          `Local agent exited with code ${exitCode}; stderr: ${stderr.slice(0, 2000)}`,
        );
      }
      const outputPath = join(input.workspacePath, LOCAL_PROCESS_OUTPUT_FILE);
      if (!existsSync(outputPath)) {
        throw new Error(`Agent did not write ${LOCAL_PROCESS_OUTPUT_FILE}`);
      }
      const output = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        position?: AgentRunResult['position'];
        artifacts?: AgentRunResult['artifacts'];
        fingerprint?: AgentFingerprint;
        logs?: string;
        cost?: number;
      };
      if (!output.position) throw new Error('Agent output missing position');
      const fingerprint = AgentFingerprintSchema.parse({
        adapter: this.name,
        ...(output.fingerprint ?? {}),
        contextViewHash: input.contextView.hash,
      });
      return {
        position: output.position,
        artifacts: output.artifacts ?? [],
        fingerprint,
        logs: output.logs ?? stdout.slice(0, 4000),
        cost: output.cost ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
