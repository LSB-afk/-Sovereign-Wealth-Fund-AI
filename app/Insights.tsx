'use client';
import { useEffect, useMemo, useState } from 'react';
import { fmtPct } from '@/lib/financials.ts';
import { decisionLabel, relationLabel, tagLabel } from '@/lib/labels.ts';
import { BAND_LABEL, robustness } from '@/lib/robustness.ts';
import type { KGEdge, KnowledgeGraph } from '@/lib/graph.ts';
import type { Timeline } from '@/lib/timeline.ts';
import type { AnalysisResult, Mode } from '@/lib/types.ts';
import { Icon } from './ui';

// ---------------- 강건성 ----------------
export function RobustView({ r, peers }: { r: AnalysisResult; peers: string[] }) {
  const { rows, n } = useMemo(() => robustness(r.candidates, r.selected), [r]);
  const robustSel = rows.filter((x) => x.baseSelected && x.rate >= 0.8).map((x) => x.ticker);
  const fragile = rows.filter((x) => x.baseSelected && x.rate < 0.5).map((x) => x.ticker);
  const hidden = rows.filter((x) => !x.baseSelected && x.rate >= 0.5).map((x) => x.ticker);
  return (
    <>
      <div className="sheet">
        <h3>Peer 강건성 테스트 <span>가중치를 {n.toLocaleString()}가지로 무작위로 바꿔도 같은 기업이 뽑히는가</span></h3>
        <div className="kpis">
          <div><b>{robustSel.length}</b><span>강건한 선정<small>{robustSel.join(', ') || '-'}</small></span></div>
          <div><b>{fragile.length}</b><span>가중치에 민감한 선정<small>{fragile.join(', ') || '-'}</small></span></div>
          <div><b>{hidden.length}</b><span>제외됐지만 자주 뽑힘<small>{hidden.join(', ') || '-'}</small></span></div>
        </div>
        <table className="bars robust">
          <thead><tr><th></th><th>선정 빈도</th><th>판정</th><th>현재 결과</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.ticker}>
                <th>{x.ticker}</th>
                <td className="barcell"><div className="bar-track wide"><div className={`b-${x.band}`} style={{ width: `${Math.max(1, x.rate * 100)}%` }} /></div>{x.band === 'ineligible' ? '-' : `${(x.rate * 100).toFixed(0)}%`}</td>
                <td><span className={`band ${x.band}`}>{BAND_LABEL[x.band]}</span></td>
                <td>{peers.includes(x.ticker) ? <span className="dec selected">비교기업</span> : <span className="dec excluded">제외</span>}{x.baseSelected !== peers.includes(x.ticker) && <span className="muted"> (직접 조정)</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="foot">방법: 다섯 기준의 가중치를 균등 분포(디리클레)에서 {n.toLocaleString()}번 뽑고, 선정 기준선도 0.40~0.50 사이에서 함께 바꿔 같은 선정 규칙(상위 최대 5개)을 다시 적용했습니다. 시드를 고정해 매번 같은 결과가 나옵니다. 기준별 점수는 공시 자료에서 계산한 값 그대로 씁니다.{r.mode === 'real' && ' 실제 모드의 최종 판단은 Claude가 했으므로, 이 결과는 규칙 점수 기준의 참고 지표입니다.'}</p>
      </div>
    </>
  );
}

// ---------------- 시점 비교 (타임머신) ----------------
function yearsBack(asOf: string, k: number) {
  const [y, m, d] = asOf.split('-').map(Number);
  return `${y - k}-${String(m).padStart(2, '0')}-${String(Math.min(d, 28)).padStart(2, '0')}`;
}

export function TimelineView({ target, asOf, mode }: { target: string; asOf: string; mode: Mode }) {
  const [data, setData] = useState<Timeline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dates = useMemo(() => [3, 2, 1, 0].map((k) => yearsBack(asOf, k)), [asOf]);
  useEffect(() => {
    setData(null); setErr(null);
    fetch('/api/timeline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, dates, mode }) })
      .then(async (res) => { const j = await res.json(); if (!res.ok) throw new Error(j.error); setData(j); })
      .catch((e) => setErr(e.message));
  }, [target, mode, dates]);

  if (err) return <div className="sheet"><p className="warn">오류: {err}</p></div>;
  if (!data) return <div className="sheet"><p className="muted">기준일 {dates.length}개 시점에서 에이전트를 다시 실행하는 중…</p></div>;
  const tickers = Object.keys(data.points[0].cells);
  return (
    <>
      <div className="sheet">
        <h3>시점별 Peer 변화 · {target} <span>각 시점에는 그날까지 공시된 자료만 사용 (미래 정보 누수 없음)</span></h3>
        <div className="scroll">
          <table className="matrix">
            <thead>
              <tr><th></th>{data.points.map((p) => <th key={p.asOf}>{p.asOf}<small>대상 FY 종료 {p.target.periodEnd ?? '-'}</small></th>)}</tr>
            </thead>
            <tbody>
              <tr className="tgt">
                <th>{target} <small>성장률 · 이익률</small></th>
                {data.points.map((p) => <td key={p.asOf}>{fmtPct(p.target.growth)} · {fmtPct(p.target.margin)}</td>)}
              </tr>
              {tickers.map((t) => (
                <tr key={t}>
                  <th>{t}</th>
                  {data.points.map((p, i) => {
                    const c = p.cells[t];
                    const prev = i > 0 ? data.points[i - 1].cells[t] : null;
                    const sel = c.decision === 'selected';
                    const changed = prev && (prev.decision === 'selected') !== sel;
                    return (
                      <td key={p.asOf} title={`${c.decision ? decisionLabel[c.decision] : '미검토'} · 참고 점수 ${c.score ?? '-'} · FY 종료 ${c.periodEnd ?? '자료 없음'}`}>
                        <span className={`mk ${c.blocked ? 'blk' : sel ? 'sel' : c.decision === 'hold' ? 'hold' : 'out'} ${changed ? 'chg' : ''}`}>{c.blocked ? '×' : sel ? '●' : c.decision === 'hold' ? '△' : '○'}</span>
                        <small>{c.score ?? ''}</small>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="foot">● 선정 · ○ 제외 · △ 보류 · × 재무 비교 불가 · 주황 테두리 = 직전 시점 대비 변화. 숫자는 규칙 기반 참고 점수입니다.</p>
      </div>
      <div className="sheet">
        <h3>변화 요약</h3>
        {data.changes.length ? <ul className="notes">{data.changes.map((c) => <li key={c}>{c}</li>)}</ul> : <p>모든 시점에서 같은 Peer 구성이 유지됐습니다.</p>}
        <p className="foot">시점 비교는 {mode === 'demo' ? '저장된 EDGAR 스냅샷' : 'EDGAR 실시간 조회'}과 규칙 기반 정책으로 실행합니다(LLM 미사용). 스냅샷에는 기업별 최근 4개 연간보고서의 원문 발췌만 있어, 그보다 오래된 시점에서는 원문 근거가 빠질 수 있습니다.</p>
      </div>
    </>
  );
}

// ---------------- 지식그래프 ----------------
const W = 860, H = 560, CX = 430, CY = 280;

export function GraphView({ asOf, mode, focus }: { asOf: string; mode: Mode; focus: string }) {
  const [g, setG] = useState<KnowledgeGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(focus);
  const [layers, setLayers] = useState({ compete: true, supply: true, market: false });
  useEffect(() => {
    setG(null); setErr(null);
    fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asOf, mode }) })
      .then(async (res) => { const j = await res.json(); if (!res.ok) throw new Error(j.error); setG(j); })
      .catch((e) => setErr(e.message));
  }, [asOf, mode]);

  const pos = useMemo(() => {
    const p: Record<string, { x: number; y: number }> = {};
    if (!g) return p;
    const comp = g.nodes.filter((n) => n.type === 'company');
    comp.forEach((n, i) => { const a = (i / comp.length) * Math.PI * 2 - Math.PI / 2; p[n.id] = { x: CX + 300 * Math.cos(a), y: CY + 210 * Math.sin(a) }; });
    const ext = g.nodes.filter((n) => n.type === 'external');
    ext.forEach((n, i) => { const a = (i / Math.max(1, ext.length)) * Math.PI * 2 - Math.PI / 2 + 0.15; p[n.id] = { x: CX + 395 * Math.cos(a), y: CY + 262 * Math.sin(a) }; });
    const mk = g.nodes.filter((n) => n.type === 'market');
    mk.forEach((n, i) => { const a = (i / mk.length) * Math.PI * 2; p[n.id] = { x: CX + 140 * Math.cos(a), y: CY + 95 * Math.sin(a) }; });
    return p;
  }, [g]);

  if (err) return <div className="sheet"><p className="warn">오류: {err}</p></div>;
  if (!g) return <div className="sheet"><p className="muted">공시 원문에서 관계를 추출하는 중…</p></div>;

  const show = (e: KGEdge) => (e.relation === 'COMPETES_WITH' ? layers.compete : e.relation === 'SELLS_INTO' ? layers.market : e.relation === 'MAKES' ? false : layers.supply);
  const edges = g.edges.filter(show);
  const mutual = (e: KGEdge) => g.edges.some((x) => x.relation === e.relation && x.source === e.target && x.target === e.source);
  const out = g.edges.filter((e) => e.source === sel && e.relation !== 'SELLS_INTO' && e.relation !== 'MAKES');
  const inc = g.edges.filter((e) => e.target === sel && e.relation === 'COMPETES_WITH');
  const markets = g.edges.filter((e) => e.source === sel && e.relation === 'SELLS_INTO').map((e) => tagLabel[e.target.slice(2)] ?? e.target.slice(2));
  const products = g.edges.filter((e) => e.source === sel && e.relation === 'MAKES').map((e) => tagLabel[e.target.slice(2)] ?? e.target.slice(2));
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <div className="kg">
      <div className="sheet kg-canvas">
        <h3>공시 기반 지식그래프 <span>기준일 {g.asOf} · 추출 {g.extractor === 'llm' ? 'Claude(LLM) + 원문 대조 검증' : '규칙(데모, LLM 미사용)'}</span></h3>
        <div className="kg-bar">
          <span className="stat">연간보고서 <b>{g.stats.filingsRead}</b>건 읽음</span>
          <span className="stat">관계 <b>{g.stats.kept}</b>건 채택</span>
          <span className="stat">원문 대조 탈락 <b>{g.stats.rejected}</b>건</span>
          <span className="layers">
            <button className={layers.compete ? 'on c' : ''} onClick={() => setLayers({ ...layers, compete: !layers.compete })}>경쟁</button>
            <button className={layers.supply ? 'on s' : ''} onClick={() => setLayers({ ...layers, supply: !layers.supply })}>공급·고객·협력</button>
            <button className={layers.market ? 'on m' : ''} onClick={() => setLayers({ ...layers, market: !layers.market })}>판매 시장</button>
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="kg-svg">
          <defs>
            {['c', 's', 'h'].map((k) => (
              <marker key={k} id={`ar-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className={`ar-${k}`} /></marker>
            ))}
          </defs>
          {edges.map((e, i) => {
            const a = pos[e.source], b = pos[e.target];
            if (!a || !b) return null;
            const hot = e.source === sel || e.target === sel;
            const kind = e.relation === 'COMPETES_WITH' ? 'c' : e.relation === 'SELLS_INTO' ? 'm' : 's';
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
            const bend = mutual(e) ? 26 : 0;
            const mx = (a.x + b.x) / 2 - (dy / len) * bend, my = (a.y + b.y) / 2 + (dx / len) * bend;
            const r = e.relation === 'SELLS_INTO' ? 14 : 30;
            const ex = b.x - (dx / len) * r, ey = b.y - (dy / len) * r;
            return <path key={i} d={`M${a.x} ${a.y} Q${mx} ${my} ${ex} ${ey}`} className={`ke ${kind} ${sel ? (hot ? 'hot' : 'dim') : ''}`} markerEnd={kind === 'm' ? undefined : `url(#ar-${hot ? 'h' : kind})`} />;
          })}
          {g.nodes.filter((n) => n.type !== 'product' && (n.type !== 'market' || layers.market)).map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            const deg = g.edges.filter((e) => e.target === n.id && e.relation === 'COMPETES_WITH').length;
            if (n.type === 'market') return <g key={n.id} className="kn mk" transform={`translate(${p.x},${p.y})`}><rect x={-34} y={-10} width={68} height={20} rx={10} /><text y={4}>{tagLabel[n.label] ?? n.label}</text></g>;
            const rr = n.type === 'company' ? 24 + Math.min(deg, 6) * 1.5 : 16;
            return (
              <g key={n.id} className={`kn ${n.type} ${sel === n.id ? 'sel' : ''}`} transform={`translate(${p.x},${p.y})`} onClick={() => setSel(n.id)}>
                <circle r={rr} />
                <text y={n.type === 'company' ? 4 : rr + 12}>{n.label}</text>
                {n.type === 'company' && deg > 0 && <text className="deg" y={rr + 13}>지목 {deg}</text>}
              </g>
            );
          })}
        </svg>
        <p className="foot">화살표 A → B = A의 연간보고서가 B를 해당 관계로 기재. 원 크기 = 다른 기업 보고서에서 경쟁사로 지목된 횟수. 노드를 누르면 근거 원문이 오른쪽에 보입니다.</p>
      </div>

      <div className="sheet kg-side">
        <h3>{label(sel)} <span>{g.nodes.find((n) => n.id === sel)?.type === 'external' ? '외부 기업 (LLM 추출)' : ''}</span></h3>
        {products.length > 0 && <div className="tagrow">{products.map((p) => <span key={p} className="tg">{p}</span>)}</div>}
        {markets.length > 0 && <div className="tagrow">{markets.map((p) => <span key={p} className="tg m">{p}</span>)}</div>}
        {products.length + markets.length > 0 && <p className="foot" style={{ marginTop: 4 }}>제품·시장 태그는 연간보고서 Item 1 기반 큐레이션</p>}
        <h4>{label(sel)}이(가) 기재한 관계 · {out.length}</h4>
        {out.length === 0 && <p className="muted small">없음</p>}
        {out.map((e, i) => <Evidence key={i} e={e} other={label(e.target)} dir="→" onPick={setSel} />)}
        <h4>{label(sel)}을(를) 경쟁사로 기재한 기업 · {inc.length}</h4>
        {inc.length === 0 && <p className="muted small">없음</p>}
        {inc.map((e, i) => <Evidence key={i} e={e} other={label(e.source)} dir="←" onPick={setSel} />)}
        {g.notes.length > 0 && <><h4>수집 한계</h4><ul className="notes small">{g.notes.map((n) => <li key={n}>{n}</li>)}</ul></>}
      </div>
    </div>
  );
}

function Evidence({ e, other, dir, onPick }: { e: KGEdge; other: string; dir: string; onPick: (id: string) => void }) {
  const id = dir === '→' ? e.target : e.source;
  return (
    <div className="ev-item">
      <div className="ev-head">
        <button className="link" onClick={() => onPick(id)}>{dir} {other}</button>
        <span className={`rel ${e.relation === 'COMPETES_WITH' ? 'c' : 's'}`}>{relationLabel[e.relation]}</span>
        <span className="by">{e.extractor === 'llm' ? 'LLM 추출·검증' : e.extractor === 'rule' ? '규칙 추출' : '큐레이션'}</span>
      </div>
      {e.quote && <blockquote>“{e.quote}”</blockquote>}
      <a href={e.url} target="_blank" rel="noreferrer" className="small"><Icon name="doc" size={11} /> {e.evidenceTitle}</a>
    </div>
  );
}
