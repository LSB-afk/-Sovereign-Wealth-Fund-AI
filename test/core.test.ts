import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFinancials, growth, ratio } from '../lib/financials.ts';
import { latestAnnualFiling } from '../lib/edgar.ts';
import { Ctx, RulePolicy, ToolInputError, runAgent, saveReview, unverifiedNumbers, type Policy } from '../lib/agent.ts';
import { snapshotSource, type DataSource } from '../lib/datasource.ts';
import { toCsv, toMarkdown } from '../lib/report.ts';
import type { AnnualFiling, CompanyFacts, XbrlFact } from '../lib/types.ts';

const fact = (o: Partial<XbrlFact>): XbrlFact => ({ start: '2024-01-01', end: '2024-12-31', val: 100, accn: '0000000000-25-000001', form: '10-K', filed: '2025-02-01', ...o });
const facts = (concepts: Record<string, XbrlFact[]>, extraUnits: Record<string, Record<string, XbrlFact[]>> = {}): CompanyFacts => ({
  cik: 1, entityName: 'X', taxonomies: ['us-gaap'],
  facts: { 'us-gaap': Object.fromEntries(Object.entries(concepts).map(([k, v]) => [k, { units: { USD: v, ...(extraUnits[k] ?? {}) } }])) },
});

test('growth, margin and ratio are computed in code; bad denominators give null', () => {
  assert.equal(growth(120, 100), 0.2);
  assert.equal(ratio(30, 120), 0.25);
  assert.equal(growth(120, null), null);
  assert.equal(growth(120, 0), null);
  assert.equal(ratio(5, -1), null);
});

test('annual period handling: quarterly values inside a 10-K are dropped, 53-week years kept, non-USD units ignored', () => {
  const cf = facts({
    Revenues: [
      fact({ start: '2023-01-01', end: '2023-12-31', val: 100, filed: '2025-02-01' }),
      fact({ start: '2023-12-30', end: '2025-01-04', val: 130, filed: '2025-02-01' }), // 371 days (53 weeks)
      fact({ start: '2024-10-01', end: '2025-01-04', val: 999, filed: '2025-02-01' }), // quarter in a 10-K
    ],
    OperatingIncomeLoss: [fact({ start: '2023-12-30', end: '2025-01-04', val: 26 })],
  }, { Revenues: { TWD: [fact({ start: '2023-12-30', end: '2025-01-04', val: 5000 })] } });
  const f = computeFinancials('X', cf, '2025-06-30', 'now');
  assert.equal(f.latest!.periodEnd, '2025-01-04');
  assert.equal(f.latest!.values.revenue!.value, 130);
  assert.equal(f.latest!.values.revenue!.unit, 'USD');
  assert.equal(f.prior!.values.revenue!.value, 100);
  assert.ok(Math.abs(f.revenueGrowth! - 0.3) < 1e-12);
  assert.equal(f.operatingMargin, 0.2);
});

test('missing data stays missing, never estimated', () => {
  const f = computeFinancials('X', facts({ Revenues: [fact({})] }), '2025-06-30', 'now');
  assert.deepEqual(f.missing.sort(), ['operatingIncome', 'rnd', 'revenue_prior_year'].sort());
  assert.equal(f.operatingMargin, null);
  assert.equal(f.revenueGrowth, null);
  const ifrs = computeFinancials('T', { cik: 2, entityName: 'T', taxonomies: ['dei', 'ifrs-full'], facts: {} }, '2025-06-30', 'now');
  assert.equal(ifrs.latest, null);
  assert.match(ifrs.notes[0], /US GAAP/);
});

test('as-of date: filings published after the analysis date are excluded', () => {
  const cf = facts({
    Revenues: [
      fact({ start: '2023-01-01', end: '2023-12-31', val: 90, filed: '2024-02-01', accn: 'a' }),
      fact({ start: '2024-01-01', end: '2024-12-31', val: 100, filed: '2025-02-01', accn: 'b' }),
    ],
  });
  const before = computeFinancials('X', cf, '2025-01-31', 'now');
  assert.equal(before.latest!.periodEnd, '2023-12-31');
  assert.equal(computeFinancials('X', cf, '2025-02-01', 'now').latest!.periodEnd, '2024-12-31');
  const filings: AnnualFiling[] = [
    { form: '10-K', filed: '2025-02-01', reportDate: '2024-12-31', accn: 'b', primaryDocument: '', url: 'u2', indexUrl: '' },
    { form: '10-K', filed: '2024-02-01', reportDate: '2023-12-31', accn: 'a', primaryDocument: '', url: 'u1', indexUrl: '' },
  ];
  assert.equal(latestAnnualFiling(filings, '2025-01-31')!.accn, 'a');
  assert.equal(latestAnnualFiling(filings, '2024-01-01'), null);
});

test('duplicates and restatements: latest filing wins, same-day amendment wins, superseded value noted', () => {
  const cf = facts({
    Revenues: [
      fact({ val: 100, filed: '2025-02-01', form: '10-K', accn: 'orig' }),
      fact({ val: 101, filed: '2025-02-01', form: '10-K/A', accn: 'amend' }),
      fact({ start: '2023-01-01', end: '2023-12-31', val: 80, filed: '2024-02-01', accn: 'old' }),
      fact({ start: '2023-01-01', end: '2023-12-31', val: 82, filed: '2025-02-01', accn: 'orig' }), // restated comparative
    ],
  });
  const f = computeFinancials('X', cf, '2025-06-30', 'now');
  assert.equal(f.latest!.values.revenue!.value, 101);
  assert.equal(f.latest!.values.revenue!.form, '10-K/A');
  assert.equal(f.prior!.values.revenue!.value, 82);
  assert.ok(f.notes.some((n) => n.includes('대체됨')));
});

// ---- agent loop: failures and limits ----
const snap = snapshotSource();
function flaky(failTimes: number, err: () => Error): DataSource & { calls: number } {
  const ds = { ...snap, calls: 0 } as DataSource & { calls: number };
  ds.facts = async (t) => { ds.calls++; if (ds.calls <= failTimes) throw err(); return snap.facts(t); };
  return ds;
}
const once = (calls: { name: string; input: Record<string, unknown> }[]): Policy => {
  let sent = false;
  return { async next() { if (sent) return { done: 'ok' }; sent = true; return { calls: calls.map((c, i) => ({ id: `t${i}`, ...c })) }; } };
};
const base = { target: 'NVDA', asOf: '2026-11-07', mode: 'demo' as const, modeLabel: 'test', dataNote: '' };

test('transient tool failure is retried up to the limit', async () => {
  const ds = flaky(1, () => new Error('EDGAR 503'));
  const r = await runAgent({ ...base, ds, policy: once([{ name: 'get_financials', input: { ticker: 'NVDA' } }]) });
  assert.equal(r.toolLog[0].ok, true);
  assert.equal(r.toolLog[0].attempts, 2);
  const dead = flaky(99, () => new Error('EDGAR 503'));
  const r2 = await runAgent({ ...base, ds: dead, policy: once([{ name: 'get_financials', input: { ticker: 'NVDA' } }]), limits: { maxToolCalls: 10, maxTurns: 5, maxRetries: 2, timeoutMs: 10000 } });
  assert.equal(r2.toolLog[0].ok, false);
  assert.equal(r2.toolLog[0].attempts, 3);
  assert.ok(r2.warnings.some((w) => w.includes('실패한 도구 호출')));
});

test('invalid tool input is not retried', async () => {
  const r = await runAgent({ ...base, ds: snap, policy: once([{ name: 'get_financials', input: { ticker: 'ZZZZ' } }, { name: 'no_such_tool', input: {} }]) });
  assert.deepEqual(r.toolLog.map((e) => [e.ok, e.attempts]), [[false, 1], [false, 0]]);
});

test('tool-call limit and turn limit stop the loop with a partial result', async () => {
  const r = await runAgent({ ...base, ds: snap, policy: new RulePolicy(), limits: { maxToolCalls: 10, maxTurns: 12, maxRetries: 0, timeoutMs: 10000 } });
  assert.equal(r.toolLog.length, 10);
  assert.match(r.stopReason!, /도구 호출 한도/);
  assert.equal(r.status, 'failed'); // nothing reviewed yet
  const looping: Policy = { async next() { return { calls: [{ id: 'x', name: 'list_candidates', input: { target: 'NVDA' } }] }; } };
  const r2 = await runAgent({ ...base, ds: snap, policy: looping, limits: { maxToolCalls: 100, maxTurns: 3, maxRetries: 0, timeoutMs: 10000 } });
  assert.match(r2.stopReason!, /판단 단계 한도/);
});

test('time limit and policy (LLM) failure return partial results instead of throwing', async () => {
  const slow: Policy = { async next() { await new Promise((r) => setTimeout(r, 60)); return { calls: [{ id: 'x', name: 'list_candidates', input: { target: 'NVDA' } }] }; } };
  const r = await runAgent({ ...base, ds: snap, policy: slow, limits: { maxToolCalls: 100, maxTurns: 100, maxRetries: 0, timeoutMs: 100 } });
  assert.match(r.stopReason!, /시간 한도/);
  const broken: Policy = { async next() { throw new Error('API 529 overloaded'); } };
  const r2 = await runAgent({ ...base, ds: snap, policy: broken });
  assert.equal(r2.status, 'failed');
  assert.match(r2.stopReason!, /529/);
});

// ---- numbers ↔ sources ----
test('every reported number links to a collected source with matching URL', async () => {
  for (const target of ['NVDA', 'AMD']) {
    const r = await runAgent({ ...base, target, ds: snap, policy: new RulePolicy() });
    assert.equal(r.status, 'complete');
    assert.ok(r.selected.length >= 3 && r.selected.length <= 5, `${target} selected ${r.selected}`);
    assert.equal(r.candidates.find((c) => c.ticker === 'TSM')!.review!.decision, 'excluded');
    for (const c of [r.target_record, ...r.candidates]) {
      for (const pv of [c.financials?.latest, c.financials?.prior]) for (const v of Object.values(pv?.values ?? {})) {
        const s = r.sources.find((x) => x.id === v!.sourceId);
        assert.ok(s, `${c.ticker} ${v!.metric} has no source`);
        assert.equal(s!.url, v!.url);
        assert.match(s!.url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//);
      }
      for (const id of [...(c.review?.sourceIds ?? []), ...Object.values(c.review?.criteria ?? {}).flatMap((j) => j.sourceIds)]) assert.ok(r.sources.some((s) => s.id === id));
    }
    const md = toMarkdown(r, r.selected, []);
    assert.match(md, /데모|test/);
    for (const s of r.sources) assert.ok(md.includes(s.url));
    const csv = toCsv(r, r.selected).split('\n');
    assert.ok(csv.slice(1).filter((l) => !l.includes('코드 계산')).every((l) => l.includes('https://www.sec.gov/')));
  }
});

test('save_review holds unsupported selections and rejects target/self reviews', async () => {
  const ctx = new Ctx('NVDA', '2026-11-07', snap);
  await ctx.financials('NVDA'); await ctx.financials('AMD');
  const j = (ids: string[]) => ({ assessment: 'similar' as const, note: '', sourceIds: ids });
  const crit = (ids: string[]) => ({ product: j(ids), customers: j([]), scale: j([]), growthProfitability: j([]), dataSufficiency: j([]) });
  saveReview(ctx, { ticker: 'AMD', decision: 'selected', relationship: 'both', criteria: crit(['S999']), reason: '', sourceIds: ['made-up'] }, 'llm');
  assert.equal(ctx.rec('AMD').review!.decision, 'hold');
  saveReview(ctx, { ticker: 'AMD', decision: 'selected', relationship: 'both', criteria: crit(['S1', 'S999']), reason: 'AMD 매출 성장률 34.3%, 99.9% 이익률', sourceIds: [] }, 'llm');
  const rev = ctx.rec('AMD').review!;
  assert.equal(rev.decision, 'hold');
  assert.ok(rev.verification.checks.some((c) => c.code === 'unknown_source'));
  assert.ok(rev.verification.checks.some((c) => c.code === 'unverified_number'));
  assert.ok(!rev.reason.includes('99.9%'));
  ctx.rec('TSM').issues = [{ level: 'block', code: 'no_usgaap_data', message: 'IFRS' }];
  saveReview(ctx, { ticker: 'TSM', decision: 'selected', relationship: 'none', criteria: crit(['S1']), reason: '', sourceIds: ['S1'] }, 'llm');
  assert.equal(ctx.rec('TSM').review!.decision, 'hold');
  assert.throws(() => saveReview(ctx, { ticker: 'NVDA', decision: 'excluded', relationship: 'none', criteria: crit([]), reason: '', sourceIds: [] }, 'llm'), /후보군/);
});

test('unverified number detector', () => {
  const k = { pct: [65.5, 10.7], usdB: [215.94], ratios: [0.16] };
  assert.deepEqual(unverifiedNumbers('성장률 65.5%, 이익률 11%, 매출 $215.9B, 0.16배', k), []);
  assert.deepEqual(unverifiedNumbers('이익률 40%, 매출 $300B, 2배', k), ['40%', '$300B', '2배']);
});
