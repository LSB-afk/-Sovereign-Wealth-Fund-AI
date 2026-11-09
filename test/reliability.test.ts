import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ctx, TOOLS, RulePolicy, runAgent, saveReview, unverifiedNumbers, type Policy } from '../lib/agent.ts';
import { snapshotSource } from '../lib/datasource.ts';
import { checkComparability } from '../lib/peer.ts';
import { toCsv, toMarkdown } from '../lib/report.ts';
import { isDate, sameOrigin } from '../lib/validation.ts';
import type { Review } from '../lib/types.ts';

const ds = snapshotSource();
test('same-origin browser requests work when Next reconstructs its internal host differently', () => {
  assert.equal(sameOrigin(new Request('http://localhost:3100/api/analyze', { headers: { host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100', 'sec-fetch-site': 'same-origin' } })), true);
  assert.equal(sameOrigin(new Request('http://localhost:3100/api/analyze', { headers: { host: '127.0.0.1:3100', origin: 'http://evil.example' } })), false);
  assert.equal(sameOrigin(new Request('http://localhost:3100/api/analyze', { headers: { 'sec-fetch-site': 'cross-site' } })), false);
  assert.equal(isDate('2026-02-30'), false);
});
async function prepared() {
  const ctx = new Ctx('NVDA', '2026-11-07', ds);
  for (const ticker of ['NVDA', 'AMD']) {
    await TOOLS.find((t) => t.name === 'get_company_profile')!.run(ctx, { ticker });
    await ctx.financials(ticker);
  }
  await TOOLS.find((t) => t.name === 'check_comparability')!.run(ctx, { ticker: 'AMD' });
  return ctx;
}
function proposal(ctx: Ctx): Omit<Review, 'author' | 'warnings' | 'verification'> {
  const profile = ctx.sources.filter((s) => s.kind === 'profile').map((s) => s.id);
  const numbers = ctx.sources.filter((s) => s.kind === 'xbrl').map((s) => s.id);
  const j = (sourceIds: string[]) => ({ assessment: 'similar' as const, note: '', sourceIds });
  return { ticker: 'AMD', decision: 'selected', relationship: 'both', reason: '', sourceIds: [...profile, ...numbers], criteria: { product: j(profile), customers: j(profile), scale: j(numbers), growthProfitability: j(numbers), dataSufficiency: j(numbers) } };
}

test('unknown or cross-company citations hold a proposal rather than launder its remaining citations', async () => {
  for (const fault of ['unknown', 'other-company']) {
    const ctx = await prepared();
    const p = proposal(ctx);
    const id = fault === 'unknown' ? 'S999' : ctx.addSource({ ticker: 'INTC', kind: 'filing', title: 'Intel', url: 'https://www.sec.gov/Archives/edgar/data/50863/000005086325000009/intc.htm', filed: '2025-02-01', accessedAt: '2026-11-07' });
    p.sourceIds.push(id);
    saveReview(ctx, p, 'llm');
    assert.equal(ctx.rec('AMD').review!.decision, 'hold', fault);
    assert.equal(ctx.rec('AMD').review!.verification?.status, 'held');
  }
});

test('uncollected numeric claims are held and never copied into published explanations', async () => {
  const ctx = await prepared();
  const p = proposal(ctx); p.reason = 'AMD의 영업이익률은 99.9%';
  saveReview(ctx, p, 'llm');
  assert.equal(ctx.rec('AMD').review!.decision, 'hold');
  assert.ok(!JSON.stringify(ctx.rec('AMD').review).includes('99.9%'));
  assert.deepEqual(unverifiedNumbers('-10.7%', { pct: [10.7], usdB: [], ratios: [] }), ['-10.7%']);
});

test('model-written prose and assessments cannot become official explanations or financial facts', async () => {
  const ctx = await prepared();
  const p = proposal(ctx); p.reason = 'AMD가 NVIDIA를 인수했다'; p.criteria.scale.note = '세계 최대 기업이다'; p.criteria.scale.assessment = 'different';
  saveReview(ctx, p, 'llm');
  const review = ctx.rec('AMD').review!;
  assert.ok(!JSON.stringify(review).includes('인수했다'));
  assert.ok(!JSON.stringify(review).includes('세계 최대'));
  assert.notEqual(review.criteria.scale.assessment, 'different');
  assert.equal(review.verification?.status, 'passed');
});

test('selection without comparability checks or without both companies financial citations is held', async () => {
  const unchecked = await prepared(); unchecked.rec('AMD').issues = undefined;
  saveReview(unchecked, proposal(unchecked), 'llm');
  assert.equal(unchecked.rec('AMD').review!.decision, 'hold');
  const ctx = await prepared(); const p = proposal(ctx);
  p.criteria.scale.sourceIds = ctx.sources.filter((s) => s.kind === 'xbrl' && s.ticker === 'NVDA').map((s) => s.id);
  saveReview(ctx, p, 'llm');
  assert.equal(ctx.rec('AMD').review!.decision, 'hold');
});

test('agent abstention remains held even with valid data and cannot be manually exported', async () => {
  const ctx = await prepared(); const p = proposal(ctx); p.decision = 'hold';
  saveReview(ctx, p, 'llm');
  assert.equal(ctx.rec('AMD').review!.decision, 'hold');
  assert.equal(ctx.rec('AMD').review!.verification.status, 'held');
  const r = await runAgent({ target: 'NVDA', asOf: '2026-11-07', ds, mode: 'demo', policy: new RulePolicy(), modeLabel: 'demo', dataNote: '' });
  r.candidates = r.candidates.map((c) => c.ticker === 'AMD' ? ctx.rec('AMD') : c);
  assert.throws(() => toMarkdown(r, ['AMD'], []));
});

test('future and off-domain evidence cannot pass even with valid source IDs', async () => {
  for (const fault of ['future', 'url']) {
    const ctx = await prepared(); const p = proposal(ctx);
    const s = ctx.sources.find((s) => s.id === p.sourceIds[0])!;
    if (fault === 'future') s.filed = '2027-01-01'; else s.url = 'https://www.sec.gov.evil.example/Archives/edgar/data/1/forged';
    saveReview(ctx, p, 'llm');
    assert.equal(ctx.rec('AMD').review!.decision, 'hold', fault);
  }
});

test('missing target metrics block financial peer selection too', async () => {
  const ctx = await prepared();
  const target = structuredClone(ctx.rec('NVDA').financials!); target.operatingMargin = null;
  const issues = checkComparability(target, ctx.rec('AMD').financials!);
  assert.ok(issues.some((i) => i.level === 'block' && i.code.startsWith('target_')));
});

test('an analysis with no target financials cannot be a passed complete run', async () => {
  const missing = { ...ds, async facts(ticker: string) {
    const loaded = await ds.facts(ticker);
    return ticker === 'NVDA' ? { ...loaded, facts: { ...loaded.facts, facts: {} } } : loaded;
  } };
  const r = await runAgent({ target: 'NVDA', asOf: '2026-11-07', ds: missing, mode: 'demo', policy: new RulePolicy(), modeLabel: 'demo', dataNote: '' });
  assert.equal(r.selected.length, 0);
  assert.notEqual(r.status, 'complete');
  assert.equal(r.reliability.status, 'review_required');
});

test('premature policy completion is not reported as a complete analysis and its prose is withheld', async () => {
  const policy: Policy = { async next() { return { done: 'NVIDIA의 매출은 999조원이다' }; } };
  const r = await runAgent({ target: 'NVDA', asOf: '2026-11-07', ds, mode: 'real', policy, modeLabel: 'test policy', dataNote: '' });
  assert.equal(r.status, 'failed');
  assert.equal(r.reliability?.status, 'review_required');
  assert.ok(!r.summary.includes('999조원'));
  assert.equal(r.selected.length, 0);
});

test('a valid snapshot run publishes deterministic explanations and a reproducible gate report', async () => {
  const r = await runAgent({ target: 'AMD', asOf: '2026-11-07', ds, mode: 'demo', policy: new RulePolicy(), modeLabel: 'demo', dataNote: '' });
  assert.equal(r.status, 'complete');
  assert.equal(r.reliability?.status, 'passed');
  assert.ok(r.selected.length >= 3);
  for (const t of r.selected) assert.equal(r.candidates.find((c) => c.ticker === t)!.review!.verification?.status, 'passed');
});

test('human peer edits cannot export a held candidate and derived values keep all input citations', async () => {
  const r = await runAgent({ target: 'NVDA', asOf: '2026-11-07', ds, mode: 'demo', policy: new RulePolicy(), modeLabel: 'demo', dataNote: '' });
  const csv = toCsv(r, r.selected);
  const growthLine = csv.split('\n').find((line) => line.startsWith('NVDA,target,revenue_growth_yoy,'))!;
  assert.ok(growthLine.includes('https://www.sec.gov/Archives/edgar/data/'));
  assert.match(toMarkdown(r, r.selected, []), /evidence-gate-v1/);
  const peer = r.candidates.find((c) => c.ticker === r.selected[0])!;
  peer.review!.verification.status = 'held';
  assert.throws(() => toMarkdown(r, [peer.ticker], []));
  assert.throws(() => toCsv(r, [peer.ticker]));
});
