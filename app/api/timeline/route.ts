import { companies, liveSource, snapshotSource } from '../../../lib/datasource.ts';
import { runTimeline } from '../../../lib/timeline.ts';
import { isDate, sameOrigin } from '../../../lib/validation.ts';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: '같은 출처의 요청만 허용합니다.' }, { status: 403 });
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'JSON 객체가 필요합니다.' }, { status: 400 });
  const { target, mode, dates } = body as Record<string, unknown>;
  if (mode !== 'real' && mode !== 'demo') return Response.json({ error: '모드는 demo 또는 real이어야 합니다.' }, { status: 400 });
  if (typeof target !== 'string' || !companies().targets.includes(target)) return Response.json({ error: '지원하지 않는 대상입니다.' }, { status: 400 });
  const today = new Date().toISOString().slice(0, 10);
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > 8 || !dates.every((date) => isDate(date) && date <= today)) return Response.json({ error: '오늘 이전의 유효한 날짜를 1~8개 입력해야 합니다.' }, { status: 400 });
  if (mode === 'real' && !process.env.SEC_USER_AGENT) return Response.json({ error: '실제 모드에는 SEC_USER_AGENT가 필요합니다.' }, { status: 400 });
  try {
    return Response.json(await runTimeline(target, dates, mode === 'demo' ? snapshotSource() : liveSource()));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
