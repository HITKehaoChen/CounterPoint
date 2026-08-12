// Fake ACP v1 agent server over NDJSON/stdio for adapter tests.
// Supports: initialize, session/new, session/prompt, session/cancel.
import { createInterface } from 'node:readline';

const delayMs = Number(process.env.FAKE_ACP_DELAY_MS ?? 0);
let pendingPrompt = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

const submission = {
  position: {
    summary: 'Fake ACP worker recommends synchronous calls with retries.',
    claims: [
      {
        id: 'acp-1',
        statement: 'Synchronous calls preserve the transaction boundary.',
        type: 'fact',
        evidenceRefs: [],
        confidence: 0.8,
      },
      {
        id: 'acp-2',
        statement: 'Retries must be idempotent.',
        type: 'risk',
        evidenceRefs: [],
        confidence: 0.7,
      },
    ],
    unknowns: ['Peak load'],
    artifactRefs: [],
    decisionConditions: ['Revisit if latency budget shrinks'],
    confidence: 0.75,
  },
  artifacts: [
    {
      logicalName: 'acp-design',
      type: 'markdown',
      content: '# ACP design note',
      visibility: 'shared',
    },
  ],
};

const jsonText = JSON.stringify(submission, null, 2);
const part1 = 'I analyzed the sources. Here is my submission:\n```json\n' + jsonText.slice(0, Math.floor(jsonText.length / 2));
const part2 = jsonText.slice(Math.floor(jsonText.length / 2)) + '\n```\n';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        mcpCapabilities: {},
        sessionCapabilities: {},
      },
      agentInfo: { name: 'fake-acp-agent', title: 'Fake ACP Agent', version: '1.0.0' },
      authMethods: [],
    });
    return;
  }
  if (message.method === 'session/new') {
    respond(message.id, { sessionId: 'sess_fake_001' });
    return;
  }
  if (message.method === 'session/cancel') {
    if (pendingPrompt !== null) {
      const id = pendingPrompt;
      pendingPrompt = null;
      respond(id, { stopReason: 'cancelled' });
    }
    return;
  }
  if (message.method === 'session/prompt') {
    pendingPrompt = message.id;
    setTimeout(() => {
      if (pendingPrompt !== message.id) return;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: 'usage_update',
            used: 1000,
            size: 10000,
            cost: { amount: 0.042, currency: 'USD' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_1',
            title: 'reading sources',
            kind: 'read',
            status: 'completed',
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_1',
            content: { type: 'text', text: part1 },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_1',
            content: { type: 'text', text: part2 },
          },
        },
      });
      pendingPrompt = null;
      respond(message.id, { stopReason: 'end_turn' });
    }, delayMs);
  }
});
