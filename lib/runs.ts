// Local single-user run receipts. The digest detects changed payloads; it is not a signature.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisResult, Mode } from './types.ts';
import { canCompare } from './publication.ts';

export interface RunApproval {
  decision: 'pending' | 'approved' | 'rejected';
  at?: string;
  note?: string;
}

export interface StoredRun {
  id: string;
  createdAt: string;
  digest: string;
  result: AnalysisResult;
  approval: RunApproval;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  digest: string;
  target: string;
  asOf: string;
  mode: Mode;
  status: AnalysisResult['status'];
  selected: string[];
  approval: RunApproval;
}

export class RunStoreError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'RunStoreError';
    this.status = status;
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const directory = () => path.resolve(process.env.PEER_RUNS_DIR || path.join(process.cwd(), '.local', 'runs'));
const digestOf = (result: AnalysisResult) => createHash('sha256').update(JSON.stringify(result)).digest('hex');
const corrupt = () => new RunStoreError('저장된 실행 기록의 무결성을 확인할 수 없습니다.', 409, 'integrity_failed');

function fileOf(id: string) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new RunStoreError('실행 ID 형식이 올바르지 않습니다.', 400, 'invalid_id');
  return path.join(directory(), `${id}.json`);
}

async function writeRecord(record: StoredRun) {
  const file = fileOf(record.id);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
  }
}

export async function saveRun(result: AnalysisResult): Promise<StoredRun> {
  const id = randomUUID();
  // A detached JSON copy makes the persisted receipt independent of later caller mutations.
  const payload = JSON.parse(JSON.stringify({ ...result, runId: id })) as AnalysisResult;
  const record: StoredRun = {
    id, createdAt: new Date().toISOString(), digest: digestOf(payload), result: payload,
    approval: { decision: 'pending' },
  };
  await writeRecord(record);
  return record;
}

export async function getRun(id: string): Promise<StoredRun | null> {
  const file = fileOf(id);
  let text: string;
  try {
    if (!(await lstat(file)).isFile()) throw corrupt();
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let record: StoredRun;
  try { record = JSON.parse(text); }
  catch { throw corrupt(); }
  if (!record || record.id !== id || !record.result || record.result.runId !== id
    || !SHA256.test(record.digest) || record.digest !== digestOf(record.result)
    || !record.createdAt || Number.isNaN(Date.parse(record.createdAt))
    || !record.approval || !['pending', 'approved', 'rejected'].includes(record.approval.decision)
    || !['demo', 'real'].includes(record.result.mode) || !['complete', 'partial', 'failed'].includes(record.result.status)
    || !Array.isArray(record.result.selected) || typeof record.result.target !== 'string'
    || typeof record.result.asOf !== 'string') throw corrupt();
  return record;
}

export async function listRuns(): Promise<RunSummary[]> {
  let files: string[];
  try { files = await readdir(directory()); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const records: StoredRun[] = [];
  for (const file of files.filter((f) => f.endsWith('.json') && UUID.test(f.slice(0, -5)))) {
    const record = await getRun(file.slice(0, -5));
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 30).map((r) => ({
    id: r.id, createdAt: r.createdAt, digest: r.digest, target: r.result.target,
    asOf: r.result.asOf, mode: r.result.mode, status: r.result.status,
    selected: r.result.selected, approval: r.approval,
  }));
}

export async function reviewRun(id: string, decision: 'approved' | 'rejected', note: string, expectedDigest: string): Promise<StoredRun> {
  fileOf(id);
  if (!['approved', 'rejected'].includes(decision) || typeof note !== 'string' || note.length > 2000
    || typeof expectedDigest !== 'string' || !SHA256.test(expectedDigest)) {
    throw new RunStoreError('검토 요청 형식이 올바르지 않습니다.', 400, 'invalid_review');
  }
  const record = await getRun(id);
  if (!record) throw new RunStoreError('실행 기록을 찾을 수 없습니다.', 404, 'not_found');
  if (record.digest !== expectedDigest) throw new RunStoreError('현재 확인한 실행 기록과 요청한 기록이 다릅니다. 다시 불러오세요.', 409, 'stale_digest');
  if (decision === 'approved' && (record.result.status !== 'complete' || record.result.reliability?.status !== 'passed'
    || record.result.reliability.checks.length > 0
    || record.result.candidates.some((c) => !c.review || c.review.decision === 'hold' || c.review.verification.status !== 'passed')
    || record.result.selected.some((ticker) => !record.result.candidates.some((c) => c.ticker === ticker && c.review?.decision === 'selected' && canCompare(c))))) {
    throw new RunStoreError('실행과 근거 검증을 모두 통과한 기록만 승인할 수 있습니다.', 422, 'approval_blocked');
  }
  const reviewed: StoredRun = { ...record, approval: { decision, at: new Date().toISOString(), note: note.trim() } };
  await writeRecord(reviewed);
  return reviewed;
}
