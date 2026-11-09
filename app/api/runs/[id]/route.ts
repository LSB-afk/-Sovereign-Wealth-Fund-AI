import { getRun, reviewRun, RunStoreError } from '../../../../lib/runs.ts';
import { sameOrigin } from '../../../../lib/validation.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

function failure(e: unknown) {
  if (e instanceof RunStoreError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  return Response.json({ error: '실행 기록을 처리할 수 없습니다.' }, { status: 500 });
}

export async function GET(_req: Request, context: Context) {
  try {
    const record = await getRun((await context.params).id);
    if (!record) return Response.json({ error: '실행 기록을 찾을 수 없습니다.' }, { status: 404 });
    return Response.json(record, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return failure(e); }
}

export async function PATCH(req: Request, context: Context) {
  if (!sameOrigin(req)) {
    return Response.json({ error: '다른 사이트에서의 검토 요청은 허용하지 않습니다.' }, { status: 403 });
  }
  try {
    const text = await req.text();
    if (text.length > 10000) throw new RunStoreError('검토 요청이 너무 큽니다.', 400, 'invalid_review');
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); }
    catch { throw new RunStoreError('JSON 요청 형식이 올바르지 않습니다.', 400, 'invalid_review'); }
    if (!body || Array.isArray(body) || typeof body !== 'object' || !['approved', 'rejected'].includes(String(body.decision))
      || typeof body.note !== 'string' || typeof body.digest !== 'string') {
      throw new RunStoreError('검토 요청 형식이 올바르지 않습니다.', 400, 'invalid_review');
    }
    const record = await reviewRun((await context.params).id, body.decision as 'approved' | 'rejected', body.note, body.digest);
    return Response.json(record, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return failure(e); }
}
