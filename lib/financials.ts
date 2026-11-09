// Normalized annual metrics from XBRL facts. Pure functions: all numbers are computed here, never by the LLM.
//
// Rules (also shown in the UI/report):
// - Source: us-gaap taxonomy, USD unit, annual forms (10-K, 10-K/A, 10-KT, 20-F, 20-F/A), no dimensions (= consolidated total).
// - Annual = duration of 350–380 days (52/53-week years). Quarterly values inside a 10-K are dropped.
// - Point-in-time: only facts with filed <= asOf are considered.
// - Duplicates / restatements: per period, the value from the latest filing wins (prior-year comparatives in a later
//   10-K are restated figures). Same filing date: the amendment (/A) wins. Differing superseded values are noted.
// - Missing values stay null. Nothing is estimated.
import { ANNUAL_FORMS, filingIndexUrl } from './edgar.ts';
import { isDate } from './validation.ts';
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
const validFact = (f: XbrlFact) => Number.isFinite(f.val) && isDate(f.start) && isDate(f.end)
  && isDate(f.filed) && f.end <= f.filed && ANNUAL_FORMS.has(f.form);
const periodKey = (start: string, end: string) => `${start}|${end}`;

interface Picked { fact: XbrlFact; superseded: XbrlFact[] }

// Exact start/end period -> chosen fact. Different durations must never overwrite one another.
export function pickByPeriod(facts: XbrlFact[], asOf: string): Map<string, Picked> {
  const groups = new Map<string, XbrlFact[]>();
  for (const f of facts) {
    if (!validFact(f) || !isAnnual(f) || f.filed > asOf) continue;
    const key = periodKey(f.start!, f.end);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out = new Map<string, Picked>();
  for (const list of groups.values()) {
    list.sort((a, b) => b.filed.localeCompare(a.filed) || Number(b.form.endsWith('/A')) - Number(a.form.endsWith('/A')));
    const fact = list[0];
    out.set(periodKey(fact.start!, fact.end), { fact, superseded: list.slice(1).filter((f) => f.val !== fact.val) });
  }
  return out;
}

function conceptFacts(cf: CompanyFacts, concept: string): XbrlFact[] {
  return cf.facts['us-gaap']?.[concept]?.units?.USD ?? [];
}

function atEnd(periods: Map<string, Picked>, end: string): Picked | undefined {
  const matches = [...periods.values()].filter((p) => p.fact.end === end);
  return matches.length === 1 ? matches[0] : undefined;
}

function findPrior(periods: Map<string, Picked>, latestEnd: string): Picked | undefined {
  const ends = [...periods.values()].map((p) => p.fact.end).filter((end) => {
    const gap = days(end, latestEnd);
    return gap >= 350 && gap <= 380;
  }).sort();
  const end = ends.at(-1);
  return end ? atEnd(periods, end) : undefined;
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

  const periodsFor = (concept: string) => {
    const values = conceptFacts(cf, concept);
    if (values.some((f) => !validFact(f))) notes.push(`${concept}: 수치·공시일·회계기간이 유효하지 않은 원값은 제외함`);
    return pickByPeriod(values, asOf);
  };
  // Revenue defines the canonical current/prior periods for every metric and ratio.
  const revConcepts = METRICS.revenue.concepts.map((c) => ({ c, periods: periodsFor(c) }));
  const latestEnd = revConcepts.flatMap((r) => [...r.periods.values()].map((p) => p.fact.end)).sort().at(-1);
  if (!latestEnd) {
    return { ...base, latest: null, prior: null, missing: ['revenue', 'operatingIncome', 'rnd'], notes: [...notes, `기준일(${asOf}) 이전에 공시된 연간 매출 자료 없음`] };
  }
  const revenueOptions = revConcepts.map((o) => ({ ...o, current: atEnd(o.periods, latestEnd) })).filter((o) => o.current);
  // Keep the same revenue definition for both years whenever available.
  const revenue = revenueOptions.find((o) => findPrior(o.periods, latestEnd)) ?? revenueOptions[0];
  if (!revenue) {
    return { ...base, latest: null, prior: null, missing: ['revenue', 'operatingIncome', 'rnd'], notes: [...notes, `매출의 동일 종료일(${latestEnd})에 서로 다른 회계기간이 있어 판단 보류`] };
  }
  const currentRevenue = revenue.current!;
  const priorRevenue = findPrior(revenue.periods, latestEnd);
  const latest: PeriodValues = { periodStart: currentRevenue.fact.start!, periodEnd: latestEnd, values: { revenue: toValue('revenue', revenue.c, currentRevenue.fact) } };
  const prior: PeriodValues | null = priorRevenue
    ? { periodStart: priorRevenue.fact.start!, periodEnd: priorRevenue.fact.end, values: { revenue: toValue('revenue', revenue.c, priorRevenue.fact) } }
    : null;
  const noteSuperseded = (metric: MetricKey, picked: Picked) => {
    for (const s of picked.superseded) notes.push(`${metric} ${picked.fact.end}: ${s.form}(${s.filed}) 값 ${s.val}은 이후 공시 값으로 대체됨`);
  };
  noteSuperseded('revenue', currentRevenue);
  if (priorRevenue && priorRevenue.fact.filed !== currentRevenue.fact.filed) notes.push(`revenue 전년 값은 ${priorRevenue.fact.form}(${priorRevenue.fact.filed}) 기준`);

  for (const metric of ['operatingIncome', 'rnd'] as const) {
    const options = METRICS[metric].concepts.map((c) => ({ c, periods: periodsFor(c) }));
    const currentKey = periodKey(latest.periodStart, latest.periodEnd);
    const priorKey = prior && periodKey(prior.periodStart, prior.periodEnd);
    const withLatest = options.filter((o) => o.periods.has(currentKey));
    const chosen = withLatest.find((o) => priorKey && o.periods.has(priorKey)) ?? withLatest[0];
    if (!chosen) {
      missing.push(metric);
      if (options.some((o) => [...o.periods.values()].some((p) => p.fact.end === latestEnd))) notes.push(`${metric}: 매출과 회계기간 시작일이 달라 원값과 비율을 제외함`);
      continue;
    }
    const cur = chosen.periods.get(currentKey)!;
    latest.values[metric] = toValue(metric, chosen.c, cur.fact);
    noteSuperseded(metric, cur);
    const p = priorKey ? chosen.periods.get(priorKey) : undefined;
    if (p && prior) {
      prior.values[metric] = toValue(metric, chosen.c, p.fact);
      if (p.fact.filed !== cur.fact.filed) notes.push(`${metric} 전년 값은 ${p.fact.form}(${p.fact.filed}) 기준`);
    } else if (prior && findPrior(chosen.periods, latestEnd)) {
      notes.push(`${metric} 전년 값: 전년 매출과 회계기간이 달라 제외함`);
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
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  const value = (cur - prev) / prev;
  return Number.isFinite(value) ? value : null;
}

export function ratio(num?: number | null, rev?: number | null): number | null {
  if (num == null || rev == null || !Number.isFinite(num) || !Number.isFinite(rev) || rev <= 0) return null;
  const value = num / rev;
  return Number.isFinite(value) ? value : null;
}

export function median(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export const fmtPct = (x: number | null | undefined) => (x == null ? '누락' : `${(x * 100).toFixed(1)}%`);
export const fmtUsdB = (x: number | null | undefined) => (x == null ? '누락' : `${x < 0 ? '-' : ''}$${(Math.abs(x) / 1e9).toFixed(2)}B`);
