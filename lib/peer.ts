// Comparability checks and the disclosed rule-based reference score. Pure functions.
import { days } from './financials.ts';
import type { CriterionKey, Financials, Issue, Profile, RuleScore } from './types.ts';

export function checkComparability(target: Financials, cand: Financials, candProfile?: Profile, form?: string): Issue[] {
  const issues: Issue[] = [];
  if (!target.latest?.values.revenue || target.operatingMargin == null || target.revenueGrowth == null) {
    issues.push({ level: 'block', code: 'target_missing_metrics', message: '대상 기업의 매출·성장률·영업이익률 자료가 부족해 비교할 수 없음' });
  }
  for (const n of cand.notes) if (n.startsWith('US GAAP') || n.startsWith('기준일')) issues.push({ level: 'block', code: 'no_usgaap_data', message: n });
  if (!issues.length && !cand.latest?.values.revenue) issues.push({ level: 'block', code: 'missing_revenue', message: '최근 연간 매출 누락' });
  if (cand.latest && !cand.latest.values.operatingIncome) issues.push({ level: 'warn', code: 'missing_operating_income', message: '영업이익 누락 → 영업이익률 비교 불가' });
  if (cand.latest && cand.revenueGrowth == null) issues.push({ level: 'warn', code: 'missing_growth', message: '전년 매출 누락 → 성장률 비교 불가' });
  if (cand.latest && !cand.latest.values.rnd) issues.push({ level: 'info', code: 'missing_rnd', message: '연구개발비 누락' });
  if (form?.startsWith('20-F')) issues.push({ level: 'info', code: 'foreign_filer', message: `외국 발행인(${form}) — 공시 양식·주기가 10-K와 다름` });
  if (target.latest && cand.latest) {
    const gap = Math.round(Math.abs(days(cand.latest.periodEnd, target.latest.periodEnd)) / 30.4);
    if (gap >= 3) issues.push({ level: 'warn', code: 'fiscal_year_gap', message: `회계연도 종료일 차이 약 ${gap}개월 (${cand.latest.periodEnd} vs 대상 ${target.latest.periodEnd})` });
    const r = scaleRatio(target, cand);
    if (r != null) issues.push({ level: r < 0.1 ? 'warn' : 'info', code: 'scale', message: `매출 규모 대상 대비 ${r.toFixed(2)}배` });
    const tc = target.latest.values.revenue?.concept, cc = cand.latest.values.revenue?.concept;
    if (tc && cc && tc !== cc) issues.push({ level: 'info', code: 'concept_diff', message: `매출 XBRL 항목명 상이 (${cc} vs ${tc}) — 정의 차이 확인 필요` });
  }
  for (const n of cand.notes) if (n.startsWith('최근 연간자료')) issues.push({ level: 'warn', code: 'stale', message: n });
  if (candProfile?.businessModelTag === 'foundry') issues.push({ level: 'info', code: 'supplier', message: '파운드리: 팹리스 대상 기업의 공급사 관계일 수 있음' });
  return issues;
}

export function scaleRatio(target: Financials, cand: Financials): number | null {
  const a = target.latest?.values.revenue?.value, b = cand.latest?.values.revenue?.value;
  return a && b ? b / a : null;
}

// ---- Rule-based reference score (초기 설정) ----
// Not an objective answer or probability. Weights and thresholds are initial settings, disclosed in the UI and report.
export const SCORING = {
  weights: { product: 0.35, customers: 0.2, scale: 0.15, growthProfitability: 0.15, dataSufficiency: 0.15 } as Record<CriterionKey, number>,
  selectThreshold: 0.45,
  maxPeers: 5,
  minPeers: 3,
  description: [
    '주요 제품·사업모델(35%): 제품 태그 자카드 유사도 + 사업모델 동일 시 0.2 가산(최대 1). 대상 10-K 경쟁사 목록에 이름이 있으면 최소 0.5',
    '매출 구성·고객군(20%): 최종시장·고객 태그 자카드 유사도',
    '기업 규모(15%): 매출 배수 0.33~3배 = 1, 0.1~10배 = 0.5, 그 외 0',
    '성장성·수익성(15%): 1 − (|성장률 차이| + |영업이익률 차이|), 0~1로 제한 (차이 합 100%p 이상이면 0)',
    '자료 충분성(15%): 차단 이슈 있으면 0, 핵심 지표 누락 경고가 있으면 0.5, 그 외 1. 회계기간 차이 등 다른 경고는 별도 검토',
    '선정 게시: 차단 이슈 없음 + 자료 충분성 1 + 점수 0.45 이상 상위 최대 5개 + 출처 검사 통과. 3개 미만이면 경고 표시',
  ],
};

const jaccard = (a: string[], b: string[]) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni ? inter / uni : 0;
};
const clamp = (x: number) => Math.max(0, Math.min(1, x));

export function ruleScore(tp: Profile, cp: Profile, tf: Financials, cf: Financials, issues: Issue[], namedAsCompetitor: boolean): RuleScore {
  let product = clamp(jaccard(tp.productTags, cp.productTags) + (tp.businessModelTag === cp.businessModelTag ? 0.2 : 0));
  if (namedAsCompetitor) product = Math.max(product, 0.5);
  const customers = jaccard([...tp.endMarkets, ...tp.customerTags], [...cp.endMarkets, ...cp.customerTags]);
  const r = scaleRatio(tf, cf);
  const scale = r == null ? 0 : r >= 0.33 && r <= 3 ? 1 : r >= 0.1 && r <= 10 ? 0.5 : 0;
  const gp = tf.revenueGrowth != null && cf.revenueGrowth != null && tf.operatingMargin != null && cf.operatingMargin != null
    ? clamp(1 - (Math.abs(tf.revenueGrowth - cf.revenueGrowth) + Math.abs(tf.operatingMargin - cf.operatingMargin)) / 1.0)
    : 0;
  const dataSufficiency = issues.some((i) => i.level === 'block') ? 0 : issues.some((i) => i.level === 'warn' && i.code.startsWith('missing')) ? 0.5 : 1;
  const parts = { product, customers, scale, growthProfitability: gp, dataSufficiency };
  const total = (Object.keys(parts) as CriterionKey[]).reduce((s, k) => s + parts[k] * SCORING.weights[k], 0);
  return { total: Math.round(total * 1000) / 1000, parts };
}

export const assess = (x: number) => (x >= 0.5 ? 'similar' : x >= 0.2 ? 'partial' : 'different') as 'similar' | 'partial' | 'different';
