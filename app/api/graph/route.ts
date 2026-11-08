import { liveSource, snapshotSource } from '@/lib/datasource.ts';
import { buildGraph, type KnowledgeGraph } from '@/lib/graph.ts';

export const runtime = 'nodejs';
export const maxDuration = 300;

// ponytail: in-process cache per (mode, asOf); LLM extraction is the slow/expensive path.
const cache = new Map<string, Promise<KnowledgeGraph>>();

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const asOf = String(body.asOf ?? '');
  const mode = body.mode === 'real' ? 'real' : 'demo';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return Response.json({ error: '분석 기준일 형식 오류' }, { status: 400 });
  if (mode === 'real' && (!process.env.ANTHROPIC_API_KEY || !process.env.SEC_USER_AGENT)) return Response.json({ error: '실제 모드(LLM 추출)에는 ANTHROPIC_API_KEY와 SEC_USER_AGENT가 필요합니다.' }, { status: 400 });
  const key = `${mode}:${asOf}`;
  if (!cache.has(key)) cache.set(key, buildGraph(mode === 'demo' ? snapshotSource() : liveSource(), asOf, mode === 'demo' ? 'rule' : 'llm'));
  try {
    return Response.json(await cache.get(key)!);
  } catch (e) {
    cache.delete(key);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
