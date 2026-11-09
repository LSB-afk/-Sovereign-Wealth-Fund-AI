// Knowledge graph built from collected filings.
// Extracted edges carry a filing URL and matching quote, but remain proposals requiring human review.
//  - rule extractor (demo): company-name matching inside the "competition" section → COMPETES_WITH
//  - llm extractor (real): Claude reads the excerpts and proposes triples; a triple is kept only if its quote is
//    found in the excerpt text and its relation is in the allowed set. This does not verify the relationship.
//  - curated: products / end markets from the curated profile (labelled as such).
import Anthropic from '@anthropic-ai/sdk';
import { companies, type DataSource } from './datasource.ts';
import { latestAnnualFiling, type ExcerptTopic } from './edgar.ts';
import type { AnnualFiling, Profile } from './types.ts';
import { schemaError } from './validation.ts';

export type Relation = 'COMPETES_WITH' | 'SUPPLIES_TO' | 'CUSTOMER_OF' | 'PARTNERS_WITH' | 'SELLS_INTO' | 'MAKES';
const EXTRACTED: Relation[] = ['COMPETES_WITH', 'SUPPLIES_TO', 'CUSTOMER_OF', 'PARTNERS_WITH'];

export interface KGNode { id: string; type: 'company' | 'external' | 'market' | 'product'; label: string }
export interface KGEdge {
  source: string; target: string; relation: Relation; extractor: 'rule' | 'llm' | 'curated';
  verification: 'review_required' | 'curated';
  quote?: string; evidenceTitle: string; url: string; filed?: string;
}
export interface KnowledgeGraph {
  asOf: string; extractor: 'rule' | 'llm'; builtAt: string;
  status: 'complete' | 'partial';
  nodes: KGNode[]; edges: KGEdge[];
  stats: { filingsRead: number; proposed: number; kept: number; rejected: number };
  notes: string[];
}

const TOPICS: ExcerptTopic[] = ['competition', 'customers', 'segments'];
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();
type Triple = { relation: Relation; object: string; quote: string };
type TripleExtractor = (self: Profile, text: string) => Promise<Triple[]>;

function mentions(text: string, name: string): boolean {
  const escaped = norm(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !!escaped && new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(norm(text));
}

function tickerFor(name: string, self: string): string | null {
  const n = name.toLowerCase();
  const hit = companies().companies.find((c) => c.ticker !== self && (c.ticker.toLowerCase() === n || c.aliases.some((a) => n.includes(a.toLowerCase()))));
  return hit?.ticker ?? null;
}

// Rule extractor: sentences in the competition excerpt that name another covered company.
export function ruleTriples(self: Profile, snippets: string[]): { relation: Relation; object: string; quote: string }[] {
  const out: { relation: Relation; object: string; quote: string }[] = [];
  // Sentence/bullet split that does not break on company abbreviations ("Co. Ltd.", "Inc.").
  const parts = snippets.join(' ').replace(/…/g, ' ').split(/(?<=(?<!\b(?:Inc|Co|Ltd|Corp|No|vs|U\.S|N\.V))[.;])\s+(?=[A-Z])|\s*•\s*/);
  for (const sentence of parts) {
    for (const c of companies().companies) {
      if (c.ticker === self.ticker || out.some((t) => t.object === c.ticker)) continue;
      if (c.aliases.some((a) => new RegExp(`\\b${a}\\b`).test(sentence))) out.push({ relation: 'COMPETES_WITH', object: c.ticker, quote: sentence.trim().slice(0, 400) });
    }
  }
  return out;
}

const SCHEMA = {
  type: 'object',
  properties: {
    triples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          relation: { type: 'string', enum: EXTRACTED },
          object: { type: 'string', description: '상대 기업명 (원문 표기 그대로)' },
          quote: { type: 'string', description: '관계를 뒷받침하는 원문 문장 일부를 한 글자도 바꾸지 말고 그대로 복사' },
        },
        required: ['relation', 'object', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['triples'],
  additionalProperties: false,
};

// Structured output still needs runtime validation: truncation/refusal/missing text is a failed extraction.
export function parseTriplesResponse(response: unknown): Triple[] {
  if (!response || typeof response !== 'object') throw new Error('LLM 응답 형식 오류');
  const res = response as { stop_reason?: unknown; content?: unknown };
  if (res.stop_reason !== 'end_turn') throw new Error(`LLM 추출 미완료: ${String(res.stop_reason)}`);
  if (!Array.isArray(res.content)) throw new Error('LLM 텍스트 응답 없음');
  const text = res.content.filter((block): block is { type: 'text'; text: string } =>
    !!block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('');
  if (!text.trim()) throw new Error('LLM 텍스트 응답 없음');
  const parsed: unknown = JSON.parse(text);
  const error = schemaError(SCHEMA, parsed);
  if (error) throw new Error(`LLM 추출 구조 오류: ${error}`);
  return (parsed as { triples: Triple[] }).triples;
}

async function llmTriples(client: Anthropic, self: Profile, text: string): Promise<Triple[]> {
  const res = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    max_tokens: 8000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: `다음은 ${self.name}(${self.ticker})의 연간보고서 발췌다. 이 회사(주어)와 다른 기업 사이의 관계를 추출하라.
관계: COMPETES_WITH(경쟁사로 언급), SUPPLIES_TO(주어가 상대에게 공급), CUSTOMER_OF(주어가 상대의 고객, 예: 상대가 주어의 공급사·파운드리), PARTNERS_WITH(협력).
규칙: 원문에 명시된 관계만. quote는 원문을 그대로 복사(요약·번역 금지). 기업이 아닌 일반 명사는 제외.

${text}`,
    }],
  });
  return parseTriplesResponse(res);
}

// Full triples require an exact copied span and an object mention, but still need semantic review.
// Legacy quote-only callers may supply normalized text; graph extraction always supplies an object and raw text.
export function acceptTriple(value: unknown, sourceText: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof sourceText !== 'string') return false;
  const t = value as Record<string, unknown>;
  if (typeof t.relation !== 'string' || !EXTRACTED.includes(t.relation as Relation)
    || typeof t.quote !== 'string' || norm(t.quote).length < 15) return false;
  if (!Object.hasOwn(t, 'object')) return norm(sourceText).includes(norm(t.quote));
  if (typeof t.object !== 'string' || !t.object.trim() || !sourceText.includes(t.quote)) return false;
  const object = t.object;
  const company = companies().companies.find((c) => norm(c.ticker) === norm(object) || norm(c.name) === norm(object)
    || c.aliases.some((alias) => norm(alias) === norm(object)));
  return [object, ...(company ? [company.name, company.ticker, ...company.aliases] : [])].some((name) => mentions(t.quote as string, name));
}
export { norm as normalizeText };

export async function buildGraph(ds: DataSource, asOf: string, extractor: 'rule' | 'llm', extractTriples?: TripleExtractor): Promise<KnowledgeGraph> {
  const nodes = new Map<string, KGNode>();
  const edges: KGEdge[] = [];
  const notes: string[] = [];
  const stats = { filingsRead: 0, proposed: 0, kept: 0, rejected: 0 };
  const client = extractor === 'llm' && !extractTriples ? new Anthropic({ maxRetries: 2 }) : null;
  let status: KnowledgeGraph['status'] = 'complete';
  const add = (n: KGNode) => nodes.set(n.id, nodes.get(n.id) ?? n);
  const list = companies().companies;
  for (const c of list) add({ id: c.ticker, type: 'company', label: c.ticker });

  await Promise.all(list.map(async (c) => {
    try {
      const filings = await ds.filings(c.ticker);
      const f0 = latestAnnualFiling(filings, asOf);
      if (!f0) { status = 'partial'; notes.push(`${c.ticker}: 기준일 이전 연간보고서 없음`); return; }
      const f: AnnualFiling = filings.find((x) => x.filed === f0.filed && !x.form.endsWith('/A')) ?? f0;
      const title = `${c.ticker} ${f.form} (${f.filed})`;
      for (const m of c.endMarkets) { add({ id: `m:${m}`, type: 'market', label: m }); edges.push({ source: c.ticker, target: `m:${m}`, relation: 'SELLS_INTO', extractor: 'curated', verification: 'curated', evidenceTitle: `${title} Item 1 기반 큐레이션 (현재 프로필, 시점별 버전 없음)`, url: f.url, filed: f.filed }); }
      for (const p of c.productTags) { add({ id: `p:${p}`, type: 'product', label: p }); edges.push({ source: c.ticker, target: `p:${p}`, relation: 'MAKES', extractor: 'curated', verification: 'curated', evidenceTitle: `${title} Item 1 기반 큐레이션 (현재 프로필, 시점별 버전 없음)`, url: f.url, filed: f.filed }); }

      const ex = Object.fromEntries(await Promise.all(TOPICS.map(async (t) => [t, (await ds.excerpts(c.ticker, f, t))?.snippets ?? []] as const)));
      if (!TOPICS.some((t) => ex[t].length)) { status = 'partial'; notes.push(`${c.ticker}: ${title} 원문 발췌 없음`); return; }
      stats.filingsRead++;
      const fullText = TOPICS.map((t) => `[${t}]\n${ex[t].join('\n')}`).join('\n\n');

      const triples = extractTriples ? await extractTriples(c, fullText)
        : client ? await llmTriples(client, c, fullText) : ruleTriples(c, ex.competition);
      if (!Array.isArray(triples)) throw new Error('관계 추출 결과가 배열이 아님');
      stats.proposed += triples.length;
      for (const t of triples) {
        // A matching quote only admits a proposal for review; it cannot validate relation semantics.
        if (!acceptTriple(t, fullText)) { stats.rejected++; continue; }
        const tk = tickerFor(t.object, c.ticker);
        const target = tk ?? `x:${t.object.trim()}`;
        if (target === c.ticker) { stats.rejected++; continue; }
        if (!tk) add({ id: target, type: 'external', label: t.object.trim() });
        if (edges.some((e) => e.source === c.ticker && e.target === target && e.relation === t.relation)) continue;
        edges.push({ source: c.ticker, target, relation: t.relation, extractor, verification: 'review_required', quote: t.quote, evidenceTitle: `${title} 원문 · 관계 검토 필요`, url: f.url, filed: f.filed });
        stats.kept++;
      }
    } catch (error) {
      status = 'partial';
      notes.push(`${c.ticker}: 수집 또는 관계 추출 실패 — ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  return { asOf, extractor, status, builtAt: new Date().toISOString(), nodes: [...nodes.values()], edges, stats, notes };
}
