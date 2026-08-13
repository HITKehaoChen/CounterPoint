import type { RiskPolicy } from './autonomy-envelope.ts';

export function classifyRisk(action: string, policy: RiskPolicy): 'low' | 'medium' | 'high' {
  if (policy.highRiskActions.includes(action)) return 'high';
  if (policy.requireHumanGateFor.includes(action)) return 'high';
  if (policy.requireReviewFor.includes(action)) return 'medium';
  return 'low';
}

export function requiresReview(action: string, policy: RiskPolicy): boolean {
  return policy.requireReviewFor.includes(action);
}

export function requiresHumanGate(action: string, policy: RiskPolicy): boolean {
  return policy.highRiskActions.includes(action) || policy.requireHumanGateFor.includes(action);
}
