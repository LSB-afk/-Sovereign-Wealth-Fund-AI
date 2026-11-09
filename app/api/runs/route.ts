import { listRuns, RunStoreError } from '../../../lib/runs.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json({ runs: await listRuns() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof RunStoreError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    return Response.json({ error: '실행 기록을 불러올 수 없습니다.' }, { status: 500 });
  }
}
