import type { AgentRunResult } from './agent.ts';

/**
 * Extracts the first JSON object from agent output. Supports:
 * - fenced code blocks (```json ... ```)
 * - a JSON object embedded in prose (takes the first balanced object)
 * - pure JSON text
 */
export function extractJsonPayload(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through to generic extraction
    }
  }
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`No JSON object found in agent output (${text.length} chars)`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          throw new Error(`Extracted JSON is not valid: ${candidate.slice(0, 200)}...`);
        }
      }
    }
  }
  throw new Error('No balanced JSON object found in agent output');
}

export interface ParsedAgentOutput {
  position: AgentRunResult['position'];
  artifacts: AgentRunResult['artifacts'];
}

export function parseAgentResultJson(payload: unknown): ParsedAgentOutput {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`Agent output JSON must be an object, got ${typeof payload}`);
  }
  const record = payload as Record<string, unknown>;
  const position = record.position as AgentRunResult['position'];
  if (!position || typeof position !== 'object') {
    throw new Error('Agent output JSON is missing "position"');
  }
  if (typeof position.summary !== 'string' || !Array.isArray(position.claims)) {
    throw new Error('Agent output position must include summary and claims');
  }
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  return {
    position: position as AgentRunResult['position'],
    artifacts: artifacts as AgentRunResult['artifacts'],
  };
}

export function parseAgentResultText(text: string): ParsedAgentOutput {
  return parseAgentResultJson(extractJsonPayload(text));
}
