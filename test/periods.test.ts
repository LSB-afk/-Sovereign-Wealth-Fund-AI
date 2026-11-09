import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFinancials, growth, ratio } from '../lib/financials.ts';
import type { CompanyFacts, XbrlFact } from '../lib/types.ts';

const fact = (changes: Partial<XbrlFact> = {}): XbrlFact => ({
  start: '2024-01-01', end: '2024-12-31', val: 100,
  accn: '0000000001-25-000001', form: '10-K', filed: '2025-02-01', ...changes,
});
const facts = (metrics: Record<string, XbrlFact[]>): CompanyFacts => ({
  cik: 1, entityName: 'X', taxonomies: ['us-gaap'],
  facts: { 'us-gaap': Object.fromEntries(Object.entries(metrics).map(([name, values]) => [name, { units: { USD: values } }])) },
});

test('different annual start dates cannot become same-period margins or overwrite revenue period labels', () => {
  const result = computeFinancials('X', facts({
    Revenues: [fact(), fact({ start: '2023-01-01', end: '2023-12-31', val: 80 })],
    OperatingIncomeLoss: [fact({ start: '2023-12-20', val: 30 })],
    ResearchAndDevelopmentExpense: [fact({ start: '2023-12-25', val: 10 })],
  }), '2025-06-01', 'now');
  assert.equal(result.latest!.periodStart, '2024-01-01');
  assert.equal(result.latest!.values.revenue!.value, 100);
  assert.equal(result.operatingMargin, null);
  assert.equal(result.rndRatio, null);
  assert.equal(result.latest!.values.operatingIncome, undefined);
  assert.equal(result.latest!.values.rnd, undefined);
  assert.ok(result.missing.includes('operatingIncome'));
  assert.ok(result.missing.includes('rnd'));
  assert.ok(result.notes.some((note) => note.includes('기간')));
});

test('prior metrics must match the exact prior revenue period, not just an approximately annual gap', () => {
  const result = computeFinancials('X', facts({
    Revenues: [fact(), fact({ start: '2023-01-01', end: '2023-12-31', val: 80 })],
    OperatingIncomeLoss: [fact({ val: 20 }), fact({ start: '2023-01-01', end: '2023-12-30', val: 15 })],
  }), '2025-06-01', 'now');
  assert.equal(result.revenueGrowth, 0.25);
  assert.equal(result.operatingMargin, 0.2);
  assert.equal(result.prior!.periodStart, '2023-01-01');
  assert.equal(result.prior!.periodEnd, '2023-12-31');
  assert.equal(result.prior!.values.revenue!.value, 80);
  assert.equal(result.prior!.values.operatingIncome, undefined);
});

test('ambiguous revenue periods with the same end date are withheld regardless of input order', () => {
  const entries = [fact({ start: '2024-01-01', val: 100 }), fact({ start: '2023-12-25', val: 105 })];
  for (const values of [entries, [...entries].reverse()]) {
    const result = computeFinancials('X', facts({ Revenues: values }), '2025-06-01', 'now');
    assert.equal(result.latest, null);
    assert.equal(result.revenueGrowth, null);
    assert.ok(result.missing.includes('revenue'));
    assert.ok(result.notes.length > 0);
  }
});

test('malformed dates and nonfinite facts cannot produce published raw values', () => {
  for (const invalid of [fact({ val: Number.POSITIVE_INFINITY }), fact({ filed: '2025-02-30' }), fact({ end: '2025-01-31', filed: '2025-01-01' })]) {
    const result = computeFinancials('X', facts({ Revenues: [invalid] }), '2025-06-01', 'now');
    assert.equal(result.latest, null);
    assert.ok(result.missing.includes('revenue'));
    assert.ok(result.notes.length > 0);
  }
});

test('arithmetic overflow becomes missing instead of Infinity in derived financial ratios', () => {
  assert.equal(growth(1e308, 1e-308), null);
  assert.equal(ratio(1e308, 1e-308), null);
  assert.equal(growth(Number.NaN, 1), null);
  assert.equal(ratio(1, Number.POSITIVE_INFINITY), null);
});
