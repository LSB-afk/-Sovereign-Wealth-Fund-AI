import { liveSource, snapshotSource } from '../../../lib/datasource.ts';
import { buildGraph, type KnowledgeGraph } from '../../../lib/graph.ts';
import { isDate, sameOrigin } from '../../../lib/validation.ts';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Coalesce concurrent requests, but retry partial failures on the next request.
const cache = new Map<string, { expiresAt: number; value: Promise<KnowledgeGraph> }>();
const CACHE_TTL = 5 * 60_000;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: '같은 출처의 요청만 허용합니다.' }, { status: 403 });
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'JSON 객체가 필요합니다.' }, { status: 400 });
  const { asOf, mode } = body as Record<string, unknown>;
  if (mode !== 'real' && mode !== 'demo') return Response.json({ error: '모드는 demo 또는 real이어야 합니다.' }, { status: 400 });
  if (!isDate(asOf) || asOf > new Date().toISOString().slice(0, 10)) return Response.json({ error: '유효한 오늘 이전 분석 기준일이 필요합니다.' }, { status: 400 });
  if (mode === 'real' && (!process.env.ANTHROPIC_API_KEY || !process.env.SEC_USER_AGENT)) return Response.json({ error: '실제 모드(LLM 추출)에는 ANTHROPIC_API_KEY와 SEC_USER_AGENT가 필요합니다.' }, { status: 400 });
  const key = `${mode}:${asOf}`;
  for (const [cachedKey, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(cachedKey);
  let entry = cache.get(key);
  if (!entry) {
    entry = { expiresAt: Date.now() + CACHE_TTL, value: buildGraph(mode === 'demo' ? snapshotSource() : liveSource(), asOf, mode === 'demo' ? 'rule' : 'llm') };
    cache.set(key, entry);
  }
  try {
    const graph = await entry.value;
    if (graph.status === 'partial' && cache.get(key) === entry) cache.delete(key);
    return Response.json(graph);
  } catch (e) {
    if (cache.get(key) === entry) cache.delete(key);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
