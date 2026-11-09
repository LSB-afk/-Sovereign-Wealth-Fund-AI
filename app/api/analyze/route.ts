import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMITS, RulePolicy, runAgent } from '@/lib/agent.ts';
import { companies, liveSource, snapshotSource } from '@/lib/datasource.ts';
import { LlmPolicy } from '@/lib/llm.ts';
import { saveRun } from '@/lib/runs.ts';
import { isDate, sameOrigin } from '@/lib/validation.ts';
import type { AgentEvent, Mode } from '@/lib/types.ts';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: '다른 사이트에서 실행할 수 없습니다.' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body !== 'object' || !['demo', 'real'].includes(body.mode)) return Response.json({ error: '실행 모드는 demo 또는 real이어야 합니다.' }, { status: 400 });
  const target = String(body.target ?? '');
  const asOf = String(body.asOf ?? '');
  const mode: Mode = body.mode === 'real' ? 'real' : 'demo';
  if (!companies().targets.includes(target)) return Response.json({ error: `지원 대상이 아님: ${target}` }, { status: 400 });
  if (!isDate(asOf)) return Response.json({ error: '분석 기준일 형식 오류 (유효한 YYYY-MM-DD)' }, { status: 400 });
  const today = new Date().toISOString().slice(0, 10);
  if (asOf > today) return Response.json({ error: '분석 기준일은 오늘 이후일 수 없음' }, { status: 400 });
  // Real mode never falls back to demo silently.
  if (mode === 'real' && !process.env.ANTHROPIC_API_KEY) return Response.json({ error: '실제 모드에는 서버 환경변수 ANTHROPIC_API_KEY가 필요합니다.' }, { status: 400 });
  if (mode === 'real' && !process.env.SEC_USER_AGENT) return Response.json({ error: '실제 모드에는 서버 환경변수 SEC_USER_AGENT가 필요합니다.' }, { status: 400 });

  const limits = DEFAULT_LIMITS[mode];
  let modeLabel = '실제 모드 — SEC EDGAR 실시간 조회 + Claude 에이전트';
  let dataNote = 'SEC EDGAR companyfacts/submissions/원문(실시간 조회). 기업 프로필은 큐레이션 요약.';
  const warnings: string[] = [];
  if (mode === 'demo') {
    const meta = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'snapshot', 'meta.json'), 'utf8'));
    modeLabel = '데모 모드 — 저장된 EDGAR 스냅샷 + 규칙 기반 정책 (LLM 미사용)';
    dataNote = `SEC EDGAR 스냅샷 (수집 ${meta.collectedAt}). 기업 프로필은 큐레이션 요약.`;
    if (asOf > meta.collectedAt.slice(0, 10)) warnings.push(`기준일이 스냅샷 수집일(${meta.collectedAt.slice(0, 10)})보다 늦음: 그 사이 공시는 반영되지 않음`);
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
      for (const w of warnings) emit({ type: 'warning', message: w });
      try {
        const result = await runAgent({
          target, asOf, mode, limits, emit, modeLabel, dataNote,
          ds: mode === 'demo' ? snapshotSource() : liveSource(),
          policy: mode === 'demo' ? new RulePolicy() : new LlmPolicy(limits.maxRetries, limits.maxToolCalls),
        });
        result.warnings.unshift(...warnings);
        const stored = await saveRun(result);
        emit({ type: 'result', result: stored.result });
      } catch (e) {
        emit({ type: 'error', message: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}
