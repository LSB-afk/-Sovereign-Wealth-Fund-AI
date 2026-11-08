// Knowledge graph built from collected filings.
// Every edge carries evidence: the filing URL and (for extracted relations) a verbatim quote from the 10-K/20-F excerpt.
//  - rule extractor (demo): company-name matching inside the "competition" section → COMPETES_WITH
//  - llm extractor (real): Claude reads the excerpts and proposes triples; a triple is kept only if its quote is
//    found verbatim in the excerpt text and its relation is in the allowed set (code-validated, not trusted).
//  - curated: products / end markets from the curated profile (labelled as such).
import Anthropic from '@anthropic-ai/sdk';
import { companies, type DataSource } from './datasource.ts';
import { latestAnnualFiling, type ExcerptTopic } from './edgar.ts';
import type { AnnualFiling, Profile } from './types.ts';

export type Relation = 'COMPETES_WITH' | 'SUPPLIES_TO' | 'CUSTOMER_OF' | 'PARTNERS_WITH' | 'SELLS_INTO' | 'MAKES';
const EXTRACTED: Relation[] = ['COMPETES_WITH', 'SUPPLIES_TO', 'CUSTOMER_OF', 'PARTNERS_WITH'];

export interface KGNode { id: string; type: 'company' | 'external' | 'market' | 'product'; label: string }
export interface KGEdge {
  source: string; target: string; relation: Relation; extractor: 'rule' | 'llm' | 'curated';
  quote?: string; evidenceTitle: string; url: string; filed?: string;
}
export interface KnowledgeGraph {
  asOf: string; extractor: 'rule' | 'llm'; builtAt: string;
  nodes: KGNode[]; edges: KGEdge[];
  stats: { filingsRead: number; proposed: number; kept: number; rejected: number };
  notes: string[];
}

const TOPICS: ExcerptTopic[] = ['competition', 'customers', 'segments'];
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();

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

async function llmTriples(client: Anthropic, self: Profile, text: string) {
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
  if (res.stop_reason === 'refusal') throw new Error('모델 거절');
  const block = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return (JSON.parse(block?.text ?? '{"triples":[]}').triples ?? []) as { relation: Relation; object: string; quote: string }[];
}

// A proposed triple is kept only if its relation is allowed and its quote appears verbatim in the excerpt text.
export function acceptTriple(t: { relation: string; quote: string }, normalizedText: string): boolean {
  return EXTRACTED.includes(t.relation as Relation) && !!t.quote && t.quote.length >= 15 && normalizedText.includes(norm(t.quote));
}
export { norm as normalizeText };

export async function buildGraph(ds: DataSource, asOf: string, extractor: 'rule' | 'llm'): Promise<KnowledgeGraph> {
  const nodes = new Map<string, KGNode>();
  const edges: KGEdge[] = [];
  const notes: string[] = [];
  const stats = { filingsRead: 0, proposed: 0, kept: 0, rejected: 0 };
  const client = extractor === 'llm' ? new Anthropic({ maxRetries: 2 }) : null;
  const add = (n: KGNode) => nodes.set(n.id, nodes.get(n.id) ?? n);
  const list = companies().companies;
  for (const c of list) add({ id: c.ticker, type: 'company', label: c.ticker });

  await Promise.all(list.map(async (c) => {
    const filings = await ds.filings(c.ticker);
    const f0 = latestAnnualFiling(filings, asOf);
    if (!f0) { notes.push(`${c.ticker}: 기준일 이전 연간보고서 없음`); return; }
    const f: AnnualFiling = filings.find((x) => x.filed === f0.filed && !x.form.endsWith('/A')) ?? f0;
    const title = `${c.ticker} ${f.form} (${f.filed})`;
    for (const m of c.endMarkets) { add({ id: `m:${m}`, type: 'market', label: m }); edges.push({ source: c.ticker, target: `m:${m}`, relation: 'SELLS_INTO', extractor: 'curated', evidenceTitle: `${title} Item 1 기반 큐레이션`, url: f.url, filed: f.filed }); }
    for (const p of c.productTags) { add({ id: `p:${p}`, type: 'product', label: p }); edges.push({ source: c.ticker, target: `p:${p}`, relation: 'MAKES', extractor: 'curated', evidenceTitle: `${title} Item 1 기반 큐레이션`, url: f.url, filed: f.filed }); }

    const ex = Object.fromEntries(await Promise.all(TOPICS.map(async (t) => [t, (await ds.excerpts(c.ticker, f, t))?.snippets ?? []] as const)));
    if (!TOPICS.some((t) => ex[t].length)) { notes.push(`${c.ticker}: ${title} 원문 발췌 없음`); return; }
    stats.filingsRead++;
    const fullText = TOPICS.map((t) => `[${t}]\n${ex[t].join('\n')}`).join('\n\n');

    let triples: { relation: Relation; object: string; quote: string }[];
    if (client) {
      try { triples = await llmTriples(client, c, fullText); } catch (e) { notes.push(`${c.ticker}: LLM 추출 실패 — ${(e as Error).message}`); return; }
    } else {
      triples = ruleTriples(c, ex.competition);
    }
    stats.proposed += triples.length;
    const hay = norm(fullText);
    for (const t of triples) {
      // Code validation: allowed relation + verbatim quote. Anything else is rejected, never shown as fact.
      if (!acceptTriple(t, hay)) { stats.rejected++; continue; }
      const tk = tickerFor(t.object, c.ticker);
      const target = tk ?? `x:${t.object.trim()}`;
      if (target === c.ticker) { stats.rejected++; continue; }
      if (!tk) add({ id: target, type: 'external', label: t.object.trim() });
      if (edges.some((e) => e.source === c.ticker && e.target === target && e.relation === t.relation)) continue;
      edges.push({ source: c.ticker, target, relation: t.relation, extractor: client ? 'llm' : 'rule', quote: t.quote, evidenceTitle: `${title} 원문`, url: f.url, filed: f.filed });
      stats.kept++;
    }
  }));

  return { asOf, extractor, builtAt: new Date().toISOString(), nodes: [...nodes.values()], edges, stats, notes };
}
