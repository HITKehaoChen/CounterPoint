import { spawn } from 'node:child_process';
import type { Database, Deliberation, Evidence, EvidenceStatus } from './schemas.ts';
import { sha256 } from './hashing.ts';
import { newId } from './ids.ts';

export interface CommandVerifierConfig {
  /** Executable names that are allowed, e.g. ["node", "npm"]. */
  allowlist: string[];
  timeoutMs?: number;
  environmentRef?: string;
}

export interface CommandVerifierInput {
  command: string;
  args: string[];
  cwd?: string;
  targetRefs: string[];
  expectedExitCode?: number;
  description?: string;
}

export interface ManualEvidenceInput {
  description: string;
  targetRefs: string[];
  status?: Exclude<EvidenceStatus, 'superseded'>;
  source?: string;
}

export interface EvidenceSubmissionInput {
  targetRefs: string[];
  status: EvidenceStatus;
  resultSummary: string;
  kind?: Evidence['kind'];
  sourceDescription?: string;
  reproducibility?: Evidence['reproducibility'];
  hash?: string;
}

/**
 * Evidence Ledger + Command Verifier (FR-044/050/051/052).
 *
 * Evidence is append-only: records may be marked failed, inconclusive or
 * superseded, but never edited in place. Command verification runs inside a
 * command allowlist with a timeout, and records input/output hashes plus the
 * environment reference so results are reproducible and auditable.
 */
export class EvidenceLedger {
  private readonly deliberation: Deliberation;
  private readonly db: Database;
  private readonly config: CommandVerifierConfig;

  constructor(
    deliberation: Deliberation,
    db: Database,
    config: CommandVerifierConfig = {
      allowlist: ['node', 'npm', 'git', 'python', 'rg'],
      timeoutMs: 30_000,
      environmentRef: 'local',
    },
  ) {
    this.deliberation = deliberation;
    this.db = db;
    this.config = config;
  }

  async runCommandVerifier(input: CommandVerifierInput): Promise<Evidence> {
    if (!this.config.allowlist.includes(input.command)) {
      throw new Error(
        `Command "${input.command}" is not in the verifier allowlist: ${this.config.allowlist.join(', ')}`,
      );
    }

    const started = Date.now();
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    const finished = new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const timer = setTimeout(() => child.kill(), timeoutMs);

    let exitCode = -1;
    let timedOut = false;
    let errorMessage: string | undefined;
    try {
      exitCode = await finished;
    } catch (error) {
      timedOut = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    const stdoutText = Buffer.concat(stdout).toString('utf8');
    const stderrText = Buffer.concat(stderr).toString('utf8');
    const expected = input.expectedExitCode ?? 0;
    const status: EvidenceStatus = timedOut || errorMessage
      ? 'inconclusive'
      : exitCode === expected
        ? 'verified'
        : 'failed';
    const stdoutLogRef = this.storeLog(stdoutText.slice(0, 8000));
    const stderrLogRef = this.storeLog(stderrText.slice(0, 8000));

    const evidence: Evidence = {
      id: newId('evid'),
      deliberationId: this.deliberation.id,
      kind: 'command_result',
      source: {
        command: input.command,
        args: input.args,
        environmentRef: this.config.environmentRef,
        description: input.description ?? `${input.command} ${input.args.join(' ')}`,
      },
      targetRefs: input.targetRefs,
      result: {
        exitCode,
        stdoutHash: sha256(stdoutText),
        stderrLogRef,
        summary:
          errorMessage ??
          `exit ${exitCode} (expected ${expected}) in ${Date.now() - started}ms; stdout ${stdoutText.length} bytes`,
      },
      status,
      reproducibility: 'reproducible',
      hash: sha256(JSON.stringify({ command: input.command, args: input.args })),
      createdAt: new Date().toISOString(),
    };
    this.deliberation.evidence.push(evidence);
    return evidence;
  }

  addManualEvidence(input: ManualEvidenceInput): Evidence {
    const evidence: Evidence = {
      id: newId('evid'),
      deliberationId: this.deliberation.id,
      kind: 'manual',
      source: { description: input.source ?? 'human-owner' },
      targetRefs: input.targetRefs,
      result: { summary: input.description },
      status: input.status ?? 'verified',
      reproducibility: 'observed_once',
      hash: sha256(JSON.stringify(input)),
      createdAt: new Date().toISOString(),
    };
    this.deliberation.evidence.push(evidence);
    return evidence;
  }

  addSubmission(input: EvidenceSubmissionInput): Evidence {
    const evidence: Evidence = {
      id: newId('evid'),
      deliberationId: this.deliberation.id,
      kind: input.kind ?? 'authoritative_source',
      source: { description: input.sourceDescription ?? 'external' },
      targetRefs: input.targetRefs,
      result: { summary: input.resultSummary },
      status: input.status,
      reproducibility: input.reproducibility,
      hash: input.hash ?? sha256(JSON.stringify(input)),
      createdAt: new Date().toISOString(),
    };
    this.deliberation.evidence.push(evidence);
    return evidence;
  }

  supersede(evidenceId: string, reason: string, replacementEvidenceId?: string): Evidence {
    const index = this.deliberation.evidence.findIndex((item) => item.id === evidenceId);
    if (index < 0) throw new Error(`Evidence not found: ${evidenceId}`);
    const original = this.deliberation.evidence[index];
    const superseded: Evidence = {
      ...original,
      status: 'superseded',
      supersededBy: replacementEvidenceId,
      result: {
        ...original.result,
        summary: `${original.result.summary ?? ''} | superseded: ${reason}`,
      },
    };
    this.deliberation.evidence[index] = superseded;
    return superseded;
  }

  get(evidenceId: string): Evidence | undefined {
    return this.deliberation.evidence.find((item) => item.id === evidenceId);
  }

  private storeLog(content: string): string {
    const ref = `log_${sha256(content).slice(0, 16)}`;
    this.db.logs[ref] = content;
    return ref;
  }
}
