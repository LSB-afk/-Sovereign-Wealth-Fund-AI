import fs from 'node:fs';
import path from 'node:path';
import App from './App';
import { companies } from '@/lib/datasource.ts';

export const dynamic = 'force-dynamic';

export default function Page() {
  const meta = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'snapshot', 'meta.json'), 'utf8'));
  const names = Object.fromEntries(companies().companies.map((c) => [c.ticker, c.name]));
  const shorts = Object.fromEntries(companies().companies.map((c) => [c.ticker, c.short]));
  return (
    <App
      realAvailable={!!process.env.ANTHROPIC_API_KEY && !!process.env.SEC_USER_AGENT}
      snapshotDate={meta.collectedAt.slice(0, 10)}
      targets={companies().targets}
      names={names}
      shorts={shorts}
    />
  );
}
