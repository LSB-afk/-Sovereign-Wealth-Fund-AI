'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { robustness } from '@/lib/robustness.ts';
import { decisionLabel } from '@/lib/labels.ts';
import { toCsv, toMarkdown, type PeerChange } from '@/lib/report.ts';
import type { AgentEvent, AnalysisResult, Mode, Stage } from '@/lib/types.ts';
import Canvas, { STAGES } from './Canvas';
import { CompareView, LogView, NotesView, ReasonsView, SourcesView, notesOf } from './Views';
import { GraphView, RobustView, TimelineView } from './Insights';
import { GoSource, Icon, Src, download } from './ui';

type View = 'map' | 'compare' | 'reasons' | 'robust' | 'timeline' | 'graph' | 'sources' | 'notes' | 'log';
const TABS: { key: View; label: string; icon: string }[] = [
  { key: 'map', label: '지도', icon: 'map' },
  { key: 'compare', label: '비교표', icon: 'table' },
  { key: 'reasons', label: '근거', icon: 'check' },
  { key: 'robust', label: '강건성', icon: 'target' },
  { key: 'timeline', label: '시점 비교', icon: 'clock' },
  { key: 'graph', label: '지식그래프', icon: 'graph' },
  { key: 'sources', label: '출처', icon: 'doc' },
];

const NEEDS_RESULT = new Set<View>(['compare', 'reasons', 'robust', 'sources']);

interface Props { realAvailable: boolean; snapshotDate: string; targets: string[]; names: Record<string, string>; shorts: Record<string, string> }

export default function App({ realAvailable, snapshotDate, targets, names, shorts }: Props) {
  const [target, setTarget] = useState(targets[0]);
  const [asOf, setAsOf] = useState(snapshotDate);
  const [mode, setMode] = useState<Mode>('demo');
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<Partial<Record<Stage, 'active' | 'done'>>>({});
  const [toolCount, setToolCount] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [changes, setChanges] = useState<PeerChange[]>([]);
  const [view, setView] = useState<View>('map');
  const [panel, setPanel] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: PeerChange } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (view === 'sources' && flash) document.getElementById(`src-${flash}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [view, flash]);

  function showToast(t: { text: string; undo?: PeerChange }) {
    clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }

  async function start() {
    setRunning(true); setStages({}); setToolCount(0); setNotices([]); setError(null); setResult(null); setChanges([]); setView('map'); setSelected(null);
    try {
      const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, asOf, mode }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop()!;
        for (const line of lines) if (line.trim()) handle(JSON.parse(line) as AgentEvent);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function handle(e: AgentEvent) {
    if (e.type === 'stage') setStages((s) => ({ ...s, [e.stage]: s[e.stage] === 'done' ? 'done' : e.status }));
    else if (e.type === 'tool') setToolCount((n) => n + 1);
    else if (e.type === 'warning') setNotices((n) => [...n, e.message]);
    else if (e.type === 'error') setError(e.message);
    else if (e.type === 'result') { setResult(e.result); setPeers(e.result.selected); setSelected(e.result.target); }
  }

  function togglePeer(t: string, silent = false) {
    const add = !peers.includes(t);
    const change: PeerChange = { ticker: t, action: add ? 'add' : 'remove', at: new Date().toLocaleString('ko-KR') };
    setPeers((p) => (add ? [...p, t] : p.filter((x) => x !== t)));
    setChanges((c) => [...c, change]);
    if (!silent) showToast({ text: `'${t}'를 비교기업${add ? '에 추가했어요' : '에서 뺐어요'}.`, undo: change });
  }

  function resetPeers() {
    if (!result) return;
    const at = new Date().toLocaleString('ko-KR');
    setChanges((c) => [
      ...c,
      ...result.selected.filter((t) => !peers.includes(t)).map((t) => ({ ticker: t, action: 'add' as const, at })),
      ...peers.filter((t) => !result.selected.includes(t)).map((t) => ({ ticker: t, action: 'remove' as const, at })),
    ]);
    setPeers(result.selected);
    showToast({ text: '에이전트 제안으로 되돌렸어요.' });
  }

  const goSource = (id: string) => { setFlash(id); setView('sources'); };
  const edited = !!result && (peers.length !== result.selected.length || peers.some((t) => !result.selected.includes(t)));
  const order = result ? [result.target, ...peers, ...result.candidates.map((c) => c.ticker).filter((t) => !peers.includes(t))] : [target];
  const idx = selected ? order.indexOf(selected) : -1;
  const sel = result && selected ? (selected === result.target ? result.target_record : result.candidates.find((c) => c.ticker === selected)) : null;
  const current = STAGES.find((s) => stages[s.key] === 'active')?.label;
  const noteCount = result ? notesOf(result).length : 0;
  const stamp = result ? `${result.target}_${result.asOf}_${result.mode}` : '';
  const shownMode = result?.mode ?? mode;
  const robust = useMemo(() => (result ? Object.fromEntries(robustness(result.candidates, result.selected).rows.map((x) => [x.ticker, x.rate])) : {}), [result]);

  return (
    <GoSource.Provider value={goSource}>
      <div className="app">
        <nav className="rail">
          <span className="logo"><Icon name="logo" size={18} /></span>
          <button className={panel ? 'on' : ''} onClick={() => setPanel(!panel)} title="분석 설정"><Icon name="box" /></button>
          {TABS.map((t) => <button key={t.key} className={view === t.key ? 'on' : ''} onClick={() => setView(t.key)} title={t.label} disabled={!result && NEEDS_RESULT.has(t.key)}><Icon name={t.icon} /></button>)}
          <button className={view === 'notes' ? 'on' : ''} onClick={() => setView('notes')} title={`유의사항 ${noteCount}`} disabled={!result}><Icon name="shield" />{noteCount > 0 && <i className="dot" />}</button>
          <button className={view === 'log' ? 'on' : ''} onClick={() => setView('log')} title="실행 로그" disabled={!result}><Icon name="list" /></button>
          <span className="rail-foot" title="분석 기준일">{asOf.slice(5).replace('-', '.')}</span>
        </nav>

        {panel && (
          <aside className="panel">
            <header><Icon name="box" /><b>분석 설정</b><button className="icon" onClick={() => setPanel(false)} aria-label="패널 닫기"><Icon name="x" size={14} /></button></header>
            <div className="sec"><span>분석 대상</span><em>{targets.length}</em></div>
            <div className="cardlist">
              {targets.map((t) => (
                <button key={t} className={`row ${target === t ? 'on' : ''}`} onClick={() => setTarget(t)} disabled={running}>
                  <span className="ri"><Icon name="chip" size={14} /></span>
                  <span className="rt"><b>{t}</b><small>{names[t]}</small></span>
                  <span className="rr">{target === t ? '선택됨' : ''}</span>
                </button>
              ))}
            </div>
            <div className="sec"><span>분석 기준일</span></div>
            <label className="row date">
              <span className="ri"><Icon name="calendar" size={14} /></span>
              <input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} disabled={running} />
            </label>
            <p className="tiny">이 날짜 이후 공시는 사용하지 않아요.{mode === 'demo' && asOf > snapshotDate && ` 데모 스냅샷(${snapshotDate}) 이후 공시도 없어요.`}</p>
            <div className="sec"><span>실행 모드</span><em>2</em></div>
            <div className="cardlist">
              <button className={`row ${mode === 'demo' ? 'on' : ''}`} onClick={() => setMode('demo')} disabled={running}>
                <span className="ri"><Icon name="db" size={14} /></span>
                <span className="rt"><b>데모</b><small>스냅샷 {snapshotDate} · LLM 미사용</small></span>
                <span className="rr">{mode === 'demo' ? '선택됨' : ''}</span>
              </button>
              <button className={`row ${mode === 'real' ? 'on' : ''}`} onClick={() => setMode('real')} disabled={running || !realAvailable}>
                <span className="ri"><Icon name="bolt" size={14} /></span>
                <span className="rt"><b>실제</b><small>EDGAR 실시간 · Claude</small></span>
                <span className="rr">{!realAvailable ? '키 필요' : mode === 'real' ? '선택됨' : ''}</span>
              </button>
            </div>
            <button className="primary" onClick={start} disabled={running || !asOf}>{running ? '분석 중…' : '분석 시작'}</button>
            <div className="sec"><span>연결한 데이터</span><em>2</em></div>
            <div className="cardlist">
              <div className="row static"><span className="ri"><Icon name="doc" size={14} /></span><span className="rt"><b>SEC EDGAR</b><small>공시·XBRL 재무</small></span><span className="rr link">{mode === 'demo' ? '스냅샷' : '연결됨'}</span></div>
              <div className="row static"><span className="ri spark"><Icon name="spark" size={14} /></span><span className="rt"><b>Claude</b><small>판단 에이전트</small></span><span className={`rr ${realAvailable ? 'link' : ''}`}>{realAvailable ? '연결됨' : '키 없음'}</span></div>
            </div>
          </aside>
        )}

        <section className="main">
          <header className="top">
            <span className="live" />
            <b className="title">{result?.target ?? target} Peer 분석</b>
            <span className={`pill ${shownMode}`}>{shownMode === 'demo' ? '데모' : '실제'}</span>
            <div className="tabs">
              {TABS.map((t) => <button key={t.key} className={view === t.key ? 'on' : ''} onClick={() => setView(t.key)} disabled={!result && NEEDS_RESULT.has(t.key)}><Icon name={t.icon} size={13} />{t.label}</button>)}
            </div>
            <div className="right">
              {view === 'map' && (
                <span className="zoom">
                  <button onClick={() => setZoom((z) => Math.min(1.4, +(z + 0.1).toFixed(1)))} aria-label="확대"><Icon name="plus" size={13} /></button>
                  <button onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(1)))} aria-label="축소"><Icon name="minus" size={13} /></button>
                  <button onClick={() => setZoom(1)} aria-label="원래 크기"><Icon name="fit" size={13} /></button>
                </span>
              )}
              <button className="btn" disabled={!result} onClick={() => result && download(`peer_report_${stamp}.md`, toMarkdown(result, peers, changes), 'text/markdown')}><Icon name="down" size={13} />보고서</button>
              <button className="btn" disabled={!result} onClick={() => result && download(`peer_financials_${stamp}.csv`, '\uFEFF' + toCsv(result, peers), 'text/csv')}><Icon name="down" size={13} />CSV</button>
            </div>
          </header>

          <div className="subbar">
            <span className="agent">
              <span className="sp"><Icon name="spark" size={13} /></span>
              {running ? <>{current ?? '준비 중'}…</> : result ? <>에이전트 · 후보 {result.candidates.length}곳 검토</> : <>에이전트 대기 중</>}
              <em>도구 {result ? result.toolLog.length : toolCount}</em>
            </span>
            {result && result.status !== 'complete' && <span className="agent bad">{result.status === 'partial' ? '부분 결과' : '실패'} · {result.stopReason}</span>}
            {result && view === 'map' && (
              <span className="arr">
                <span className={!edited ? 'on' : ''}>에이전트 제안</span>
                <button className={edited ? 'on' : ''} onClick={resetPeers} disabled={!edited}>{edited ? '원래 제안으로' : '직접 조정'}</button>
              </span>
            )}
          </div>

          <div className="stage-area">
            {error && <div className="banner err">오류: {error}{mode === 'real' && ' · 데모 결과로 대체하지 않았어요.'}</div>}
            {notices.map((n, i) => <div key={i} className="banner warn">{n}</div>)}

            {view === 'map' && <Canvas robust={robust} r={result} target={result?.target ?? target} shorts={shorts} stages={stages} peers={peers} selected={selected} onSelect={setSelected} onToggle={(t) => togglePeer(t)} zoom={zoom} />}
            {(view === 'timeline' || view === 'graph') && (
              <div className="sheets">
                {view === 'timeline' && <TimelineView target={result?.target ?? target} asOf={result?.asOf ?? asOf} mode={result?.mode ?? mode} />}
                {view === 'graph' && <GraphView asOf={result?.asOf ?? asOf} mode={result?.mode ?? mode} focus={result?.target ?? target} />}
              </div>
            )}
            {result && view !== 'map' && view !== 'timeline' && view !== 'graph' && (
              <div className="sheets">
                {view === 'compare' && <CompareView r={result} peers={peers} />}
                {view === 'reasons' && <ReasonsView r={result} peers={peers} />}
                {view === 'robust' && <RobustView r={result} peers={peers} />}
                {view === 'sources' && <SourcesView r={result} flash={flash} />}
                {view === 'notes' && <NotesView r={result} />}
                {view === 'log' && <LogView r={result} />}
              </div>
            )}

            {toast && (
              <div className="toast">
                {toast.text}
                {toast.undo && <button onClick={() => { togglePeer(toast.undo!.ticker, true); setToast(null); }}><Icon name="undo" size={12} />되돌리기</button>}
              </div>
            )}
          </div>

          <footer className="bottom">
            {sel && result ? (
              <>
                <span className="live" />
                <span className="crumb">{sel.ticker === result.target ? '분석 대상' : '선택'} · <b>{sel.ticker}</b></span>
                <span className={`badge ${sel.ticker === result.target ? 'target' : peers.includes(sel.ticker) ? 'in' : 'out'}`}>
                  {sel.ticker === result.target ? '대상' : peers.includes(sel.ticker) ? '비교기업' : sel.review ? decisionLabel[sel.review.decision] : '미검토'}
                </span>
                <span className="reason" title={sel.ticker === result.target ? result.summary : sel.review?.reason}>
                  {sel.ticker === result.target ? result.summary : sel.review?.reason ?? '에이전트 검토 없음'}
                </span>
                {sel.ticker !== result.target && <Src ids={sel.review?.sourceIds} sources={result.sources} />}
                {sel.ticker !== result.target && !sel.issues?.some((i) => i.level === 'block') && (
                  <button className="btn" onClick={() => togglePeer(sel.ticker)}>{peers.includes(sel.ticker) ? '비교에서 빼기' : '비교에 추가'}</button>
                )}
                <span className="nav">
                  <button onClick={() => setSelected(order[(idx - 1 + order.length) % order.length])} aria-label="이전"><Icon name="left" size={13} /></button>
                  {idx + 1}/{order.length}
                  <button onClick={() => setSelected(order[(idx + 1) % order.length])} aria-label="다음"><Icon name="right" size={13} /></button>
                </span>
              </>
            ) : (
              <>
                <span className={`live ${running ? 'pulse' : ''}`} />
                <span className="crumb">{running ? <>지금 단계 · <b>{current ?? '준비 중'}</b></> : result ? '노드를 누르면 선정·제외 이유가 여기에 보여요' : <>분석 대상 · <b>{target}</b> · 기준일 {asOf}</>}</span>
                {result && <span className="nav"><button className="btn" onClick={() => setSelected(order[0])}>처음부터 보기<Icon name="right" size={13} /></button></span>}
              </>
            )}
          </footer>
        </section>
      </div>
    </GoSource.Provider>
  );
}
