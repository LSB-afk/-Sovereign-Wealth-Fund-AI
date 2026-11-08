import { companies, liveSource, snapshotSource } from '@/lib/datasource.ts';
import { runTimeline } from '@/lib/timeline.ts';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const target = String(body.target ?? '');
  const mode = body.mode === 'real' ? 'real' : 'demo';
  const dates: string[] = Array.isArray(body.dates) ? body.dates.map(String).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 8) : [];
  if (!companies().targets.includes(target) || !dates.length) return Response.json({ error: '대상 또는 날짜 오류' }, { status: 400 });
  if (mode === 'real' && !process.env.SEC_USER_AGENT) return Response.json({ error: '실제 모드에는 SEC_USER_AGENT가 필요합니다.' }, { status: 400 });
  try {
    return Response.json(await runTimeline(target, dates, mode === 'demo' ? snapshotSource() : liveSource()));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
