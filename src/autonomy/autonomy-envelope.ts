import { z } from 'zod';
import { newId } from '../ids.ts';

export const NetworkPolicySchema = z.enum(['deny', 'allowlist', 'allow']);
export const RiskPolicySchema = z.object({
  highRiskActions: z.array(z.string()).default([]),
  requireReviewFor: z.array(z.string()).default([]),
  requireHumanGateFor: z.array(z.string()).default([]),
});
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

export const SharingPolicySchema = z.object({
  defaultVisibility: z.enum(['shared', 'private', 'blind', 'sealed']).default('shared'),
  allowedVisibility: z
    .array(z.enum(['shared', 'private', 'blind', 'sealed']))
    .default(['shared', 'private', 'blind', 'sealed']),
});

export const AutonomyEnvelopeSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1).default('default'),
  maxAgents: z.number().int().positive(),
  maxParallelism: z.number().int().positive(),
  maxRounds: z.number().int().nonnegative(),
  tokenBudget: z.number().positive().optional(),
  costBudget: z.number().positive().optional(),
  timeBudgetMs: z.number().int().positive(),
  allowedTools: z.array(z.string()).default([]),
  allowedActions: z.array(z.string()).default([]),
  writableScopes: z.array(z.string()).default([]),
  networkPolicy: NetworkPolicySchema.default('deny'),
  riskPolicy: RiskPolicySchema.default({ highRiskActions: [], requireReviewFor: [], requireHumanGateFor: [] }),
  sharingPolicy: SharingPolicySchema.default({
    defaultVisibility: 'shared',
    allowedVisibility: ['shared', 'private', 'blind', 'sealed'],
  }),
});
export type AutonomyEnvelope = z.infer<typeof AutonomyEnvelopeSchema>;
export type AutonomyEnvelopeOverrides = Partial<
  Pick<AutonomyEnvelope, 'maxAgents' | 'maxParallelism' | 'maxRounds' | 'tokenBudget' | 'costBudget' | 'timeBudgetMs' | 'allowedTools' | 'allowedActions' | 'writableScopes' | 'networkPolicy' | 'riskPolicy' | 'sharingPolicy'>
>;

export function defaultAutonomyEnvelope(workspaceId: string): AutonomyEnvelope {
  return AutonomyEnvelopeSchema.parse({
    id: newId('env'),
    workspaceId,
    maxAgents: 4,
    maxParallelism: 2,
    maxRounds: 3,
    timeBudgetMs: 20 * 60_000,
    allowedTools: ['node', 'npm', 'git', 'rg', 'python'],
    allowedActions: ['read_sources', 'write_scratch', 'run_tests'],
    writableScopes: ['data/scratch'],
    networkPolicy: 'deny',
    riskPolicy: { highRiskActions: ['git push'], requireReviewFor: [], requireHumanGateFor: ['git push'] },
  });
}

const NETWORK_ORDER: Record<string, number> = { allow: 2, allowlist: 1, deny: 0 };

export function tightenEnvelope(base: AutonomyEnvelope, overrides: AutonomyEnvelopeOverrides): AutonomyEnvelope {
  const next: AutonomyEnvelope = { ...base };
  for (const key of ['maxAgents', 'maxParallelism', 'maxRounds', 'tokenBudget', 'costBudget', 'timeBudgetMs'] as const) {
    const value = overrides[key];
    if (value === undefined) continue;
    const current = base[key] as number | undefined;
    if (current !== undefined && (value as number) > current) {
      throw new Error(`Cannot widen ${key} from ${current} to ${value}`);
    }
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  for (const key of ['allowedTools', 'allowedActions', 'writableScopes'] as const) {
    const value = overrides[key];
    if (value === undefined) continue;
    const missing = value.filter((item) => !base[key].includes(item));
    if (missing.length) throw new Error(`Cannot widen ${key}: not in base ${missing.join(', ')}`);
    next[key] = [...value];
  }
  if (overrides.networkPolicy !== undefined) {
    if (NETWORK_ORDER[overrides.networkPolicy] > NETWORK_ORDER[base.networkPolicy]) {
      throw new Error(`Cannot widen networkPolicy from ${base.networkPolicy} to ${overrides.networkPolicy}`);
    }
    next.networkPolicy = overrides.networkPolicy;
  }
  if (overrides.riskPolicy !== undefined) {
    next.riskPolicy = {
      highRiskActions: [...new Set([...base.riskPolicy.highRiskActions, ...overrides.riskPolicy.highRiskActions])],
      requireReviewFor: [...new Set([...base.riskPolicy.requireReviewFor, ...overrides.riskPolicy.requireReviewFor])],
      requireHumanGateFor: [...new Set([...base.riskPolicy.requireHumanGateFor, ...overrides.riskPolicy.requireHumanGateFor])],
    };
  }
  if (overrides.sharingPolicy !== undefined) {
    const allowed = overrides.sharingPolicy.allowedVisibility ?? base.sharingPolicy.allowedVisibility;
    const missing = allowed.filter((item) => !base.sharingPolicy.allowedVisibility.includes(item));
    if (missing.length) throw new Error(`Cannot widen sharing visibility: ${missing.join(', ')}`);
    next.sharingPolicy = {
      defaultVisibility: overrides.sharingPolicy.defaultVisibility ?? base.sharingPolicy.defaultVisibility,
      allowedVisibility: [...allowed],
    };
  }
  return AutonomyEnvelopeSchema.parse(next);
}
