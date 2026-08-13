import { runCliProcess } from '../adapters/cli-agent.ts';
import type { Operator, OperatorContext, OperatorResult } from './operator.ts';

export class ToolTaskOperator implements Operator {
  readonly type = 'tool_task' as const;

  async run(ctx: OperatorContext): Promise<OperatorResult> {
    if (ctx.graphNode.operator.type !== 'tool_task') throw new Error('TOOL_TASK_SPEC_REQUIRED');
    const spec = ctx.graphNode.operator;
    if (!ctx.envelope.allowedTools.includes(spec.command)) {
      throw new Error(`Command "${spec.command}" is not in the envelope allowlist: ${ctx.envelope.allowedTools.join(', ')}`);
    }
    const started = Date.now();
    try {
      const { stdout, stderr } = await runCliProcess({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd ?? ctx.workspacePath,
        timeoutMs: ctx.graphNode.allocatedBudget.maxTimeMs,
      });
      const refs = ctx.commit({
        artifacts: [{ logicalName: 'tool-output', type: 'text', content: stdout.slice(0, 200_000), ownerRunId: ctx.nodeRun.id }],
      });
      return {
        status: 'succeeded',
        artifactRefs: refs,
        evidenceRefs: [],
        claimRefs: [],
        opinionRefs: [],
        outputs: { stdoutBytes: stdout.length, stderr },
        usage: { timeMs: Date.now() - started },
      };
    } catch (error) {
      return {
        status: 'failed',
        artifactRefs: [],
        evidenceRefs: [],
        claimRefs: [],
        opinionRefs: [],
        outputs: {},
        usage: { timeMs: Date.now() - started },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
