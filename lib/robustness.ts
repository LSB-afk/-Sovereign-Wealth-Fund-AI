// Robustness of the peer set to the (arbitrary) scoring weights. Pure, client-safe, deterministic (seeded).
// For N random weight vectors (uniform on the simplex) and thresholds in [0.40, 0.50], re-run the same selection
// rule and count how often each candidate is selected. A peer that survives most weightings is "robust".
import { SCORING } from './peer.ts';
import { canCompare } from './publication.ts';
import type { CandidateRecord, CriterionKey } from './types.ts';

const KEYS = Object.keys(SCORING.weights) as CriterionKey[];

// mulberry32: small seeded PRNG so the result is reproducible.
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RobustRow { ticker: string; rate: number; band: 'robust' | 'likely' | 'borderline' | 'rare' | 'ineligible'; baseSelected: boolean }

export const BAND_LABEL: Record<RobustRow['band'], string> = {
  robust: '강건 (80% 이상)', likely: '대체로 선정 (50~80%)', borderline: '경계선 (20~50%)', rare: '거의 제외 (20% 미만)', ineligible: '비교 불가',
};

export function robustness(cands: CandidateRecord[], baseSelected: string[], n = 2000, seed = 42): { rows: RobustRow[]; n: number } {
  const eligible = cands.filter((c) => canCompare(c) && c.ruleScore && c.ruleScore.parts.dataSufficiency === 1);
  const count = new Map<string, number>();
  const rand = rng(seed);
  for (let s = 0; s < n; s++) {
    const e = KEYS.map(() => -Math.log(1 - rand())); // exponential draws → uniform Dirichlet(1,…,1)
    const sum = e.reduce((a, b) => a + b, 0);
    const w = Object.fromEntries(KEYS.map((k, i) => [k, e[i] / sum])) as Record<CriterionKey, number>;
    const threshold = 0.4 + rand() * 0.1;
    eligible
      .map((c) => ({ t: c.ticker, v: KEYS.reduce((a, k) => a + c.ruleScore!.parts[k] * w[k], 0) }))
      .filter((x) => x.v >= threshold)
      .sort((a, b) => b.v - a.v)
      .slice(0, SCORING.maxPeers)
      .forEach((x) => count.set(x.t, (count.get(x.t) ?? 0) + 1));
  }
  const rows = cands.map((c): RobustRow => {
    const ok = eligible.includes(c);
    const rate = ok ? (count.get(c.ticker) ?? 0) / n : 0;
    const band = !ok ? 'ineligible' : rate >= 0.8 ? 'robust' : rate >= 0.5 ? 'likely' : rate >= 0.2 ? 'borderline' : 'rare';
    return { ticker: c.ticker, rate, band, baseSelected: baseSelected.includes(c.ticker) };
  });
  return { rows: rows.sort((a, b) => b.rate - a.rate), n };
}
