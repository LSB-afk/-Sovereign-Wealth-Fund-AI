// Comparison table, Markdown report and CSV. Pure and client-safe: recomputed whenever the user edits the peer set.
import { fmtPct, fmtUsdB, median } from './financials.ts';
import { SCORING } from './peer.ts';
import { assessmentLabel, criterionLabel, decisionLabel, relationshipLabel } from './labels.ts';
import type { AnalysisResult, CandidateRecord, CriterionKey, MetricKey } from './types.ts';

export interface PeerChange { ticker: string; action: 'add' | 'remove'; at: string }

export interface Row {
  ticker: string;
  role: '대상' | 'Peer' | '중앙값';
  period: string;
  revenue: number | null;
  revenueGrowth: number | null;
  operatingIncome: number | null;
  operatingMargin: number | null;
  rndRatio: number | null;
  src: Partial<Record<MetricKey, string>>; // sourceId per metric
}

function row(c: CandidateRecord, role: Row['role']): Row {
  const f = c.financials, v = f?.latest?.values ?? {};
  return {
    ticker: c.ticker, role,
    period: f?.latest ? `${f.latest.periodStart}~${f.latest.periodEnd}` : '누락',
    revenue: v.revenue?.value ?? null, revenueGrowth: f?.revenueGrowth ?? null,
    operatingIncome: v.operatingIncome?.value ?? null, operatingMargin: f?.operatingMargin ?? null, rndRatio: f?.rndRatio ?? null,
    src: { revenue: v.revenue?.sourceId, operatingIncome: v.operatingIncome?.sourceId, rnd: v.rnd?.sourceId },
  };
}

export function comparisonRows(r: AnalysisResult, peers: string[]): Row[] {
  const peerRows = peers.map((t) => r.candidates.find((c) => c.ticker === t)).filter(Boolean).map((c) => row(c!, 'Peer'));
  const med = (k: keyof Row) => median(peerRows.map((x) => x[k] as number | null));
  return [
    row(r.target_record, '대상'),
    ...peerRows,
    { ticker: 'Peer 중앙값', role: '중앙값', period: '-', revenue: med('revenue'), revenueGrowth: med('revenueGrowth'), operatingIncome: med('operatingIncome'), operatingMargin: med('operatingMargin'), rndRatio: med('rndRatio'), src: {} },
  ];
}

const src = (id?: string) => (id ? ` [${id}]` : '');
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(r: AnalysisResult, peers: string[], changes: PeerChange[]): string {
  const L: string[] = [];
  const rows = comparisonRows(r, peers);
  L.push(`# Peer Group 분석 보고서 — ${r.target}`, '');
  L.push(`- 실행 모드: **${r.modeLabel}**`, `- 분석 기준일: ${r.asOf} (이후 공시 제외)`, `- 실행: ${r.startedAt} ~ ${r.finishedAt}`, `- 상태: ${r.status}${r.stopReason ? ` — ${r.stopReason}` : ''}`, `- 데이터: ${r.dataNote}`, '');
  L.push('## 요약', '', r.summary || '-', '');
  if (changes.length) {
    L.push('## 사용자 변경 사항 (에이전트 제안과 다름)', '', `에이전트 제안: ${r.selected.join(', ') || '없음'}`, '');
    for (const c of changes) L.push(`- ${c.at}: ${c.ticker} ${c.action === 'add' ? '추가' : '제외'}`);
    L.push('');
  }
  L.push(`## 최종 Peer (${peers.length}개)`, '');
  L.push('| 티커 | 에이전트 판단 | 관계 | 참고 점수 | 근거 |', '|---|---|---|---|---|');
  for (const t of peers) {
    const c = r.candidates.find((x) => x.ticker === t)!;
    L.push(`| ${t} | ${c.review ? decisionLabel[c.review.decision] : '미검토'} | ${c.review ? relationshipLabel[c.review.relationship] : '-'} | ${c.ruleScore?.total ?? '-'} | ${esc(c.review?.reason ?? '-')}${src(c.review?.sourceIds.join(', '))} |`);
  }
  L.push('', '## 후보별 판단표', '');
  const keys = Object.keys(criterionLabel) as CriterionKey[];
  L.push(`| 티커 | 판단 | ${keys.map((k) => criterionLabel[k]).join(' | ')} |`, `|---|---|${keys.map(() => '---').join('|')}|`);
  for (const c of r.candidates) {
    const cells = keys.map((k) => {
      const j = c.review?.criteria[k];
      return j ? esc(`${assessmentLabel[j.assessment]}: ${j.note}${src(j.sourceIds.join(', '))}`) : '-';
    });
    L.push(`| ${c.ticker} | ${c.review ? decisionLabel[c.review.decision] : '미검토'} | ${cells.join(' | ')} |`);
  }
  L.push('', '## 제외·보류 후보와 이유', '');
  for (const c of r.candidates.filter((c) => !peers.includes(c.ticker))) L.push(`- **${c.ticker}** (${c.review ? decisionLabel[c.review.decision] : '미검토'}): ${c.review?.reason ?? '검토되지 않음'}`);
  L.push('', '## 재무지표 비교 (최근 연간, 연결, USD)', '');
  L.push('| 티커 | 구분 | 회계기간 | 매출 | 매출 성장률 | 영업이익 | 영업이익률 | R&D 비중 |', '|---|---|---|---|---|---|---|---|');
  for (const x of rows) L.push(`| ${x.ticker} | ${x.role} | ${x.period} | ${fmtUsdB(x.revenue)}${src(x.src.revenue)} | ${fmtPct(x.revenueGrowth)} | ${fmtUsdB(x.operatingIncome)}${src(x.src.operatingIncome)} | ${fmtPct(x.operatingMargin)} | ${fmtPct(x.rndRatio)}${src(x.src.rnd)} |`);
  L.push('', '성장률·이익률·R&D 비중은 공시 원값으로 코드에서 계산. 성장률 = (당기 매출 − 전기 매출) / 전기 매출. 누락 값은 추정하지 않음.', '');
  L.push('## 데이터 누락 및 비교 시 유의사항', '');
  for (const c of [r.target_record, ...r.candidates]) {
    const items = [...(c.issues ?? []).filter((i) => i.level !== 'info').map((i) => i.message), ...(c.financials?.notes ?? [])];
    if (items.length) L.push(`- **${c.ticker}**: ${items.join('; ')}`);
  }
  for (const w of r.warnings) L.push(`- ${w}`);
  L.push('- 프로필(제품·시장 태그)은 연간보고서 Item 1 기반 큐레이션 요약이며, 세그먼트별 매출 수치는 수집하지 않음(원문 발췌 참조).');
  L.push('- 회계연도 종료월이 다른 기업은 같은 달력 기간이 아님.', '');
  L.push('## 참고 점수 산정 기준 (초기 설정 — 정답·확률 아님)', '');
  for (const d of SCORING.description) L.push(`- ${d}`);
  L.push('', '## 출처', '');
  for (const s of r.sources) L.push(`- [${s.id}] ${s.title} — ${s.url} (수집 ${s.accessedAt})`);
  L.push('', '## 실행 로그 요약', '');
  L.push(`도구 호출 ${r.toolLog.length}회 / 한도 ${r.limits.maxToolCalls}회, 실패 ${r.toolLog.filter((e) => !e.ok).length}건.`);
  return L.join('\n');
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One line per raw value with full provenance + derived ratios per company.
export function toCsv(r: AnalysisResult, peers: string[]): string {
  const head = ['ticker', 'role', 'metric', 'value', 'unit', 'definition', 'xbrl_concept', 'period_start', 'period_end', 'form', 'filed', 'accession', 'source_id', 'source_url', 'collected_at'];
  const out = [head.join(',')];
  const companies = [{ c: r.target_record, role: 'target' }, ...peers.map((t) => ({ c: r.candidates.find((x) => x.ticker === t)!, role: 'peer' }))];
  for (const { c, role } of companies) {
    const f = c.financials;
    for (const pv of [f?.latest, f?.prior]) for (const v of Object.values(pv?.values ?? {})) {
      out.push([c.ticker, role, v!.metric, v!.value, v!.unit, v!.definition, v!.concept, v!.periodStart, v!.periodEnd, v!.form, v!.filed, v!.accn, v!.sourceId, v!.url, v!.collectedAt].map(csvCell).join(','));
    }
    const rev = f?.latest?.values.revenue;
    for (const [metric, val] of [['revenue_growth_yoy', f?.revenueGrowth], ['operating_margin', f?.operatingMargin], ['rnd_to_revenue', f?.rndRatio]] as const) {
      out.push([c.ticker, role, metric, val ?? 'MISSING', 'ratio', '코드 계산', '', rev?.periodStart, rev?.periodEnd, '', '', '', '', '', ''].map(csvCell).join(','));
    }
  }
  return out.join('\n');
}
