import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RulePolicy, runAgent } from '../lib/agent.ts';
import { snapshotSource } from '../lib/datasource.ts';
import { robustness } from '../lib/robustness.ts';
import { runTimeline } from '../lib/timeline.ts';
import { acceptTriple, buildGraph, normalizeText, parseTriplesResponse } from '../lib/graph.ts';
import { POST as graphApi } from '../app/api/graph/route.ts';
import { POST as timelineApi } from '../app/api/timeline/route.ts';

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
  assert.equal(g.status, 'complete');
  const extracted = g.edges.filter((e) => e.extractor !== 'curated');
  assert.ok(extracted.length > 5);
  for (const e of extracted) {
    assert.equal(e.verification, 'review_required');
    assert.ok(e.quote && e.quote.length >= 15);
    assert.match(e.url, /^https:\/\/www\.sec\.gov\/Archives\//);
    assert.ok(e.filed! <= '2026-11-07');
  }
  assert.ok(g.edges.filter((e) => e.extractor === 'curated').every((e) => e.verification === 'curated'));
  assert.ok(extracted.some((e) => e.source === 'NVDA' && e.target === 'AMD' && e.relation === 'COMPETES_WITH'));
  const text = normalizeText('Our current competitors include Advanced Micro Devices, Inc., or AMD, and Intel.');
  assert.equal(acceptTriple({ relation: 'COMPETES_WITH', quote: 'competitors include Advanced Micro Devices' }, text), true);
  assert.equal(acceptTriple({ relation: 'COMPETES_WITH', quote: 'competitors include Samsung Electronics' }, text), false);
  assert.equal(acceptTriple({ relation: 'ACQUIRED', quote: 'competitors include Advanced Micro Devices' }, text), false);
});

test('knowledge graph rejects malformed triples and quotes that do not mention the proposed company', () => {
  const text = 'Our current competitors include Advanced Micro Devices, Inc., or AMD, and Intel.';
  const quote = 'competitors include Advanced Micro Devices';
  assert.equal(acceptTriple({ relation: 'COMPETES_WITH', object: 'AMD', quote }, text), true);
  assert.equal(acceptTriple({ relation: 'COMPETES_WITH', object: 'Samsung Electronics', quote }, text), false);
  assert.equal(acceptTriple({ relation: 'COMPETES_WITH', object: 'AMD', quote: 'competitors include advanced micro devices' }, text), false);
  assert.equal(acceptTriple({ relation: 'COMPETES_WITH', object: 'AMD', quote: 'competitors include Advanced  Micro Devices' }, text), false);
  for (const triple of [null, [], { relation: 'COMPETES_WITH', quote: 42 }, { relation: 42, quote }, { relation: 'COMPETES_WITH', object: '', quote }]) {
    assert.equal(acceptTriple(triple, text), false);
  }
});

test('a matching quotation never verifies a proposed semantic relationship', async () => {
  const quote = 'Our current competitors include Advanced Micro Devices, Inc., or AMD, and Intel.';
  const source = {
    ...ds,
    async excerpts(ticker: string, filing: Parameters<typeof ds.excerpts>[1], topic: Parameters<typeof ds.excerpts>[2]) {
      return ticker === 'NVDA' ? { snippets: topic === 'competition' ? [quote] : [], collectedAt: '2026-11-07' } : ds.excerpts(ticker, filing, topic);
    },
  };
  const graph = await buildGraph(source, '2026-11-07', 'llm', async (company) => company.ticker === 'NVDA'
    ? [{ relation: 'SUPPLIES_TO', object: 'AMD', quote }]
    : []);
  const proposed = graph.edges.find((edge) => edge.source === 'NVDA' && edge.target === 'AMD' && edge.relation === 'SUPPLIES_TO');
  assert.ok(proposed);
  assert.equal(proposed.verification, 'review_required');
});

test('one company retrieval or extraction failure returns a partial graph with successful companies intact', async () => {
  const source = {
    ...ds,
    async filings(ticker: string) {
      if (ticker === 'NVDA') throw new Error('filing unavailable');
      return ds.filings(ticker);
    },
  };
  const retrieval = await buildGraph(source, '2026-11-07', 'rule');
  assert.equal(retrieval.status, 'partial');
  assert.ok(retrieval.notes.some((note) => note.includes('NVDA') && note.includes('filing unavailable')));
  assert.ok(retrieval.edges.some((edge) => edge.source === 'AMD'));

  const extraction = await buildGraph(ds, '2026-11-07', 'llm', async (company) => {
    if (company.ticker === 'NVDA') throw new Error('truncated response');
    return [];
  });
  assert.equal(extraction.status, 'partial');
  assert.ok(extraction.notes.some((note) => note.includes('NVDA') && note.includes('truncated response')));
  assert.ok(extraction.edges.some((edge) => edge.source === 'AMD'));
});

test('graph extraction treats absent, truncated, and malformed model output as failures', () => {
  assert.deepEqual(parseTriplesResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"triples":[]}' }] }), []);
  for (const response of [
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"triples":[]}' }] },
    { stop_reason: 'refusal', content: [{ type: 'text', text: '{"triples":[]}' }] },
    { stop_reason: 'end_turn', content: [] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"triples":null}' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"triples":[{"relation":"COMPETES_WITH","object":42,"quote":"A sufficiently long quote"}]}' }] },
  ]) assert.throws(() => parseTriplesResponse(response));
});

test('graph and timeline APIs reject invalid requests instead of defaulting or dropping dates', async () => {
  const cases: [typeof graphApi, unknown][] = [
    [graphApi, null], [graphApi, []], [graphApi, { asOf: '2026-11-07' }],
    [graphApi, { asOf: '2026-11-07', mode: 'typo' }],
    [graphApi, { asOf: '2026-02-30', mode: 'demo' }],
    [graphApi, { asOf: '2099-01-01', mode: 'demo' }],
    [timelineApi, null], [timelineApi, { target: 'NVDA', mode: 'typo', dates: ['2026-06-30'] }],
    [timelineApi, { target: 'NVDA', mode: 'demo', dates: ['2026-06-30', 'invalid'] }],
    [timelineApi, { target: 'NVDA', mode: 'demo', dates: ['2026-02-30'] }],
    [timelineApi, { target: 'NVDA', mode: 'demo', dates: ['2099-01-01'] }],
    [timelineApi, { target: 'NVDA', mode: 'demo', dates: Array(9).fill('2026-06-30') }],
  ];
  for (const [handler, body] of cases) {
    const response = await handler(new Request('http://localhost/api/test', { method: 'POST', body: JSON.stringify(body) }));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  for (const handler of [graphApi, timelineApi]) {
    assert.equal((await handler(new Request('http://localhost/api/test', { method: 'POST', body: '{' }))).status, 400);
    assert.equal((await handler(new Request('http://localhost/api/test', { method: 'POST', headers: { origin: 'https://other.example' }, body: 'null' }))).status, 403);
  }
});

test('graph cache expires within five minutes and never reuses partial failures', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T00:00:00Z') });
  const request = async (asOf: string) => {
    const response = await graphApi(new Request('http://localhost/api/graph', { method: 'POST', body: JSON.stringify({ asOf, mode: 'demo' }) }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await request('2026-11-06');
  assert.equal(first.status, 'complete');
  context.mock.timers.tick(299_999);
  assert.equal((await request('2026-11-06')).builtAt, first.builtAt);
  context.mock.timers.tick(2);
  assert.notEqual((await request('2026-11-06')).builtAt, first.builtAt);

  const partial = await request('2000-01-01');
  assert.equal(partial.status, 'partial');
  context.mock.timers.tick(1);
  assert.notEqual((await request('2000-01-01')).builtAt, partial.builtAt);
});
