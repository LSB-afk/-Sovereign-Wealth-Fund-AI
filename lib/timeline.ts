// Re-run the same rule agent with financial filings published on/before each analysis date.
// Curated company profiles/tags use their current values and are not versioned by date, so this is not a point-in-time backtest.
import { RulePolicy, runAgent } from './agent.ts';
import type { DataSource } from './datasource.ts';
import type { Decision } from './types.ts';

export interface TimelinePoint {
  asOf: string;
  status: string;
  selected: string[];
  target: { periodEnd?: string; revenue?: number; growth: number | null; margin: number | null };
  cells: Record<string, { decision?: Decision; score?: number; periodEnd?: string; blocked: boolean }>;
}

export interface Timeline { target: string; points: TimelinePoint[]; changes: string[] }

export async function runTimeline(target: string, dates: string[], ds: DataSource): Promise<Timeline> {
  const points: TimelinePoint[] = [];
  for (const asOf of [...dates].sort()) {
    const r = await runAgent({ target, asOf, mode: 'demo', ds, policy: new RulePolicy(), modeLabel: 'timeline', dataNote: '' });
    const tf = r.target_record.financials;
    points.push({
      asOf, status: r.status, selected: r.selected,
      target: { periodEnd: tf?.latest?.periodEnd, revenue: tf?.latest?.values.revenue?.value, growth: tf?.revenueGrowth ?? null, margin: tf?.operatingMargin ?? null },
      cells: Object.fromEntries(r.candidates.map((c) => [c.ticker, {
        decision: c.review?.decision, score: c.ruleScore?.total, periodEnd: c.financials?.latest?.periodEnd,
        blocked: !!c.issues?.some((i) => i.level === 'block'),
      }])),
    });
  }
  const changes: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const inn = b.selected.filter((t) => !a.selected.includes(t)), out = a.selected.filter((t) => !b.selected.includes(t));
    if (inn.length || out.length) changes.push(`${a.asOf} → ${b.asOf}: ${[inn.length && `편입 ${inn.join(', ')}`, out.length && `제외 ${out.join(', ')}`].filter(Boolean).join(' · ')}`);
  }
  return { target, points, changes };
}
