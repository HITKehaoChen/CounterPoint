import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger } from '../../src/execution/budget-ledger.ts';
import { validEnvelope } from '../helpers/plan-fixtures.ts';

test('parallel reservations cannot oversell the envelope time budget', () => {
  const ledger = new BudgetLedger(validEnvelope({ timeBudgetMs: 100 }));
  ledger.reserve('nr_a', { maxTimeMs: 60 });
  assert.throws(() => ledger.reserve('nr_b', { maxTimeMs: 60 }), /BUDGET_EXCEEDED/);
});

test('settle records actual usage and release returns the remainder', () => {
  const ledger = new BudgetLedger(validEnvelope({ timeBudgetMs: 1000 }));
  ledger.reserve('nr_a', { maxTimeMs: 100 });
  ledger.settle('nr_a', { timeMs: 40 });
  ledger.release('nr_a');
  assert.equal(ledger.snapshot().totalSettledTimeMs, 40);
  ledger.reserve('nr_b', { maxTimeMs: 50 });
  assert.equal(ledger.snapshot().reservations['nr_b']?.reservedTimeMs, 50);
});

test('settle beyond the reserved node budget throws', () => {
  const ledger = new BudgetLedger(validEnvelope({ timeBudgetMs: 1000 }));
  ledger.reserve('nr_a', { maxTimeMs: 100 });
  assert.throws(() => ledger.settle('nr_a', { timeMs: 101 }), /NODE_BUDGET_EXCEEDED/);
});

test('ledger snapshot restores reservations and settled totals', () => {
  const first = new BudgetLedger(validEnvelope({ timeBudgetMs: 100 }));
  first.reserve('nr_a', { maxTimeMs: 99 });
  first.settle('nr_a', { timeMs: 20 });
  const restored = new BudgetLedger(validEnvelope({ timeBudgetMs: 100 }), first.snapshot());
  assert.equal(restored.snapshot().totalSettledTimeMs, 20);
  assert.equal(restored.canReserve({ maxTimeMs: 90 }), false);
  assert.equal(restored.canReserve({ maxTimeMs: 80 }), false);
  assert.equal(restored.canReserve({ maxTimeMs: 79 }), true);
});

test('canRetry counts reserve calls against maxRetries', () => {
  const ledger = new BudgetLedger(validEnvelope({ timeBudgetMs: 1000 }));
  ledger.reserve('nr_a', { maxTimeMs: 10 });
  assert.equal(ledger.canRetry('nr_a', 1), true);
  ledger.release('nr_a');
  ledger.reserve('nr_a', { maxTimeMs: 10 });
  assert.equal(ledger.canRetry('nr_a', 1), false);
});

test('duplicate reservation for an active run is rejected', () => {
  const ledger = new BudgetLedger(validEnvelope({ timeBudgetMs: 1000 }));
  ledger.reserve('nr_a', { maxTimeMs: 10 });
  assert.throws(() => ledger.reserve('nr_a', { maxTimeMs: 10 }), /DUPLICATE_RESERVATION/);
});

test('settle is atomic: a budget rejection leaves totals and reservation intact', () => {
  const ledger = new BudgetLedger(validEnvelope({ timeBudgetMs: 1000, costBudget: 1 }));
  ledger.reserve('nr_a', { maxTimeMs: 100 });
  assert.throws(() => ledger.settle('nr_a', { timeMs: 10, costUsd: 2 }), /BUDGET_EXCEEDED/);
  assert.equal(ledger.snapshot().totalSettledCostUsd, 0);
  assert.equal(ledger.snapshot().totalSettledTimeMs, 0);
  assert.ok(ledger.snapshot().reservations['nr_a']);
  ledger.release('nr_a');
  assert.equal(ledger.snapshot().reservations['nr_a'], undefined);
});

test('snapshot restores retry counts', () => {
  const first = new BudgetLedger(validEnvelope({ timeBudgetMs: 1000 }));
  first.reserve('nr_a', { maxTimeMs: 10 });
  first.release('nr_a');
  first.reserve('nr_a', { maxTimeMs: 10 });
  const restored = new BudgetLedger(validEnvelope({ timeBudgetMs: 1000 }), first.snapshot());
  assert.equal(restored.canRetry('nr_a', 1), false);
});
