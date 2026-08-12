import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { resolveArgument, resolveExecutable } from './command.ts';

export interface AcpClientConfig {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  agentInfo: { name?: string; title?: string; version?: string };
  authMethods: unknown[];
}

export interface AcpPromptUpdate {
  kind: 'agent_message' | 'tool_call' | 'usage' | 'plan' | 'status' | 'unknown';
  text?: string;
  cost?: number;
}

export interface AcpPromptResult {
  stopReason: string;
  text: string;
  cost?: number;
  updateCount: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal ACP (Agent Client Protocol) v1 client over JSON-RPC 2.0 / NDJSON
 * stdio. Implements the baseline session lifecycle:
 * initialize -> session/new -> session/prompt (+ session/update notifications)
 * with session/cancel support for cancellation.
 */
export class AcpClient {
  private readonly config: AcpClientConfig;
  private child: ChildProcessWithoutNullStreams | undefined;
  private rl: Interface | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private stderr = '';
  private updateHandler: ((update: AcpPromptUpdate) => void) | undefined;
  private lastError: string | undefined;

  constructor(config: AcpClientConfig) {
    this.config = config;
  }

  start(): void {
    if (this.child) return;
    this.child = spawn(
      resolveExecutable(this.config.command),
      (this.config.args ?? []).map(resolveArgument),
      {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.config.env ?? {}) },
      },
    );
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_000);
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.lastError = `Agent wrote non-JSON line: ${trimmed.slice(0, 200)}`;
        return;
      }
      this.handleMessage(message);
    });
    this.child.on('close', () => {
      const error = new Error(
        `ACP agent process exited (${this.lastError ?? 'no error'}); stderr: ${this.stderr.slice(0, 1000)}`,
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<AcpInitializeResult> {
    this.start();
    const result = (await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: {
        name: 'counterpoint',
        title: 'Counterpoint Protocol Engine',
        version: '0.1.0',
      },
    })) as Record<string, unknown>;
    if (typeof result.protocolVersion !== 'number' || result.protocolVersion > 1) {
      throw new Error(
        `Unsupported ACP protocol version negotiated: ${String(result.protocolVersion)}`,
      );
    }
    return {
      protocolVersion: result.protocolVersion as number,
      agentCapabilities: (result.agentCapabilities ?? {}) as Record<string, unknown>,
      agentInfo: (result.agentInfo ?? {}) as AcpInitializeResult['agentInfo'],
      authMethods: Array.isArray(result.authMethods) ? result.authMethods : [],
    };
  }

  async newSession(input: {
    cwd: string;
    additionalWorkspaceRoots?: string[];
  }): Promise<string> {
    const result = (await this.request('session/new', {
      cwd: input.cwd,
      mcpServers: [],
      additionalWorkspaceRoots: input.additionalWorkspaceRoots ?? [],
    })) as Record<string, unknown>;
    if (typeof result.sessionId !== 'string' || !result.sessionId) {
      throw new Error(`ACP session/new did not return a sessionId: ${JSON.stringify(result)}`);
    }
    return result.sessionId;
  }

  async prompt(input: {
    sessionId: string;
    text: string;
    timeoutMs?: number;
    onUpdate?: (update: AcpPromptUpdate) => void;
  }): Promise<AcpPromptResult> {
    this.updateHandler = input.onUpdate;
    let text = '';
    let cost: number | undefined;
    let updateCount = 0;
    this.updateHandler = (update) => {
      updateCount++;
      if (update.kind === 'agent_message' && update.text) text += update.text;
      if (update.cost !== undefined) cost = update.cost;
      input.onUpdate?.(update);
    };
    try {
      const result = (await this.request('session/prompt', {
        sessionId: input.sessionId,
        prompt: [{ type: 'text', text: input.text }],
      })) as Record<string, unknown>;
      const stopReason = String(result.stopReason ?? 'unknown');
      return { stopReason, text, cost, updateCount };
    } finally {
      this.updateHandler = undefined;
    }
  }

  cancel(sessionId: string): void {
    this.sendNotification('session/cancel', { sessionId });
  }

  close(): void {
    this.rl?.close();
    this.child?.kill();
    this.child = undefined;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeoutMs = this.config.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    if (record.method === 'session/update') {
      const params = record.params as Record<string, unknown> | undefined;
      const update = params?.update as Record<string, unknown> | undefined;
      this.updateHandler?.(normalizeUpdate(update));
      return;
    }
    if (typeof record.id === 'number') {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.error) {
        pending.reject(new Error(`ACP error for request ${record.id}: ${JSON.stringify(record.error)}`));
      } else {
        pending.resolve(record.result);
      }
    }
  }

  private sendNotification(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: unknown): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('ACP agent is not running');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function normalizeUpdate(update: Record<string, unknown> | undefined): AcpPromptUpdate {
  if (!update) return { kind: 'unknown' };
  const kind = String(update.sessionUpdate ?? '');
  if (kind === 'agent_message_chunk' || kind === 'agent_message') {
    const content = update.content as Record<string, unknown> | undefined;
    return {
      kind: 'agent_message',
      text: typeof content?.text === 'string' ? content.text : undefined,
    };
  }
  if (kind === 'usage_update') {
    const cost = update.cost as Record<string, unknown> | undefined;
    return {
      kind: 'usage',
      cost:
        typeof cost?.amount === 'number'
          ? cost.amount
          : undefined,
    };
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') return { kind: 'tool_call' };
  if (kind === 'plan') return { kind: 'plan' };
  if (kind === 'status_update') return { kind: 'status' };
  return { kind: 'unknown' };
}
