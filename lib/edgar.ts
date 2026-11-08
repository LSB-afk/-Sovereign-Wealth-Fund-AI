// SEC EDGAR access. Official endpoints, documented at https://www.sec.gov/search-filings/edgar-application-programming-interfaces
// SEC fair-access policy requires a descriptive User-Agent with contact info and <=10 req/s.
import type { AnnualFiling, CompanyFacts, XbrlFact } from './types.ts';

export const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT', '20-F', '20-F/A']);

// Concepts we keep (also what the snapshot trims to).
export const KEPT_CONCEPTS = [
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'SalesRevenueNet',
  'OperatingIncomeLoss',
  'ResearchAndDevelopmentExpense',
  'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost',
];

const pad = (cik: number) => String(cik).padStart(10, '0');
const noDash = (accn: string) => accn.replace(/-/g, '');

export const filingIndexUrl = (cik: number, accn: string) =>
  `https://www.sec.gov/Archives/edgar/data/${cik}/${noDash(accn)}/${accn}-index.htm`;

export function userAgent(): string {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error('SEC_USER_AGENT 환경변수가 없습니다 (예: "회사명 이름 email@example.com"). SEC 공정접근 정책상 필수입니다.');
  return ua;
}

async function get(url: string, timeoutMs = 20000): Promise<Response> {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent(), 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`EDGAR ${res.status} ${url}`);
  return res;
}

export async function fetchCompanyFacts(cik: number): Promise<CompanyFacts> {
  const raw = await (await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad(cik)}.json`)).json();
  return trimFacts(raw);
}

// Keep only the concepts and fields we use; annual forms only.
export function trimFacts(raw: any): CompanyFacts {
  const facts: CompanyFacts['facts'] = {};
  for (const [tax, concepts] of Object.entries<any>(raw.facts ?? {})) {
    for (const name of KEPT_CONCEPTS) {
      const c = concepts[name];
      if (!c) continue;
      const units: Record<string, XbrlFact[]> = {};
      for (const [u, list] of Object.entries<any[]>(c.units)) {
        units[u] = list
          .filter((f) => ANNUAL_FORMS.has(f.form))
          .map((f) => ({ start: f.start, end: f.end, val: f.val, accn: f.accn, fy: f.fy, fp: f.fp, form: f.form, filed: f.filed, frame: f.frame }));
      }
      (facts[tax] ??= {})[name] = { label: c.label, units };
    }
  }
  return { cik: raw.cik, entityName: raw.entityName, taxonomies: Object.keys(raw.facts ?? {}), facts };
}

export async function fetchAnnualFilings(cik: number): Promise<AnnualFiling[]> {
  const raw = await (await get(`https://data.sec.gov/submissions/CIK${pad(cik)}.json`)).json();
  return annualFilingsFromSubmissions(cik, raw);
}

export function annualFilingsFromSubmissions(cik: number, raw: any): AnnualFiling[] {
  const r = raw.filings.recent;
  const out: AnnualFiling[] = [];
  for (let i = 0; i < r.form.length; i++) {
    if (!ANNUAL_FORMS.has(r.form[i])) continue;
    const accn = r.accessionNumber[i];
    out.push({
      form: r.form[i],
      filed: r.filingDate[i],
      reportDate: r.reportDate[i],
      accn,
      primaryDocument: r.primaryDocument[i],
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${noDash(accn)}/${r.primaryDocument[i]}`,
      indexUrl: filingIndexUrl(cik, accn),
    });
  }
  return out;
}

// Latest annual filing filed on/before asOf. Original 10-K/20-F preferred over a same-day amendment for text,
// because amendments are often exhibit- or Part III-only.
export function latestAnnualFiling(filings: AnnualFiling[], asOf: string): AnnualFiling | null {
  const eligible = filings.filter((f) => f.filed <= asOf).sort((a, b) => b.filed.localeCompare(a.filed) || Number(a.form.endsWith('/A')) - Number(b.form.endsWith('/A')));
  return eligible[0] ?? null;
}

export async function fetchFilingText(url: string): Promise<string> {
  return htmlToText(await (await get(url, 45000)).text());
}

export function htmlToText(html: string): string {
  return html
    .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&#x2019;|&rsquo;/gi, "'")
    .replace(/&#8220;|&#8221;|&#x201c;|&#x201d;|&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&#8212;|&#x2014;|&mdash;/gi, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

export type ExcerptTopic = 'competition' | 'customers' | 'segments';

const TOPIC_PATTERNS: Record<ExcerptTopic, RegExp> = {
  competition: /(competitors include|compete with|current competitors|our competitors|competition from)/gi,
  customers: /(accounted for (approximately )?\d+% of (our )?(total )?(net )?revenue|largest customer|direct customer|customer concentration|significant portion of our revenue)/gi,
  segments: /(reportable segments?|operating segments?)/gi,
};

// Pick up to `max` non-overlapping windows around pattern hits, skipping table-of-contents-like hits
// (windows with few lowercase words). ponytail: keyword heuristic, swap for section parsing if precision matters.
export function findExcerpts(text: string, topic: ExcerptTopic, max = 3, width = topic === 'competition' ? 1800 : 900): string[] {
  const re = new RegExp(TOPIC_PATTERNS[topic].source, 'gi');
  const out: { start: number; text: string }[] = [];
  for (const m of text.matchAll(re)) {
    const start = Math.max(0, m.index! - 150);
    if (out.some((o) => Math.abs(o.start - start) < width)) continue;
    const snippet = text.slice(start, start + width).trim();
    const words = snippet.split(' ').filter((w) => /^[a-z]{3,}$/.test(w)).length;
    if (words < 60) continue;
    out.push({ start, text: snippet });
    if (out.length >= max) break;
  }
  return out.map((o) => '…' + o.text + '…');
}
