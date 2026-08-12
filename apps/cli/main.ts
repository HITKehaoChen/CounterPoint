import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolEngine } from '../../src/protocol-engine.ts';
import { JsonFileStore } from '../../src/store.ts';
import { decisionPackToMarkdown } from '../../src/decision-pack.ts';
import { runDemo } from './demo.ts';
import { AcpAgentAdapter } from '../../src/adapters/acp-agent.ts';
import { CliAgentAdapter } from '../../src/adapters/cli-agent.ts';
import type { AgentRunInput } from '../../src/adapters/agent.ts';

const usage = `counterpoint-cli

Usage:
  node apps/cli/main.ts demo [--local]     Run the end-to-end demo (default mock workers; --local uses the sample process worker)
  node apps/cli/main.ts probe acp <command> [args...]
                                            Probe an ACP-capable coding agent (e.g. claude --acp)
  node apps/cli/main.ts probe cli <command> [args...] [{promptFile} placeholder supported]
                                            Probe a CLI coding agent (e.g. codex exec ...)
  node apps/cli/main.ts export <dbPath> <deliberationId> [outDir]
  node apps/cli/main.ts timeline <dbPath> <deliberationId>
  node apps/cli/main.ts status <dbPath>    List deliberations in a store
`;

function makeEngine(dbPath: string): ProtocolEngine {
  return new ProtocolEngine({
    store: new JsonFileStore(dbPath),
    workspaceRoot: join(process.cwd(), 'data', 'workspaces'),
    resolveAdapter: () => undefined,
  });
}

function probeInput(): { input: AgentRunInput; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), 'counterpoint-probe-'));
  const sourcePath = join(workspace, 'source.txt');
  writeFileSync(sourcePath, 'billing service -> ledger (RPC)\np95 latency budget: 200ms\n', 'utf8');
  const input: AgentRunInput = {
    runId: 'run_probe_1',
    participantId: 'part_probe_1',
    phase: 'blind_run',
    taskPacket: {
      id: 'tp_probe',
      version: 1,
      problem: 'Should the billing module call the ledger synchronously or via events?',
      goals: ['Choose a testable and recoverable integration'],
      constraints: ['No new infrastructure'],
      rubric: {
        items: [{ id: 'correctness', name: 'Correctness under failure', weight: 1 }],
        maxScore: 5,
      },
      sources: ['src_probe'],
      frozenAt: new Date().toISOString(),
      hash: 'probe-hash',
    },
    contextView: {
      id: 'ctx_probe',
      runId: 'run_probe_1',
      phase: 'blind_run',
      visible: {
        authoritySources: ['src_probe@v1'],
        artifacts: ['src_probe@v1'],
        claims: [],
        evidence: [],
      },
      hidden: { agentRuns: ['run_probe_2'], objectTypes: ['position_draft'] },
      tools: { allow: ['read_sources'], deny: ['write_shared'] },
      hash: 'probe-ctx-hash',
    },
    authoritySources: [
      {
        ref: 'src_probe@v1',
        binding: {
          id: 'src_probe',
          type: 'file',
          label: 'probe source',
          path: sourcePath,
          version: 1,
          text: 'billing service -> ledger (RPC)\np95 latency budget: 200ms',
          snapshotHash: 'probe-src-hash',
        },
        content: 'billing service -> ledger (RPC)\np95 latency budget: 200ms',
      },
    ],
    visibleArtifacts: [],
    workspacePath: workspace,
  };
  return { input, cleanup: () => undefined };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'demo': {
      const result = await runDemo({ useLocalWorker: args.includes('--local') });
      console.log(`Deliberation: ${result.deliberationId}`);
      console.log(`Markdown: ${result.packMarkdownPath}`);
      console.log(`JSON: ${result.packJsonPath}`);
      return;
    }
    case 'probe': {
      const [kind, command, ...rest] = args;
      if ((kind !== 'acp' && kind !== 'cli') || !command) {
        console.error('probe requires: probe <acp|cli> <command> [args...]');
        process.exit(1);
      }
      const { input } = probeInput();
      const adapter =
        kind === 'acp'
          ? new AcpAgentAdapter({ command, args: rest, timeoutMs: 180_000 })
          : new CliAgentAdapter({ command, args: rest, timeoutMs: 180_000 });
      console.log(`Probing ${kind} adapter with command: ${command} ${rest.join(' ')}`);
      const result = await adapter.run(input);
      console.log(
        JSON.stringify(
          {
            ok: true,
            adapter: result.fingerprint.adapter,
            model: result.fingerprint.model,
            provider: result.fingerprint.provider,
            summary: result.position.summary,
            claims: result.position.claims.length,
            artifacts: result.artifacts.map((artifact) => artifact.logicalName),
            cost: result.cost,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'export': {
      const [dbPath, deliberationId, outDir = 'data/out'] = args;
      if (!dbPath || !deliberationId) {
        console.error(usage);
        process.exit(1);
      }
      const engine = makeEngine(dbPath);
      const pack = engine.exportDecisionPack(deliberationId);
      const markdownPath = join(outDir, `decision-pack-${deliberationId}.md`);
      const jsonPath = join(outDir, `decision-pack-${deliberationId}.json`);
      writeFileSync(markdownPath, decisionPackToMarkdown(pack), 'utf8');
      writeFileSync(jsonPath, JSON.stringify(pack, null, 2), 'utf8');
      console.log(`Wrote ${markdownPath}`);
      console.log(`Wrote ${jsonPath}`);
      return;
    }
    case 'timeline': {
      const [dbPath, deliberationId] = args;
      if (!dbPath || !deliberationId) {
        console.error(usage);
        process.exit(1);
      }
      const engine = makeEngine(dbPath);
      for (const event of engine.getTimeline(deliberationId)) {
        console.log(`${event.timestamp}  ${event.type.padEnd(28)} ${event.actor}`);
      }
      return;
    }
    case 'status': {
      const [dbPath] = args;
      if (!dbPath || !existsSync(dbPath)) {
        console.error('status requires an existing <dbPath>');
        process.exit(1);
      }
      const engine = makeEngine(dbPath);
      for (const deliberation of engine.deliberationDatabase.deliberations) {
        console.log(
          `${deliberation.id}  state=${deliberation.state}  positions=${deliberation.positions.length}  runs=${deliberation.runs.length}`,
        );
      }
      return;
    }
    default:
      console.log(usage);
  }
}

await main();
