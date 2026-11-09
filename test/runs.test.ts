import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getRun, listRuns, reviewRun, RunStoreError, saveRun } from '../lib/runs.ts';
import type { AnalysisResult } from '../lib/types.ts';
import { RulePolicy, runAgent } from '../lib/agent.ts';
import { snapshotSource } from '../lib/datasource.ts';
import { GET as listApi } from '../app/api/runs/route.ts';
import { GET as getApi, PATCH as reviewApi } from '../app/api/runs/[id]/route.ts';

const fixture = await runAgent({ target: 'NVDA', asOf: '2026-11-07', mode: 'demo', modeLabel: 'test', dataNote: '', ds: snapshotSource(), policy: new RulePolicy() });
function result(status: AnalysisResult['status'] = 'complete', gate: AnalysisResult['reliability']['status'] = 'passed'): AnalysisResult {
  const copy = structuredClone(fixture);
  copy.status = status; copy.reliability.status = gate;
  return copy;
}

async function inStore(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'peer-runs-'));
  const prior = process.env.PEER_RUNS_DIR;
  process.env.PEER_RUNS_DIR = dir;
  try { await fn(dir); }
  finally {
    if (prior === undefined) delete process.env.PEER_RUNS_DIR; else process.env.PEER_RUNS_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
}

test('run history persists the exact payload and human review without rewriting evidence', async () => {
  await inStore(async () => {
    const saved = await saveRun(result());
    assert.match(saved.id, /^[0-9a-f-]{36}$/);
    assert.equal(saved.result.runId, saved.id);
    assert.equal(saved.approval.decision, 'pending');
    const loaded = await getRun(saved.id);
    assert.deepEqual(loaded, saved);
    const reviewed = await reviewRun(saved.id, 'approved', 'Evidence reviewed', saved.digest);
    assert.equal(reviewed.approval.decision, 'approved');
    assert.equal(reviewed.approval.note, 'Evidence reviewed');
    assert.equal(reviewed.digest, saved.digest);
    assert.deepEqual(reviewed.result, saved.result);
    const list = await listRuns();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, saved.id);
    assert.equal(list[0].approval.decision, 'approved');
    assert.equal('result' in list[0], false);
    assert.equal(await getRun('00000000-0000-4000-8000-000000000000'), null);
  });
});

test('changed saved evidence and malformed storage are rejected instead of displayed', async () => {
  await inStore(async (dir) => {
    const saved = await saveRun(result());
    const file = path.join(dir, `${saved.id}.json`);
    const changed = JSON.parse(await readFile(file, 'utf8'));
    changed.result.selected = ['FAKE'];
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(getRun(saved.id), (e: unknown) => e instanceof RunStoreError && e.code === 'integrity_failed');
    await assert.rejects(listRuns(), (e: unknown) => e instanceof RunStoreError && e.code === 'integrity_failed');
    await writeFile(file, '{');
    await assert.rejects(getRun(saved.id), (e: unknown) => e instanceof RunStoreError && e.code === 'integrity_failed');
  });
});

test('review cannot approve incomplete or held analyses, or silently accept a stale payload', async () => {
  await inStore(async () => {
    const inconsistent = result();
    inconsistent.candidates[0].review!.decision = 'hold';
    for (const r of [result('partial'), result('failed'), result('complete', 'review_required'), inconsistent]) {
      const saved = await saveRun(r);
      await assert.rejects(reviewRun(saved.id, 'approved', '', saved.digest), (e: unknown) => e instanceof RunStoreError && e.status === 422);
      assert.equal((await getRun(saved.id))!.approval.decision, 'pending');
      assert.equal((await reviewRun(saved.id, 'rejected', 'Needs more evidence', saved.digest)).approval.decision, 'rejected');
    }
    const saved = await saveRun(result());
    await assert.rejects(reviewRun(saved.id, 'approved', '', '0'.repeat(64)), (e: unknown) => e instanceof RunStoreError && e.status === 409);
    await assert.rejects(reviewRun(saved.id, 'approved', 'x'.repeat(2001), saved.digest), (e: unknown) => e instanceof RunStoreError && e.status === 400);
    assert.equal((await getRun(saved.id))!.approval.decision, 'pending');
  });
});

test('untrusted identifiers cannot read or write outside the run directory', async () => {
  await inStore(async () => {
    for (const id of ['../package', '/tmp/result', 'not-a-run', '00000000-0000-4000-8000-000000000000.json']) {
      await assert.rejects(getRun(id), (e: unknown) => e instanceof RunStoreError && e.status === 400);
      await assert.rejects(reviewRun(id, 'rejected', '', '0'.repeat(64)), (e: unknown) => e instanceof RunStoreError && e.status === 400);
    }
  });
});

test('review API rejects cross-origin and malformed requests before any approval changes', async () => {
  await inStore(async () => {
    const saved = await saveRun(result());
    const url = `http://localhost:3000/api/runs/${saved.id}`;
    const context = { params: Promise.resolve({ id: saved.id }) };
    const body = JSON.stringify({ decision: 'approved', note: '', digest: saved.digest });
    assert.equal((await reviewApi(new Request(url, { method: 'PATCH', headers: { origin: 'https://foreign.example' }, body }), context)).status, 403);
    assert.equal((await reviewApi(new Request(url, { method: 'PATCH', headers: { 'sec-fetch-site': 'cross-site' }, body }), context)).status, 403);
    assert.equal((await reviewApi(new Request(url, { method: 'PATCH', body: '{' }), context)).status, 400);
    assert.equal((await reviewApi(new Request(url, { method: 'PATCH', body: JSON.stringify({ decision: 'approved', note: 99, digest: saved.digest }) }), context)).status, 400);
    assert.equal((await getRun(saved.id))!.approval.decision, 'pending');
    const response = await reviewApi(new Request(url, { method: 'PATCH', headers: { origin: 'http://localhost:3000' }, body }), context);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).approval.decision, 'approved');
    const fetched = await getApi(new Request(url), context);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get('cache-control'), 'no-store');
    assert.equal((await fetched.json()).digest, saved.digest);
    const list = await listApi();
    assert.equal(list.status, 200);
    assert.equal((await list.json()).runs[0].id, saved.id);
    assert.equal((await getApi(new Request(url), { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }) })).status, 404);
  });
});

test('recent history is capped and caller changes cannot mutate a saved receipt', async () => {
  await inStore(async (dir) => {
    const input = result();
    const first = await saveRun(input);
    input.selected.push('FAKE');
    assert.deepEqual((await getRun(first.id))!.result.selected, fixture.selected);
    first.createdAt = '2000-01-01T00:00:00.000Z';
    await writeFile(path.join(dir, `${first.id}.json`), JSON.stringify(first));
    for (let i = 0; i < 31; i++) await saveRun(result());
    const recent = await listRuns();
    assert.equal(recent.length, 30);
    assert.equal(recent.some((run) => run.id === first.id), false);
  });
});
