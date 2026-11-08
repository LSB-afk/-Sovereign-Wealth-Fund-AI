// Bounded agent loop. One loop, two interchangeable policies:
//  - LlmPolicy (real mode): Claude picks the next tool calls.
//  - RulePolicy (demo mode): deterministic, disclosed rules pick the next tool calls. No LLM.
// The loop enforces tool-call, turn, retry and wall-clock limits and always returns a (possibly partial) result.
import { latestAnnualFiling, type ExcerptTopic } from './edgar.ts';
import { computeFinancials, fmtPct, fmtUsdB } from './financials.ts';
import { companies, profileOf, type DataSource } from './datasource.ts';
import { assess, checkComparability, ruleScore, scaleRatio, SCORING } from './peer.ts';
import { criterionLabel, decisionLabel, relationshipLabel } from './labels.ts';
import type {
  AgentEvent, AnalysisResult, AnnualFiling, CandidateRecord, CriterionJudgment, CriterionKey, Decision, Limits, Mode,
  Relationship, Review, Source, Stage, ToolLogEntry,
} from './types.ts';

export const DEFAULT_LIMITS: Record<Mode, Limits> = {
  demo: { maxToolCalls: 70, maxTurns: 12, maxRetries: 2, timeoutMs: 60_000 },
  real: { maxToolCalls: 60, maxTurns: 20, maxRetries: 2, timeoutMs: 280_000 },
};

export class ToolInputError extends Error {}

// ---------------- Context: everything tools collected ----------------
export class Ctx {
  sources: Source[] = [];
  records = new Map<string, CandidateRecord>();
  pool: string[];
  target: string;
  asOf: string;
  ds: DataSource;
  reviewAuthor: Review['author'] = 'llm';
  constructor(target: string, asOf: string, ds: DataSource) {
    this.target = target;
    this.asOf = asOf;
    this.ds = ds;
    const pool = companies().candidatePool[target];
    if (!pool) throw new ToolInputError(`지원하지 않는 분석 대상: ${target}`);
    this.pool = pool;
    for (const t of [target, ...pool]) this.records.set(t, { ticker: t });
  }
  rec(t: string): CandidateRecord {
    const r = this.records.get(t);
    if (!r) throw new ToolInputError(`후보군에 없는 티커: ${t}`);
    return r;
  }
  addSource(s: Omit<Source, 'id'>): string {
    const hit = this.sources.find((x) => x.url === s.url && x.kind === s.kind && x.title === s.title);
    if (hit) return hit.id;
    const id = `S${this.sources.length + 1}`;
    this.sources.push({ id, ...s });
    return id;
  }
  async annualFiling(t: string): Promise<AnnualFiling | null> {
    return latestAnnualFiling(await this.ds.filings(t), this.asOf);
  }
  async financials(t: string) {
    const r = this.rec(t);
    if (r.financials) return r.financials;
    const { facts, collectedAt } = await this.ds.facts(t);
    const f = computeFinancials(t, facts, this.asOf, collectedAt);
    for (const pv of [f.latest, f.prior]) {
      for (const v of Object.values(pv?.values ?? {})) {
        v!.sourceId = this.addSource({ ticker: t, kind: 'xbrl', title: `${t} ${v!.form} (${v!.filed} 공시) XBRL 재무데이터`, url: v!.url, form: v!.form, filed: v!.filed, period: `${v!.periodStart}~${v!.periodEnd}`, accessedAt: collectedAt });
      }
    }
    r.financials = f;
    return f;
  }
}

// ---------------- Tools ----------------
interface ToolDef {
  name: string;
  stage: Stage;
  description: string;
  input_schema: Record<string, unknown>;
  run(ctx: Ctx, input: any): Promise<{ data: unknown; summary: string }>;
}

const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const tickerProp = { type: 'string', description: '티커 (예: AMD)' };
const judgment = obj({ assessment: { type: 'string', enum: ['similar', 'partial', 'different', 'unknown'] }, note: { type: 'string' }, sourceIds: { type: 'array', items: { type: 'string' } } });

function mentions(snippets: string[], self: string): string[] {
  const text = snippets.join(' ');
  return companies().companies.filter((c) => c.ticker !== self && c.aliases.some((a) => new RegExp(`\\b${a}\\b`).test(text))).map((c) => c.ticker);
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_candidates', stage: 'collect',
    description: '분석 대상의 초기 후보군(탐색 범위)과 후보군 구성 규칙을 조회한다. 후보군은 적합한 Peer를 의미하지 않는다.',
    input_schema: obj({ target: tickerProp }),
    async run(ctx) {
      const list = ctx.pool.map((t) => ({ ticker: t, name: profileOf(t)?.name }));
      return { data: { target: ctx.target, rule: companies().poolRule, candidates: list }, summary: `후보 ${list.length}개` };
    },
  },
  {
    name: 'get_company_profile', stage: 'collect',
    description: '기업 개요·사업모델·주요 제품·최종시장 태그(큐레이션 요약)와 근거 연간공시를 조회한다.',
    input_schema: obj({ ticker: tickerProp }),
    async run(ctx, { ticker }) {
      const p = profileOf(ticker);
      if (!p) throw new ToolInputError(`프로필 없음: ${ticker}`);
      ctx.rec(ticker).profile = p;
      const f = await ctx.annualFiling(ticker);
      const sourceId = f
        ? ctx.addSource({ ticker, kind: 'profile', title: `${ticker} 큐레이션 프로필 — 근거: ${f.form} (${f.filed}) Item 1 Business`, url: f.url, form: f.form, filed: f.filed, accessedAt: new Date().toISOString() })
        : null;
      return { data: { ...p, sourceId, basisFiling: f && { form: f.form, filed: f.filed, period: f.reportDate } }, summary: `${p.name} · ${p.businessModel}` };
    },
  },
  {
    name: 'search_filings', stage: 'collect',
    description: '분석 기준일 이전에 공시된 연간보고서(10-K/20-F) 목록을 조회한다. 기준일 이후 공시는 제외된다.',
    input_schema: obj({ ticker: tickerProp }),
    async run(ctx, { ticker }) {
      ctx.rec(ticker);
      const all = await ctx.ds.filings(ticker);
      const ok = all.filter((f) => f.filed <= ctx.asOf).slice(0, 4);
      const excluded = all.filter((f) => f.filed > ctx.asOf).length;
      const filings = ok.map((f) => ({ form: f.form, filed: f.filed, period: f.reportDate, sourceId: ctx.addSource({ ticker, kind: 'filing', title: `${ticker} ${f.form} (${f.filed})`, url: f.url, form: f.form, filed: f.filed, period: f.reportDate, accessedAt: new Date().toISOString() }) }));
      return { data: { filings, excludedAfterAsOf: excluded }, summary: `연간공시 ${filings.length}건 (기준일 이후 ${excluded}건 제외)` };
    },
  },
  {
    name: 'get_filing_excerpt', stage: 'collect',
    description: '기준일 이전 최신 연간보고서 원문에서 주제별(competition=경쟁, customers=고객 집중도, segments=사업부문) 발췌를 조회한다. 발췌에 등장하는 후보 기업도 코드로 식별해 반환한다.',
    input_schema: obj({ ticker: tickerProp, topic: { type: 'string', enum: ['competition', 'customers', 'segments'] } }),
    async run(ctx, { ticker, topic }: { ticker: string; topic: ExcerptTopic }) {
      ctx.rec(ticker);
      const f = await ctx.annualFiling(ticker);
      if (!f) return { data: { available: false, reason: '기준일 이전 연간보고서 없음' }, summary: '공시 없음' };
      const original = (await ctx.ds.filings(ticker)).find((x) => x.filed === f.filed && !x.form.endsWith('/A')) ?? f;
      const ex = await ctx.ds.excerpts(ticker, original, topic);
      if (!ex) return { data: { available: false, reason: `${original.form}(${original.filed}) 원문 발췌가 데이터 소스에 없음` }, summary: '발췌 없음' };
      const sourceId = ctx.addSource({ ticker, kind: 'filing_excerpt', title: `${ticker} ${original.form} (${original.filed}) 원문 발췌: ${topic}`, url: original.url, form: original.form, filed: original.filed, period: original.reportDate, accessedAt: ex.collectedAt });
      ctx.sources.find((x) => x.id === sourceId)!.quote = ex.snippets;
      const named = mentions(ex.snippets, ticker);
      if (topic === 'competition') {
        // target's 10-K names candidate, or candidate's 10-K names target
        const hits = ticker === ctx.target ? named.filter((t) => ctx.pool.includes(t)) : named.includes(ctx.target) ? [ticker] : [];
        for (const t of hits) {
          const r = ctx.rec(t);
          r.namedAsCompetitor = [...new Set([...(r.namedAsCompetitor ?? []), sourceId])];
        }
      }
      return { data: { sourceId, form: original.form, filed: original.filed, snippets: ex.snippets, companiesMentioned: named }, summary: `${original.form} 발췌 ${ex.snippets.length}건, 언급 기업: ${named.join(', ') || '없음'}` };
    },
  },
  {
    name: 'get_financials', stage: 'metrics',
    description: 'XBRL 공시에서 정규화한 연간 매출·영업이익·연구개발비와 코드로 계산한 성장률·영업이익률·R&D 비중을 조회한다. 각 값에 sourceId가 있다.',
    input_schema: obj({ ticker: tickerProp }),
    async run(ctx, { ticker }) {
      const f = await ctx.financials(ticker);
      const v = f.latest?.values;
      const compact = (pv: typeof f.latest) => pv && { period: `${pv.periodStart}~${pv.periodEnd}`, ...Object.fromEntries(Object.entries(pv.values).map(([k, m]) => [k, { value: m!.value, unit: m!.unit, concept: m!.concept, filed: m!.filed, sourceId: m!.sourceId }])) };
      return {
        data: { ticker, latest: compact(f.latest), prior: compact(f.prior), computed: { revenueGrowth: fmtPct(f.revenueGrowth), operatingMargin: fmtPct(f.operatingMargin), rndRatio: fmtPct(f.rndRatio) }, missing: f.missing, notes: f.notes },
        summary: v?.revenue ? `${f.latest!.periodEnd} 매출 ${fmtUsdB(v.revenue.value)}, 성장 ${fmtPct(f.revenueGrowth)}, 영업이익률 ${fmtPct(f.operatingMargin)}` : `재무자료 누락 (${f.notes[0] ?? f.missing.join(',')})`,
      };
    },
  },
  {
    name: 'check_comparability', stage: 'metrics',
    description: '대상 기업과 후보의 재무 비교 가능성(누락·회계기준·회계연도 차이·규모)을 검사하고, 공개된 초기 설정 가중치의 규칙 기반 참고 점수를 계산한다. 참고 점수는 정답이나 확률이 아니다.',
    input_schema: obj({ ticker: tickerProp }),
    async run(ctx, { ticker }) {
      if (ticker === ctx.target) throw new ToolInputError('대상 기업 자신은 비교 대상이 아님');
      const tf = await ctx.financials(ctx.target), cf = await ctx.financials(ticker);
      const tp = profileOf(ctx.target)!, cp = profileOf(ticker)!;
      const r = ctx.rec(ticker);
      r.profile ??= cp;
      const form = (await ctx.annualFiling(ticker))?.form;
      r.issues = checkComparability(tf, cf, cp, form);
      r.ruleScore = ruleScore(tp, cp, tf, cf, r.issues, !!r.namedAsCompetitor?.length);
      return {
        data: { issues: r.issues, referenceScore: r.ruleScore, scoring: { weights: SCORING.weights, note: '초기 설정 규칙 점수. 정답이나 확률이 아님' }, namedAsCompetitorIn: r.namedAsCompetitor ?? [] },
        summary: `이슈 ${r.issues.filter((i) => i.level !== 'info').length}건${r.issues.some((i) => i.level === 'block') ? ' (비교 불가)' : ''}, 참고점수 ${r.ruleScore.total}`,
      };
    },
  },
  {
    name: 'save_review', stage: 'review',
    description: '후보 1개에 대한 검토 결과를 저장한다. 기준별 판단과 근거 sourceId(도구 결과에 있던 것만 유효)를 포함해야 한다. 차단 이슈가 있는 후보는 selected로 저장할 수 없다.',
    input_schema: obj({
      ticker: tickerProp,
      decision: { type: 'string', enum: ['selected', 'excluded', 'hold'] },
      relationship: { type: 'string', enum: ['business_competitor', 'financial_comparable', 'both', 'none'] },
      criteria: obj({ product: judgment, customers: judgment, scale: judgment, growthProfitability: judgment, dataSufficiency: judgment }),
      reason: { type: 'string', description: '선정/제외/보류 이유 (도구가 반환한 숫자만 인용)' },
      sourceIds: { type: 'array', items: { type: 'string' } },
    }),
    async run(ctx, input) {
      return saveReview(ctx, input, ctx.reviewAuthor);
    },
  },
];

export function saveReview(ctx: Ctx, input: Omit<Review, 'author' | 'warnings'>, author: Review['author']) {
  const { ticker, decision } = input;
  if (ticker === ctx.target || !ctx.pool.includes(ticker)) throw new ToolInputError(`후보군에 없는 티커: ${ticker}`);
  const r = ctx.rec(ticker);
  if (decision === 'selected' && r.issues?.some((i) => i.level === 'block')) throw new ToolInputError(`${ticker}는 비교 불가(차단) 이슈가 있어 selected로 저장할 수 없음: ${r.issues.find((i) => i.level === 'block')!.message}`);
  if (decision === 'selected' && !r.financials) throw new ToolInputError(`${ticker} 재무자료를 먼저 조회해야 선정할 수 있음 (get_financials)`);
  const known = new Set(ctx.sources.map((s) => s.id));
  const warnings: string[] = [];
  const keep = (ids: string[]) => {
    const bad = ids.filter((i) => !known.has(i));
    if (bad.length) warnings.push(`존재하지 않는 출처 ID 제거: ${bad.join(', ')}`);
    return ids.filter((i) => known.has(i));
  };
  const criteria = Object.fromEntries(Object.entries(input.criteria).map(([k, c]) => [k, { ...c, sourceIds: keep(c.sourceIds) }])) as Record<CriterionKey, CriterionJudgment>;
  const sourceIds = keep(input.sourceIds);
  if (decision === 'selected' && !sourceIds.length && !Object.values(criteria).some((c) => c.sourceIds.length)) throw new ToolInputError('선정 근거에 유효한 출처 ID(S#)가 최소 1개 필요');
  if (author === 'llm') {
    const texts = [input.reason, ...Object.values(criteria).map((c) => c.note)].join(' ');
    const bad = unverifiedNumbers(texts, knownNumbers(ctx, ticker));
    if (bad.length) warnings.push(`도구 결과와 일치하지 않는 숫자 표현: ${bad.join(', ')} — 원문·비교표로 확인 필요`);
  }
  r.review = { ...input, criteria, sourceIds, author, warnings };
  return { data: { saved: true, warnings }, summary: `${ticker} → ${decisionLabel[decision]}${warnings.length ? ` (경고 ${warnings.length})` : ''}` };
}


// Numbers the LLM is allowed to mention: anything the tools returned for target/candidate.
function knownNumbers(ctx: Ctx, ticker: string) {
  const pct: number[] = [], usdB: number[] = [], ratios: number[] = [];
  for (const t of [ctx.target, ticker]) {
    const f = ctx.records.get(t)?.financials;
    if (!f) continue;
    for (const x of [f.revenueGrowth, f.operatingMargin, f.rndRatio]) if (x != null) pct.push(x * 100);
    for (const pv of [f.latest, f.prior]) for (const v of Object.values(pv?.values ?? {})) usdB.push(v!.value / 1e9);
  }
  const tf = ctx.records.get(ctx.target)?.financials, cf = ctx.records.get(ticker)?.financials;
  const r = tf && cf ? scaleRatio(tf, cf) : null;
  if (r) ratios.push(r, 1 / r);
  return { pct, usdB, ratios };
}

export function unverifiedNumbers(text: string, k: { pct: number[]; usdB: number[]; ratios: number[] }): string[] {
  const out: string[] = [];
  const near = (x: number, list: number[], tol: (v: number) => number) => list.some((v) => Math.abs(Math.abs(v) - Math.abs(x)) <= tol(v));
  for (const m of text.matchAll(/(-?\d+(?:\.\d+)?)\s*%(?!p)/g)) if (!near(+m[1], k.pct, () => 0.6)) out.push(m[0]);
  for (const m of text.matchAll(/\$\s?(\d+(?:\.\d+)?)\s*(B|bn|billion)\b/gi)) if (!near(+m[1], k.usdB, (v) => Math.abs(v) * 0.01 + 0.06)) out.push(m[0]);
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*배/g)) if (!near(+m[1], k.ratios, (v) => v * 0.05 + 0.06)) out.push(m[0]);
  return out;
}

// ---------------- Loop ----------------
export interface ToolCall { id: string; name: string; input: Record<string, unknown> }
export interface ToolResult { id: string; name: string; ok: boolean; content: string }
export type Step = { calls: ToolCall[] } | { done: string };
export interface Policy {
  next(ctx: Ctx, results: ToolResult[] | null, budget: { toolCallsLeft: number; msLeft: number }): Promise<Step>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function execTool(ctx: Ctx, call: ToolCall, maxRetries: number): Promise<{ result: ToolResult; entry: ToolLogEntry }> {
  const t0 = Date.now();
  const def = TOOLS.find((t) => t.name === call.name);
  let attempts = 0, lastErr = '';
  while (def && attempts <= maxRetries) {
    attempts++;
    try {
      const { data, summary } = await def.run(ctx, call.input);
      return { result: { id: call.id, name: call.name, ok: true, content: JSON.stringify(data).slice(0, 14000) }, entry: { tool: call.name, args: call.input, ok: true, summary, attempts, ms: Date.now() - t0 } };
    } catch (e) {
      lastErr = (e as Error).message;
      if (e instanceof ToolInputError) break; // not transient: no retry
      await sleep(400 * attempts);
    }
  }
  if (!def) lastErr = `알 수 없는 도구: ${call.name}`;
  return { result: { id: call.id, name: call.name, ok: false, content: `오류: ${lastErr}` }, entry: { tool: call.name, args: call.input, ok: false, summary: `실패: ${lastErr}`, attempts, ms: Date.now() - t0 } };
}

export async function runAgent(opts: { target: string; asOf: string; mode: Mode; ds: DataSource; policy: Policy; limits?: Limits; emit?: (e: AgentEvent) => void; modeLabel: string; dataNote: string }): Promise<AnalysisResult> {
  const limits = opts.limits ?? DEFAULT_LIMITS[opts.mode];
  const emit = opts.emit ?? (() => {});
  const startedAt = new Date();
  const ctx = new Ctx(opts.target, opts.asOf, opts.ds);
  const toolLog: ToolLogEntry[] = [];
  const warnings: string[] = [];
  const stages = new Set<Stage>();
  let toolCalls = 0, turns = 0, stopReason: string | undefined, summary = '';
  let results: ToolResult[] | null = null;
  const msLeft = () => limits.timeoutMs - (Date.now() - startedAt.getTime());

  while (true) {
    if (turns >= limits.maxTurns) { stopReason = `판단 단계 한도(${limits.maxTurns}회) 도달`; break; }
    if (msLeft() <= 0) { stopReason = `실행 시간 한도(${limits.timeoutMs / 1000}초) 초과`; break; }
    turns++;
    let step: Step;
    try {
      step = await opts.policy.next(ctx, results, { toolCallsLeft: limits.maxToolCalls - toolCalls, msLeft: msLeft() });
    } catch (e) {
      stopReason = `판단 단계 실패: ${(e as Error).message}`;
      break;
    }
    if ('done' in step) { summary = step.done; break; }
    results = [];
    for (const call of step.calls) {
      if (toolCalls >= limits.maxToolCalls || msLeft() <= 0) {
        stopReason ??= toolCalls >= limits.maxToolCalls ? `도구 호출 한도(${limits.maxToolCalls}회) 도달` : `실행 시간 한도(${limits.timeoutMs / 1000}초) 초과`;
        results.push({ id: call.id, name: call.name, ok: false, content: `오류: ${stopReason}. 더 이상 도구를 호출할 수 없음` });
        continue;
      }
      toolCalls++;
      const stage = TOOLS.find((t) => t.name === call.name)?.stage;
      if (stage && !stages.has(stage)) { stages.add(stage); emit({ type: 'stage', stage, status: 'active' }); }
      const { result, entry } = await execTool(ctx, call, limits.maxRetries);
      toolLog.push(entry);
      emit({ type: 'tool', entry });
      results.push(result);
    }
    if (stopReason) break;
  }

  for (const s of ['collect', 'metrics', 'review'] as Stage[]) emit({ type: 'stage', stage: s, status: 'done' });
  emit({ type: 'stage', stage: 'report', status: 'active' });

  const candidates = ctx.pool.map((t) => ctx.rec(t));
  const unreviewed = candidates.filter((c) => !c.review).map((c) => c.ticker);
  if (unreviewed.length) warnings.push(`검토되지 않은 후보: ${unreviewed.join(', ')}`);
  const selected = candidates.filter((c) => c.review?.decision === 'selected').map((c) => c.ticker);
  if (selected.length < SCORING.minPeers) warnings.push(`근거가 충분한 Peer가 ${selected.length}개로 권장 최소(${SCORING.minPeers}개)보다 적음`);
  if (selected.length > SCORING.maxPeers) warnings.push(`선정 Peer ${selected.length}개 — 권장 최대(${SCORING.maxPeers}개) 초과`);
  const reviewWarn = candidates.flatMap((c) => (c.review?.warnings ?? []).map((w) => `${c.ticker}: ${w}`));
  warnings.push(...reviewWarn);
  if (toolLog.some((e) => !e.ok)) warnings.push(`실패한 도구 호출 ${toolLog.filter((e) => !e.ok).length}건 (실행 로그 참조)`);

  const reviewed = candidates.length - unreviewed.length;
  const result: AnalysisResult = {
    mode: opts.mode, modeLabel: opts.modeLabel, target: opts.target, asOf: opts.asOf,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    status: !stopReason ? 'complete' : reviewed ? 'partial' : 'failed',
    stopReason, summary: summary || (stopReason ? `실행이 중단되어 부분 결과만 제공합니다: ${stopReason}` : ''),
    target_record: ctx.rec(opts.target), candidates, selected, sources: ctx.sources, toolLog, warnings, limits, dataNote: opts.dataNote,
  };
  emit({ type: 'stage', stage: 'report', status: 'done' });
  return result;
}

// ---------------- Demo policy: deterministic, disclosed rules ----------------
export class RulePolicy implements Policy {
  private phase = 0;
  private n = 0;
  private call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `r${++this.n}`, name, input });

  async next(ctx: Ctx): Promise<Step> {
    const T = ctx.target;
    switch (this.phase++) {
      case 0:
        return { calls: [this.call('list_candidates', { target: T }), this.call('get_company_profile', { ticker: T }), this.call('get_financials', { ticker: T }), this.call('get_filing_excerpt', { ticker: T, topic: 'competition' })] };
      case 1:
        return { calls: ctx.pool.flatMap((t) => [this.call('get_company_profile', { ticker: t }), this.call('get_financials', { ticker: t }), this.call('check_comparability', { ticker: t })]) };
      case 2: {
        // Business similarity unclear (partial) and not named in target's 10-K → read the candidate's own 10-K competition section.
        const unclear = ctx.pool.filter((t) => {
          const r = ctx.rec(t);
          return r.ruleScore && !r.issues?.some((i) => i.level === 'block') && !r.namedAsCompetitor?.length && assess(r.ruleScore.parts.product) === 'partial';
        });
        if (unclear.length) return { calls: unclear.map((t) => this.call('get_filing_excerpt', { ticker: t, topic: 'competition' })) };
        return this.next(ctx); // nothing unclear: go straight to decisions
      }
      case 3: {
        // Re-score with any new competitor evidence, then decide.
        const tp = profileOf(T)!, tf = ctx.rec(T).financials!;
        for (const t of ctx.pool) {
          const r = ctx.rec(t);
          if (r.financials && r.profile && r.issues) r.ruleScore = ruleScore(tp, r.profile, tf, r.financials, r.issues, !!r.namedAsCompetitor?.length);
        }
        const ranked = ctx.pool.map((t) => ctx.rec(t)).filter((r) => r.ruleScore && !r.issues?.some((i) => i.level === 'block')).sort((a, b) => b.ruleScore!.total - a.ruleScore!.total);
        const selected = new Set(ranked.filter((r) => r.ruleScore!.total >= SCORING.selectThreshold && r.ruleScore!.parts.dataSufficiency === 1).slice(0, SCORING.maxPeers).map((r) => r.ticker));
        ctx.reviewAuthor = 'rule';
        return { calls: ctx.pool.filter((t) => ctx.rec(t).profile).map((t) => this.call('save_review', ruleReview(ctx, t, selected.has(t)) as unknown as Record<string, unknown>)) };
      }
      default: {
        const sel = ctx.pool.filter((t) => ctx.rec(t).review?.decision === 'selected');
        return { done: `[데모 · 규칙 기반] ${T}의 후보 ${ctx.pool.length}개를 공개된 초기 설정 기준으로 검토해 ${sel.length}개(${sel.join(', ') || '없음'})를 Peer로 제안했습니다. 참고 점수는 정답이나 확률이 아니며, 선정·제외 근거와 출처를 함께 확인해야 합니다.` };
      }
    }
  }
}

function ruleReview(ctx: Ctx, t: string, isSelected: boolean): Omit<Review, 'author' | 'warnings'> {
  const r = ctx.rec(t);
  const tf = ctx.rec(ctx.target).financials!;
  const p = r.profile!, f = r.financials, s = r.ruleScore;
  const profileSrc = ctx.sources.filter((x) => x.kind === 'profile' && (x.ticker === t || x.ticker === ctx.target)).map((x) => x.id);
  const xbrl = ctx.sources.filter((x) => x.kind === 'xbrl' && (x.ticker === t || x.ticker === ctx.target)).map((x) => x.id);
  const named = r.namedAsCompetitor ?? [];
  const block = r.issues?.find((i) => i.level === 'block');
  const tp = profileOf(ctx.target)!;

  const j = (x: number | undefined, note: string, ids: string[]): CriterionJudgment => ({ assessment: x == null ? 'unknown' : assess(x), note, sourceIds: ids });
  const ratio = f && scaleRatio(tf, f);
  const criteria: Record<CriterionKey, CriterionJudgment> = {
    product: j(s?.parts.product, `${p.businessModel}; 공통 제품 태그: ${p.productTags.filter((x) => tp.productTags.includes(x)).join(', ') || '없음'}${named.length ? '; 연간보고서 경쟁사 기술에 등장' : ''}`, [...profileSrc, ...named]),
    customers: j(s?.parts.customers, `공통 최종시장·고객 태그: ${[...p.endMarkets, ...p.customerTags].filter((x) => [...tp.endMarkets, ...tp.customerTags].includes(x)).join(', ') || '없음'}`, profileSrc),
    scale: j(s?.parts.scale, ratio ? `매출 ${fmtUsdB(f!.latest!.values.revenue!.value)} (대상 대비 ${ratio.toFixed(2)}배)` : '매출 비교 불가', xbrl),
    growthProfitability: j(s?.parts.growthProfitability, f?.latest ? `성장률 ${fmtPct(f.revenueGrowth)} vs ${fmtPct(tf.revenueGrowth)}, 영업이익률 ${fmtPct(f.operatingMargin)} vs ${fmtPct(tf.operatingMargin)}` : '자료 없음', xbrl),
    dataSufficiency: j(s?.parts.dataSufficiency ?? 0, (r.issues ?? []).filter((i) => i.level !== 'info').map((i) => i.message).join('; ') || '핵심 지표 확보', xbrl),
  };
  const business = named.length > 0 || (s ? s.parts.product >= 0.5 : false);
  const financial = !!s && s.parts.scale >= 0.5 && s.parts.growthProfitability >= 0.5 && p.businessModelTag === tp.businessModelTag;
  const relationship: Relationship = business && financial ? 'both' : business ? 'business_competitor' : financial ? 'financial_comparable' : 'none';

  let decision: Decision, reason: string;
  if (block) {
    decision = 'excluded';
    reason = `재무 비교 불가: ${block.message}.${p.businessModelTag === 'foundry' ? ' 사업상으로도 경쟁사가 아닌 공급사(파운드리) 관계.' : ''}`;
  } else if (!s) {
    decision = 'hold';
    reason = '자료 수집 또는 비교 가능성 검사가 완료되지 않아 판단 보류 (실행 로그 참조)';
  } else if (isSelected) {
    decision = 'selected';
    reason = `참고 점수 ${s!.total} (기준 ${SCORING.selectThreshold} 이상). ${relationshipLabel[relationship]}.${named.length ? ' 연간보고서 경쟁사 기술에 등장.' : ''}`;
  } else if (s && s.total >= SCORING.selectThreshold && s.parts.dataSufficiency < 1) {
    decision = 'hold';
    reason = `점수는 기준 이상이나 핵심 지표 누락으로 판단 보류: ${criteria.dataSufficiency.note}`;
  } else if (s.total >= SCORING.selectThreshold) {
    decision = 'excluded';
    reason = `참고 점수 ${s.total}로 기준 이상이나 최대 ${SCORING.maxPeers}개 한도에서 순위가 밀려 제외. ${relationshipLabel[relationship]}. 필요하면 사용자가 Peer로 추가할 수 있음.`;
  } else {
    decision = 'excluded';
    const weak = (Object.keys(s!.parts) as CriterionKey[]).filter((k) => s!.parts[k] < 0.2).map((k) => criterionLabel[k]);
    reason = `참고 점수 ${s!.total} < 기준 ${SCORING.selectThreshold}.${weak.length ? ` 유사성 낮은 기준: ${weak.join(', ')}.` : ''}${relationship === 'business_competitor' ? ' 일부 사업 경쟁은 있으나 재무 특성 차이가 큼.' : ''}`;
  }
  return { ticker: t, decision, relationship, criteria, reason, sourceIds: [...new Set([...named, ...profileSrc.slice(0, 1)])] };
}
