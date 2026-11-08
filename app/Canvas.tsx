'use client';
import { fmtPct, fmtUsdB } from '@/lib/financials.ts';
import { relationshipLabel } from '@/lib/labels.ts';
import type { AnalysisResult, CandidateRecord, Stage } from '@/lib/types.ts';
import { Icon } from './ui';

export const STAGES: { key: Stage; label: string; sub: string; icon: string }[] = [
  { key: 'collect', label: '자료 수집', sub: '공시·프로필·원문 발췌', icon: 'search' },
  { key: 'metrics', label: '지표 확인', sub: '재무지표·비교 가능성', icon: 'chart' },
  { key: 'review', label: '후보 검토', sub: '선정·제외 판단 저장', icon: 'check' },
  { key: 'report', label: '보고서 생성', sub: '비교표·출처 정리', icon: 'doc' },
];

const NW = 212, NH = 56;

interface NodeProps {
  x: number; y: number; icon: string; title: string; sub: string;
  tag?: { text: string; tone?: 'orange' | 'gray' | 'red' };
  chips?: { title: string; sub: string; bad?: boolean }[];
  state?: 'dark' | 'active' | 'done' | 'muted';
  selected?: boolean; onClick?: () => void;
  action?: { label: string; icon: string; onClick: () => void };
  badge?: number;
}

function Node({ x, y, icon, title, sub, tag, chips, state, selected, onClick, action, badge }: NodeProps) {
  return (
    <div className={`node ${state ?? ''} ${selected ? 'sel' : ''} ${onClick ? 'click' : ''}`} style={{ left: x, top: y, width: NW }} onClick={(e) => { e.stopPropagation(); onClick?.(); }}>
      {tag && <span className={`ntag ${tag.tone ?? 'orange'}`}>{tag.text}</span>}
      <div className="ncard">
        <span className="nicon"><Icon name={icon} size={15} /></span>
        <span className="ntext"><b>{title}{badge != null && <i className={`rb ${badge >= 0.8 ? 'hi' : badge >= 0.5 ? 'mid' : 'lo'}`} title="가중치 강건성: 무작위 가중치 2,000회 중 선정 비율">{Math.round(badge * 100)}%</i>}</b><small>{sub}</small></span>
        {action && <button className="nact" title={action.label} aria-label={action.label} onClick={(e) => { e.stopPropagation(); action.onClick(); }}><Icon name={action.icon} size={12} /></button>}
      </div>
      {chips && (
        <div className="nchips">
          {chips.map((c, i) => <span key={i} className={c.bad ? 'bad' : ''}><b>{c.title}</b><small>{c.sub}</small></span>)}
        </div>
      )}
    </div>
  );
}

function Group({ x, y, w, h, label }: { x: number; y: number; w: number; h: number; label: string }) {
  return <div className="group" style={{ left: x, top: y, width: w, height: h }}><span>{label}</span></div>;
}

const chipsOf = (c: CandidateRecord) => {
  const f = c.financials;
  if (!f?.latest) return [{ title: '누락', sub: '재무자료', bad: true }];
  return [
    { title: fmtUsdB(f.latest.values.revenue?.value), sub: '매출' },
    { title: f.revenueGrowth == null ? '누락' : `${f.revenueGrowth > 0 ? '+' : ''}${fmtPct(f.revenueGrowth)}`, sub: '성장률', bad: f.revenueGrowth == null },
    { title: fmtPct(f.operatingMargin), sub: '이익률', bad: f.operatingMargin == null },
  ];
};

interface Props {
  r: AnalysisResult | null;
  target: string;
  shorts: Record<string, string>;
  stages: Partial<Record<Stage, 'active' | 'done'>>;
  peers: string[];
  selected: string | null;
  onSelect: (t: string | null) => void;
  onToggle: (t: string) => void;
  zoom: number;
  robust: Record<string, number>;
}

export default function Canvas({ robust, r, target, shorts, stages, peers, selected, onSelect, onToggle, zoom }: Props) {
  // Fixed layout (canvas px). ponytail: hand-placed grid, fine for ≤10 candidates.
  const stageY = 46;
  const stageGroup = { x: 20, y: 18, w: 40 + STAGES.length * NW + (STAGES.length - 1) * 40, h: 104 };
  const r1 = 150;
  const peerRows = Math.max(1, Math.ceil(peers.length / 2));
  const rowH = 124;
  const g2 = { x: 316, y: r1, w: 40 + NW * 2 + 32, h: 46 + peerRows * rowH };
  const g1 = { x: 20, y: r1, w: NW + 40, h: g2.h };
  const ty = r1 + 46 + (peerRows * rowH - 30) / 2 - NH / 2;
  const peerPos = peers.map((_, i) => ({ x: g2.x + 20 + (i % 2) * (NW + 32), y: r1 + 46 + Math.floor(i / 2) * rowH }));
  const others = r ? r.candidates.filter((c) => !peers.includes(c.ticker)) : [];
  const r2 = r1 + g2.h + 30;
  const cols = 4;
  const g3 = { x: 20, y: r2, w: 40 + cols * NW + (cols - 1) * 22, h: 46 + Math.max(1, Math.ceil(others.length / cols)) * 92 };
  const width = Math.max(stageGroup.x + stageGroup.w, g2.x + g2.w, g3.x + g3.w) + 40;
  const height = (r ? g3.y + g3.h : r1 + g2.h) + 60;

  const tx = 40 + NW, tyMid = ty + NH / 2, trunk = g2.x - 8;
  const edge = (i: number) => {
    const p = peerPos[i];
    if (i % 2 === 0) return `M${tx} ${tyMid} H${trunk} V${p.y + NH / 2} H${p.x}`;
    // second column: enter from the top through the gap between rows
    const lane = p.y - 22;
    return `M${tx} ${tyMid} H${trunk} V${lane} H${p.x + NW / 2} V${p.y}`;
  };
  const byT = (t: string) => r?.candidates.find((c) => c.ticker === t);
  const tr = r?.target_record;

  return (
    <div className="canvas" onClick={() => onSelect(null)}>
      <div className="plane" style={{ width, height, transform: `scale(${zoom})` }}>
        <Group {...stageGroup} label="에이전트 진행" />
        <Group {...g1} label="1 분석 대상" />
        <Group {...g2} label={`2 비교기업 · ${peers.length}`} />
        {r && <Group {...g3} label={`3 제외 후보 · ${others.length}`} />}

        <svg className="edges" width={width} height={height}>
          {STAGES.slice(1).map((s, i) => {
            const x1 = 40 + (i + 1) * NW + i * 40;
            return <path key={s.key} d={`M${x1} ${stageY + NH / 2} H${x1 + 40}`} className={stages[s.key] ? 'on' : ''} />;
          })}
          {peers.map((t, i) => <path key={t} d={edge(i)} className={selected === t ? 'hl' : ''} />)}
        </svg>

        {STAGES.map((s, i) => {
          const st = stages[s.key];
          return <Node key={s.key} x={40 + i * (NW + 40)} y={stageY} icon={s.icon} title={s.label} sub={st === 'done' ? '완료' : st === 'active' ? '진행 중…' : s.sub} state={st === 'active' ? 'active' : st === 'done' ? 'done' : 'muted'} />;
        })}

        <Node
          x={40} y={ty} icon="chip" title={target} sub={shorts[target] ?? ''} state="dark"
          tag={{ text: '분석 대상', tone: 'gray' }}
          chips={tr ? chipsOf(tr) : undefined}
          selected={selected === target} onClick={() => onSelect(target)}
        />

        {!r && <div className="empty" style={{ left: g2.x + 24, top: r1 + 60, width: g2.w - 48 }}>왼쪽에서 <b>분석 시작</b>을 누르면<br />비교기업이 여기에 연결돼요.</div>}
        {r && peers.length === 0 && <div className="empty" style={{ left: g2.x + 24, top: r1 + 60, width: g2.w - 48 }}>근거가 충분한 비교기업이 없어요.<br />아래 제외 후보에서 + 로 추가할 수 있어요.</div>}

        {peers.map((t, i) => {
          const c = byT(t)!;
          const named = !!c.namedAsCompetitor?.length;
          return (
            <Node
              key={t} {...peerPos[i]} icon="chip" title={t}
              sub={`${shorts[t] ?? ''} · ${c.review ? relationshipLabel[c.review.relationship] : '직접 추가'}`}
              tag={named ? { text: '10-K 경쟁사 기재' } : !r!.selected.includes(t) ? { text: '직접 추가', tone: 'gray' } : undefined}
              chips={chipsOf(c)} badge={robust[t]}
              selected={selected === t} onClick={() => onSelect(t)}
              action={{ label: `${t} 제외`, icon: 'x', onClick: () => onToggle(t) }}
            />
          );
        })}

        {others.map((c, i) => {
          const blocked = c.issues?.some((x) => x.level === 'block');
          const hold = c.review?.decision === 'hold';
          return (
            <Node
              key={c.ticker} x={40 + (i % cols) * (NW + 22)} y={r2 + 46 + Math.floor(i / cols) * 92}
              icon="chip" title={c.ticker} sub={shorts[c.ticker] ?? ''} state="muted" badge={blocked ? undefined : robust[c.ticker]}
              tag={blocked ? { text: '재무 비교 불가', tone: 'red' } : hold ? { text: '판단 보류', tone: 'gray' } : undefined}
              selected={selected === c.ticker} onClick={() => onSelect(c.ticker)}
              action={blocked ? undefined : { label: `${c.ticker} 추가`, icon: 'plus', onClick: () => onToggle(c.ticker) }}
            />
          );
        })}
      </div>
    </div>
  );
}
