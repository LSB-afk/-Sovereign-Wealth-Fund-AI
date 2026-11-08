// Normalized annual metrics from XBRL facts. Pure functions: all numbers are computed here, never by the LLM.
//
// Rules (also shown in the UI/report):
// - Source: us-gaap taxonomy, USD unit, annual forms (10-K, 10-K/A, 10-KT, 20-F, 20-F/A), no dimensions (= consolidated total).
// - Annual = duration of 350–380 days (52/53-week years). Quarterly values inside a 10-K are dropped.
// - Point-in-time: only facts with filed <= asOf are considered.
// - Duplicates / restatements: per period, the value from the latest filing wins (prior-year comparatives in a later
//   10-K are restated figures). Same filing date: the amendment (/A) wins. Differing superseded values are noted.
// - Missing values stay null. Nothing is estimated.
import { filingIndexUrl } from './edgar.ts';
import type { CompanyFacts, Financials, MetricKey, MetricValue, PeriodValues, XbrlFact } from './types.ts';

export const METRICS: Record<MetricKey, { concepts: string[]; definition: string }> = {
  revenue: {
    concepts: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'],
    definition: '연결 기준 연간 매출 (Total revenue / net revenue)',
  },
  operatingIncome: { concepts: ['OperatingIncomeLoss'], definition: '연결 기준 연간 영업이익(손실)' },
  rnd: {
    concepts: ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'],
    definition: '연결 기준 연간 연구개발비',
  },
};

const DAY = 86400000;
export const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const isAnnual = (f: XbrlFact) => !!f.start && days(f.start, f.end) >= 350 && days(f.start, f.end) <= 380;

interface Picked { fact: XbrlFact; superseded: XbrlFact[] }

// period end -> chosen fact
export function pickByPeriod(facts: XbrlFact[], asOf: string): Map<string, Picked> {
  const groups = new Map<string, XbrlFact[]>();
  for (const f of facts) {
    if (!isAnnual(f) || f.filed > asOf) continue;
    const key = `${f.start}|${f.end}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out = new Map<string, Picked>();
  for (const list of groups.values()) {
    list.sort((a, b) => b.filed.localeCompare(a.filed) || Number(b.form.endsWith('/A')) - Number(a.form.endsWith('/A')));
    const fact = list[0];
    out.set(fact.end, { fact, superseded: list.slice(1).filter((f) => f.val !== fact.val) });
  }
  return out;
}

function conceptFacts(cf: CompanyFacts, concept: string): XbrlFact[] {
  return cf.facts['us-gaap']?.[concept]?.units?.USD ?? [];
}

function findPrior(periods: Map<string, Picked>, latestEnd: string): Picked | undefined {
  for (const [end, p] of periods) {
    const d = days(end, latestEnd);
    if (d >= 350 && d <= 380) return p;
  }
}

export function computeFinancials(ticker: string, cf: CompanyFacts, asOf: string, collectedAt: string): Financials {
  const notes: string[] = [];
  const missing: string[] = [];
  const base = { ticker, asOf, revenueGrowth: null, operatingMargin: null, rndRatio: null };

  if (!cf.facts['us-gaap']) {
    return { ...base, latest: null, prior: null, missing: ['revenue', 'operatingIncome', 'rnd'], notes: [`US GAAP 재무 데이터 없음 (제공 taxonomy: ${cf.taxonomies.join(', ')})`] };
  }

  const toValue = (metric: MetricKey, concept: string, f: XbrlFact): MetricValue => ({
    ticker, cik: cf.cik, metric, definition: METRICS[metric].definition, concept: `us-gaap:${concept}`,
    value: f.val, unit: 'USD', periodStart: f.start!, periodEnd: f.end, fiscalYear: f.fy ?? null,
    form: f.form, filed: f.filed, accn: f.accn, url: filingIndexUrl(cf.cik, f.accn), collectedAt,
  });

  // Latest annual period = most recent period end across revenue concepts.
  const revConcepts = METRICS.revenue.concepts.map((c) => ({ c, periods: pickByPeriod(conceptFacts(cf, c), asOf) }));
  const latestEnd = revConcepts.flatMap((r) => [...r.periods.keys()]).sort().at(-1);
  if (!latestEnd) {
    return { ...base, latest: null, prior: null, missing: ['revenue', 'operatingIncome', 'rnd'], notes: [`기준일(${asOf}) 이전에 공시된 연간 매출 자료 없음`] };
  }
  const latest: PeriodValues = { periodStart: '', periodEnd: latestEnd, values: {} };
  let prior: PeriodValues | null = null;

  for (const metric of Object.keys(METRICS) as MetricKey[]) {
    const options = METRICS[metric].concepts.map((c) => ({ c, periods: pickByPeriod(conceptFacts(cf, c), asOf) }));
    // Prefer one concept that covers both years so growth uses a consistent definition.
    const withLatest = options.filter((o) => o.periods.has(latestEnd));
    const chosen = withLatest.find((o) => findPrior(o.periods, latestEnd)) ?? withLatest[0];
    if (!chosen) {
      missing.push(metric);
      continue;
    }
    const cur = chosen.periods.get(latestEnd)!;
    latest.values[metric] = toValue(metric, chosen.c, cur.fact);
    latest.periodStart = cur.fact.start!;
    for (const s of cur.superseded) notes.push(`${metric} ${latestEnd}: ${s.form}(${s.filed}) 값 ${s.val}은 이후 공시 값으로 대체됨`);
    const p = findPrior(chosen.periods, latestEnd);
    if (p) {
      prior ??= { periodStart: p.fact.start!, periodEnd: p.fact.end, values: {} };
      prior.values[metric] = toValue(metric, chosen.c, p.fact);
      if (p.fact.filed !== cur.fact.filed) notes.push(`${metric} 전년 값은 ${p.fact.form}(${p.fact.filed}) 기준`);
    }
  }

  const rev = latest.values.revenue?.value;
  const prevRev = prior?.values.revenue?.value;
  const op = latest.values.operatingIncome?.value;
  const rnd = latest.values.rnd?.value;
  if (prevRev == null) missing.push('revenue_prior_year');
  const months = Math.round(days(latestEnd, asOf) / 30.4);
  if (months > 15) notes.push(`최근 연간자료 종료일(${latestEnd})이 기준일보다 ${months}개월 이전`);

  return {
    ticker, asOf, latest, prior, missing, notes,
    revenueGrowth: growth(rev, prevRev),
    operatingMargin: ratio(op, rev),
    rndRatio: ratio(rnd, rev),
  };
}

export function growth(cur?: number | null, prev?: number | null): number | null {
  if (cur == null || prev == null || prev <= 0) return null;
  return (cur - prev) / prev;
}

export function ratio(num?: number | null, rev?: number | null): number | null {
  if (num == null || rev == null || rev <= 0) return null;
  return num / rev;
}

export function median(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export const fmtPct = (x: number | null | undefined) => (x == null ? '누락' : `${(x * 100).toFixed(1)}%`);
export const fmtUsdB = (x: number | null | undefined) => (x == null ? '누락' : `${x < 0 ? '-' : ''}$${(Math.abs(x) / 1e9).toFixed(2)}B`);
