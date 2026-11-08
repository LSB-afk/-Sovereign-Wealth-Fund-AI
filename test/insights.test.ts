import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RulePolicy, runAgent } from '../lib/agent.ts';
import { snapshotSource } from '../lib/datasource.ts';
import { robustness } from '../lib/robustness.ts';
import { runTimeline } from '../lib/timeline.ts';
import { acceptTriple, buildGraph, normalizeText } from '../lib/graph.ts';

const ds = snapshotSource();

test('robustness: deterministic, rates in [0,1], blocked candidates never selected', async () => {
  const r = await runAgent({ target: 'NVDA', asOf: '2026-11-07', mode: 'demo', ds, policy: new RulePolicy(), modeLabel: '', dataNote: '' });
  const a = robustness(r.candidates, r.selected, 500, 7), b = robustness(r.candidates, r.selected, 500, 7);
  assert.deepEqual(a, b);
  for (const x of a.rows) assert.ok(x.rate >= 0 && x.rate <= 1);
  const tsm = a.rows.find((x) => x.ticker === 'TSM')!;
  assert.equal(tsm.band, 'ineligible');
  assert.equal(tsm.rate, 0);
});

test('time machine: each point only uses filings on/before its date', async () => {
  const tl = await runTimeline('NVDA', ['2024-06-30', '2026-06-30'], ds);
  assert.equal(tl.points.length, 2);
  for (const p of tl.points) {
    assert.ok(p.target.periodEnd! <= p.asOf);
    for (const c of Object.values(p.cells)) if (c.periodEnd) assert.ok(c.periodEnd <= p.asOf);
  }
  assert.notEqual(tl.points[0].target.periodEnd, tl.points[1].target.periodEnd);
});

test('knowledge graph: every extracted edge quotes the filing verbatim; fabricated quotes are rejected', async () => {
  const g = await buildGraph(ds, '2026-11-07', 'rule');
  const extracted = g.edges.filter((e) => e.extractor !== 'curated');
  assert.ok(extracted.length > 5);
  for (const e of extracted) {
    assert.ok(e.quote && e.quote.length >= 15);
    assert.match(e.url, /^https:\/\/www\.sec\.gov\/Archives\//);
    assert.ok(e.filed! <= '2026-11-07');
  }
  assert.ok(extracted.some((e) => e.source === 'NVDA' && e.target === 'AMD' && e.relation === 'COMPETES_WITH'));
  const text = normalizeText('Our current competitors include Advanced Micro Devices, Inc., or AMD, and Intel.');
  assert.equal(acceptTriple({ relation: 'COMPETES_WITH', quote: 'competitors include Advanced Micro Devices' }, text), true);
  assert.equal(acceptTriple({ relation: 'COMPETES_WITH', quote: 'competitors include Samsung Electronics' }, text), false);
  assert.equal(acceptTriple({ relation: 'ACQUIRED', quote: 'competitors include Advanced Micro Devices' }, text), false);
});
