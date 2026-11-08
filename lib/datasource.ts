// Data access, swappable: live SEC EDGAR (real mode) or stored EDGAR snapshot (demo mode).
import fs from 'node:fs';
import path from 'node:path';
import { fetchAnnualFilings, fetchCompanyFacts, fetchFilingText, findExcerpts, type ExcerptTopic } from './edgar.ts';
import type { AnnualFiling, CompanyFacts, Profile } from './types.ts';

const DATA = path.join(process.cwd(), 'data');

export interface Snapshot {
  ticker: string;
  cik: number;
  collectedAt: string;
  facts: CompanyFacts;
  filings: AnnualFiling[];
  excerpts: Record<string, Partial<Record<ExcerptTopic, string[]>>>; // accn -> topic -> snippets
}

export interface DataSource {
  kind: 'live' | 'snapshot';
  facts(ticker: string): Promise<{ facts: CompanyFacts; collectedAt: string }>;
  filings(ticker: string): Promise<AnnualFiling[]>;
  // null = not available in this source
  excerpts(ticker: string, filing: AnnualFiling, topic: ExcerptTopic): Promise<{ snippets: string[]; collectedAt: string } | null>;
}

interface CompaniesFile {
  targets: string[];
  candidatePool: Record<string, string[]>;
  poolRule: string;
  companies: Profile[];
}

let companiesCache: CompaniesFile | null = null;
export function companies(): CompaniesFile {
  return (companiesCache ??= JSON.parse(fs.readFileSync(path.join(DATA, 'companies.json'), 'utf8')));
}
export function profileOf(ticker: string): Profile | undefined {
  return companies().companies.find((c) => c.ticker === ticker);
}
function cikOf(ticker: string): number {
  const p = profileOf(ticker);
  if (!p) throw new Error(`알 수 없는 티커: ${ticker}`);
  return p.cik;
}

export function snapshotSource(dir = path.join(DATA, 'snapshot')): DataSource {
  const cache = new Map<string, Snapshot>();
  const load = (t: string) => {
    if (!cache.has(t)) {
      const file = path.join(dir, `${t}.json`);
      if (!fs.existsSync(file)) throw new Error(`스냅샷 파일 없음: ${t}`);
      cache.set(t, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    return cache.get(t)!;
  };
  return {
    kind: 'snapshot',
    async facts(t) {
      const s = load(t);
      return { facts: s.facts, collectedAt: s.collectedAt };
    },
    async filings(t) {
      return load(t).filings;
    },
    async excerpts(t, filing, topic) {
      const s = load(t);
      const snippets = s.excerpts[filing.accn]?.[topic];
      return snippets ? { snippets, collectedAt: s.collectedAt } : null;
    },
  };
}

// ponytail: in-process cache only, lost on restart; add a disk cache if EDGAR latency hurts.
const liveCache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!liveCache.has(key)) liveCache.set(key, fn().catch((e) => { liveCache.delete(key); throw e; }));
  return liveCache.get(key) as Promise<T>;
}

export function liveSource(): DataSource {
  return {
    kind: 'live',
    facts: (t) => cached(`facts:${t}`, async () => ({ facts: await fetchCompanyFacts(cikOf(t)), collectedAt: new Date().toISOString() })),
    filings: (t) => cached(`filings:${t}`, () => fetchAnnualFilings(cikOf(t))),
    excerpts: (t, filing, topic) =>
      cached(`ex:${filing.accn}:${topic}`, async () => {
        const text = await cached(`text:${filing.accn}`, () => fetchFilingText(filing.url));
        return { snippets: findExcerpts(text, topic), collectedAt: new Date().toISOString() };
      }),
  };
}
