import type { PlannerInput } from './planner.ts';

export function renderPlannerPrompt(input: PlannerInput): string {
  const lines: string[] = [];
  lines.push('You are a collaboration planner. Design a structured, executable plan for the work item below.');
  lines.push('Output exactly one JSON object matching the CollaborationPlan schema described below. No commentary outside the JSON.');
  lines.push('');
  lines.push('## Work item');
  lines.push(`Title: ${input.workItem.title}`);
  if (input.workItem.goal) lines.push(`Goal: ${input.workItem.goal}`);
  if (input.workItem.constraints.length) lines.push(`Constraints:\n- ${input.workItem.constraints.join('\n- ')}`);
  if (input.workItem.expectedOutcomes.length) lines.push(`Expected outcomes:\n- ${input.workItem.expectedOutcomes.join('\n- ')}`);
  lines.push('');
  lines.push('## Autonomy envelope (hard limits; you cannot exceed them)');
  lines.push(`- maxAgents: ${input.envelope.maxAgents}`);
  lines.push(`- maxParallelism: ${input.envelope.maxParallelism}`);
  lines.push(`- maxRounds: ${input.envelope.maxRounds}`);
  lines.push(`- timeBudgetMs: ${input.envelope.timeBudgetMs}`);
  lines.push(`- allowedTools: ${input.envelope.allowedTools.join(', ') || '(none)'}`);
  lines.push(`- writableScopes: ${input.envelope.writableScopes.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('## Capabilities');
  for (const [capability, descriptor] of input.catalog.byCapability) {
    lines.push(`- ${capability} (${descriptor.adapterKind}): ${descriptor.tools.join(', ')}`);
  }
  lines.push('Use ONLY these exact capability names in capabilityRequirements. Do not invent new capability names.');
  lines.push('');
  lines.push('## Operator kinds');
  lines.push('- agent_task { type, instructions }');
  lines.push('- tool_task { type, command, args }');
  lines.push('- verification { type, command, args, targetRefs }');
  lines.push('- independent_review { type, rubricRef, targetNodeIds }');
  lines.push('- counterpoint_deliberation { type, workerCount, blind, commitReveal, challengeRounds, verificationPolicy, reviewerPolicy }');
  lines.push('- human_gate { type, summary }');
  lines.push('');
  lines.push('## Node contract');
  lines.push('Each node needs: id, role, objective, dependsOn[], inputRefs[], contextPolicy { readScopes[], writeScopes[], visibility, includeObjectTypes[], excludeObjectTypes[] }, capabilityRequirements[], operator, completionCriteria[{id,kind,description,refs}], failurePolicy { maxRetries, onFailure }, allocatedBudget { maxTimeMs }.');
  lines.push('Blind nodes must not share inputRefs with each other. Reviewers must not share capabilities with nodes they review. Evidence completion criteria must carry refs.');
  lines.push('');
  lines.push('## Exact enum values (no synonyms allowed)');
  lines.push('- contextPolicy.visibility: shared | private | blind | sealed');
  lines.push('- failurePolicy.onFailure: fail_node | cancel_pending_children | escalate');
  lines.push('- completionCriteria.kind: evidence | artifact | human_acceptance | claim_supported');
  lines.push('- stopConditions.kind: evidence | artifact | decision | budget_exhausted | human_acceptance');
  lines.push('- stopConditions.targetOutcome: resolved | partially_resolved | needs_evidence | blocked | rejected | escalated');
  lines.push('');
  lines.push('## Required top-level fields (no defaults exist for these)');
  lines.push('id, workItemId, goal, rationale, nodes, stopConditions, budgetAllocation { maxTotalTimeMs, maxTotalAgents, maxTotalRounds }, createdByRunId.');
  if (input.sources.length) {
    lines.push('');
    lines.push('## Sources');
    for (const source of input.sources) lines.push(`- ${source.label} (${source.versionRef}): ${source.excerpt}`);
  }
  if (input.reusableEvidence.length) {
    lines.push('');
    lines.push('## Reusable evidence');
    for (const evidence of input.reusableEvidence) lines.push(`- ${evidence.id} [${evidence.status}]: ${evidence.summary}`);
  }
  if (input.repairContext) {
    lines.push('');
    lines.push('## Previous plan was rejected by the deterministic validator');
    for (const issue of input.repairContext.issues) lines.push(`- ${issue.code}: ${issue.message}`);
    lines.push('Revise the plan to fix every listed issue. Do not repeat the same invalid structure.');
  }
  return lines.join('\n');
}
