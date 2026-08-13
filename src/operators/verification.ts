import { sha256 } from '../hashing.ts';
import { newId } from '../ids.ts';
import { runCliProcess } from '../adapters/cli-agent.ts';
import type { Evidence } from '../schemas.ts';
import type { Operator, OperatorContext, OperatorResult } from './operator.ts';

export class VerificationOperator implements Operator {
  readonly type = 'verification' as const;

  async run(ctx: OperatorContext): Promise<OperatorResult> {
    if (ctx.graphNode.operator.type !== 'verification') throw new Error('VERIFICATION_SPEC_REQUIRED');
    const spec = ctx.graphNode.operator;
    if (!ctx.envelope.allowedTools.includes(spec.command)) {
      throw new Error(`Command "${spec.command}" is not in the envelope allowlist: ${ctx.envelope.allowedTools.join(', ')}`);
    }
    const started = Date.now();
    let status: Evidence['status'] = 'verified';
    let summary = '';
    let exitCode = 0;
    try {
      const { stdout } = await runCliProcess({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd ?? ctx.workspacePath,
        timeoutMs: ctx.graphNode.allocatedBudget.maxTimeMs,
      });
      summary = `exit 0 in ${Date.now() - started}ms; stdout ${stdout.length} bytes`;
    } catch (error) {
      status = 'failed';
      exitCode = -1;
      summary = error instanceof Error ? error.message : String(error);
    }
    const evidence: Evidence = {
      id: newId('evid'),
      workItemId: ctx.workItem.id,
      planId: ctx.nodeRun.planId,
      nodeRunId: ctx.nodeRun.id,
      kind: 'command_result',
      source: { command: spec.command, args: spec.args, description: `verification for ${ctx.graphNode.objective}` },
      targetRefs: [...spec.targetRefs],
      result: { exitCode, summary },
      status,
      reproducibility: 'reproducible',
      hash: sha256(JSON.stringify({ command: spec.command, args: spec.args })),
      createdAt: new Date().toISOString(),
    };
    ctx.commit({ evidence: [evidence] });
    return {
      status: status === 'verified' ? 'succeeded' : 'failed',
      artifactRefs: [],
      evidenceRefs: [evidence.id],
      claimRefs: [],
      opinionRefs: [],
      outputs: { evidenceId: evidence.id, exitCode },
      usage: { timeMs: Date.now() - started },
      error: status === 'verified' ? undefined : summary,
    };
  }
}
