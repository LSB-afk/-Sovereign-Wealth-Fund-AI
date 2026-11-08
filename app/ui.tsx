'use client';
import { createContext, useContext } from 'react';
import type { Source } from '@/lib/types.ts';

// Jump to a source entry (switches to the 출처 view). Provided by App.
export const GoSource = createContext<(id: string) => void>(() => {});

export function Src({ ids, sources }: { ids?: (string | undefined)[]; sources: Source[] }) {
  const go = useContext(GoSource);
  const list = (ids ?? []).filter(Boolean).map((id) => sources.find((s) => s.id === id)).filter(Boolean) as Source[];
  if (!list.length) return null;
  return (
    <span className="src">
      {list.map((s) => (
        <a key={s.id} href={`#src-${s.id}`} title={s.title} onClick={(e) => { e.preventDefault(); e.stopPropagation(); go(s.id); }}>{s.id}</a>
      ))}
    </span>
  );
}

const PATHS: Record<string, string> = {
  logo: 'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5',
  box: 'M4 8h16v11H4zM9 8V5h6v3M4 12h16',
  map: 'M6 6h4v4H6zM14 14h4v4h-4zM10 8h3a1 1 0 0 1 1 1v5',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  check: 'M4 12l5 5L20 6',
  doc: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  shield: 'M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  chip: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  flag: 'M5 21V4h11l-2 4 2 4H5',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  x: 'M6 6l12 12M18 6L6 18',
  down: 'M12 4v12M6 11l6 6 6-6M5 20h14',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  graph: 'M4 6a2 2 0 1 0 4 0 2 2 0 1 0-4 0M16 6a2 2 0 1 0 4 0 2 2 0 1 0-4 0M10 18a2 2 0 1 0 4 0 2 2 0 1 0-4 0M8 6h8M7 8l4 8M17 8l-4 8',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11.5v1',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}
