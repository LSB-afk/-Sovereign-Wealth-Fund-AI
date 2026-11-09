'use client';
import { fmtPct, fmtUsdB } from '@/lib/financials.ts';
import { SCORING } from '@/lib/peer.ts';
import { assessmentLabel, criterionLabel, decisionLabel } from '@/lib/labels.ts';
import { comparisonRows, type Row } from '@/lib/report.ts';
import type { AnalysisResult, CriterionKey, Source } from '@/lib/types.ts';
import { Src } from './ui';

const CRITERIA = Object.keys(criterionLabel) as CriterionKey[];

function Bar({ value, max, text, src, sources }: { value: number | null; max: number; text: string; src?: string | string[]; sources: Source[] }) {
  return (
    <td className="barcell">
      <div className="bar-track">{value != null && max > 0 && <div className={value < 0 ? 'neg' : ''} style={{ width: `${Math.max(2, (Math.abs(value) / max) * 100)}%` }} />}</div>
      <span className={value == null ? 'missing' : ''}>{text}</span> <Src ids={Array.isArray(src) ? src : [src]} sources={sources} />
    </td>
  );
}

export function CompareView({ r, peers }: { r: AnalysisResult; peers: string[] }) {
  const rows = comparisonRows(r, peers);
  const S = r.sources;
  const maxOf = (k: keyof Row) => Math.max(0, ...rows.map((x) => Math.abs((x[k] as number | null) ?? 0)));
  return (
    <>
      <div className="sheet">
        <h3>재무 비교 <span>최근 연간 · 연결 · USD · 기준일 {r.asOf} 이전 공시</span></h3>
        <table className="bars">
          <thead><tr><th></th><th>매출</th><th>매출 성장률</th><th>영업이익률</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.ticker} className={x.role === '대상' ? 'target' : x.role === '중앙값' ? 'median' : ''}>
                <th>{x.ticker}{x.role === '대상' && <small> 대상</small>}</th>
                <Bar value={x.revenue} max={maxOf('revenue')} text={fmtUsdB(x.revenue)} src={x.src.revenue} sources={S} />
                <Bar value={x.revenueGrowth} max={maxOf('revenueGrowth')} text={fmtPct(x.revenueGrowth)} src={x.derivedSrc?.revenueGrowth} sources={S} />
                <Bar value={x.operatingMargin} max={maxOf('operatingMargin')} text={fmtPct(x.operatingMargin)} src={x.derivedSrc?.operatingMargin} sources={S} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sheet">
        <h3>원값 · 회계기간</h3>
        <table className="grid num">
          <thead><tr><th>기업</th><th>회계기간</th><th>매출</th><th>영업이익</th><th>R&D 비중</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.ticker}>
                <td><b>{x.ticker}</b></td><td>{x.period}</td>
                <td>{fmtUsdB(x.revenue)} <Src ids={[x.src.revenue]} sources={S} /></td>
                <td>{fmtUsdB(x.operatingIncome)} <Src ids={[x.src.operatingIncome]} sources={S} /></td>
                <td>{fmtPct(x.rndRatio)} <Src ids={x.derivedSrc?.rndRatio} sources={S} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="foot">비율은 공시 원값으로 코드에서 계산합니다. 같은 기간 값이 여러 공시에 있으면 기준일 이전 가장 최근 공시 값(수정 공시 우선)을 씁니다. 누락 값은 추정하지 않습니다.</p>
      </div>
    </>
  );
}

export function ReasonsView({ r, peers }: { r: AnalysisResult; peers: string[] }) {
  const S = r.sources;
  const byT = (t: string) => r.candidates.find((c) => c.ticker === t)!;
  return (
    <>
      <div className="sheet">
        <h3>요약</h3>
        <p>{r.summary}</p>
      </div>
      <div className="sheet">
        <h3>후보별 판단표 <span>선정 제안: {r.mode === 'demo' ? '규칙 정책(데모)' : 'Claude'} · 수치·설명·기준 판정: 코드 구성</span></h3>
        <div className="scroll">
          <table className="grid">
            <thead><tr><th>후보</th><th>판단</th><th>이유</th>{CRITERIA.map((k) => <th key={k}>{criterionLabel[k]}</th>)}<th>참고 점수</th></tr></thead>
            <tbody>
              {r.candidates.map((c) => (
                <tr key={c.ticker}>
                  <td><b>{c.ticker}</b></td>
                  <td><span className={`dec ${c.review?.decision ?? 'none'}`}>{c.review ? decisionLabel[c.review.decision] : '미검토'}</span></td>
                  <td>{c.review?.reason ?? '-'} <Src ids={c.review?.sourceIds} sources={S} />{c.review?.warnings.map((w, i) => <div key={i} className="warn">⚠ {w}</div>)}</td>
                  {CRITERIA.map((k) => {
                    const j = c.review?.criteria[k];
                    return <td key={k}>{j ? <><span className={`as ${j.assessment}`}>{assessmentLabel[j.assessment]}</span> {j.note} <Src ids={j.sourceIds} sources={S} /></> : '-'}</td>;
                  })}
                  <td>{c.ruleScore?.total ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="foot">참고 점수는 공개된 초기 설정 가중치에 따른 값으로, 객관적 정답이나 확률이 아닙니다.</p>
        <ul className="foot">{SCORING.description.map((d) => <li key={d}>{d}</li>)}</ul>
      </div>
      <div className="sheet">
        <h3>사업구조 비교 <span>연간보고서 Item 1 기반 큐레이션 요약 · 세그먼트별 매출 수치는 미수집</span></h3>
        <table className="grid">
          <thead><tr><th>기업</th><th>사업모델</th><th>주요 제품</th><th>최종시장</th><th>근거</th></tr></thead>
          <tbody>
            {[r.target_record, ...peers.map(byT)].map((c) => (
              <tr key={c.ticker}>
                <td><b>{c.ticker}</b></td>
                <td>{c.profile?.businessModel ?? '-'}</td>
                <td>{c.profile?.products.join(', ') ?? '-'}</td>
                <td>{c.profile?.endMarkets.join(', ') ?? '-'}</td>
                <td><Src ids={S.filter((s) => s.ticker === c.ticker && (s.kind === 'profile' || s.kind === 'filing_excerpt')).map((s) => s.id)} sources={S} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SourcesView({ r, flash }: { r: AnalysisResult; flash: string | null }) {
  return (
    <div className="sheet">
      <h3>출처 <span>{r.sources.length}건 · 실제로 수집한 자료만 연결</span></h3>
      <ol className="sources">
        {r.sources.map((s) => (
          <li key={s.id} id={`src-${s.id}`} className={flash === s.id ? 'flash' : ''}>
            <b>{s.id}</b> <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> <span className="muted">수집 {s.accessedAt.slice(0, 19).replace('T', ' ')}</span>
            {s.quote && <details open={flash === s.id}><summary>수집한 원문 발췌</summary>{s.quote.map((q, i) => <blockquote key={i}>{q}</blockquote>)}</details>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function notesOf(r: AnalysisResult): string[] {
  return [
    ...[r.target_record, ...r.candidates].flatMap((c) => [...(c.issues ?? []).filter((i) => i.level !== 'info').map((i) => `${c.ticker}: ${i.message}`), ...(c.financials?.notes ?? []).map((n) => `${c.ticker}: ${n}`)]),
    ...r.warnings,
  ];
}

export function NotesView({ r }: { r: AnalysisResult }) {
  return (
    <div className="sheet">
      <h3>비교 시 유의사항</h3>
      <ul className="notes">
        {notesOf(r).map((m, i) => <li key={i}>{m}</li>)}
        <li>회계연도 종료월이 다른 기업은 같은 달력 기간의 실적이 아닙니다.</li>
        <li>기업 프로필(제품·시장)은 정성 요약이며, 세그먼트별 매출 수치는 수집하지 않았습니다.</li>
      </ul>
    </div>
  );
}

export function LogView({ r }: { r: AnalysisResult }) {
  return (
    <div className="sheet">
      <h3>실행 로그 <span>{r.modeLabel} · 한도: 도구 {r.limits.maxToolCalls}회, 재시도 {r.limits.maxRetries}회, {r.limits.timeoutMs / 1000}초</span></h3>
      <table className="log">
        <tbody>
          {r.toolLog.map((l, i) => (
            <tr key={i} className={l.ok ? '' : 'fail'}>
              <td>{i + 1}</td><td><code>{l.tool}</code></td><td>{[l.args.ticker ?? l.args.target, l.args.topic].filter(Boolean).join(' · ')}</td><td>{l.summary}</td><td>{l.attempts > 1 ? `재시도 ${l.attempts - 1}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
