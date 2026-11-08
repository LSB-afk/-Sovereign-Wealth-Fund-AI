// Builds the demo-mode data snapshot from live SEC EDGAR.
// Usage: SEC_USER_AGENT="Org Name you@example.com" npm run snapshot
// Stores trimmed companyfacts, the annual filing list, and 10-K/20-F excerpts for the four latest annual reports (time machine).
import fs from 'node:fs';
import path from 'node:path';
import { companies } from '../lib/datasource.ts';
import { fetchAnnualFilings, fetchCompanyFacts, fetchFilingText, findExcerpts, type ExcerptTopic } from '../lib/edgar.ts';
import type { Snapshot } from '../lib/datasource.ts';

const out = path.join(process.cwd(), 'data', 'snapshot');
fs.mkdirSync(out, { recursive: true });
const topics: ExcerptTopic[] = ['competition', 'customers', 'segments'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const c of companies().companies) {
  const collectedAt = new Date().toISOString();
  const facts = await fetchCompanyFacts(c.cik);
  const filings = await fetchAnnualFilings(c.cik);
  const excerpts: Snapshot['excerpts'] = {};
  for (const f of filings.filter((f) => !f.form.endsWith('/A')).slice(0, 4)) {
    await sleep(300);
    const text = await fetchFilingText(f.url);
    excerpts[f.accn] = Object.fromEntries(topics.map((t) => [t, findExcerpts(text, t)]));
  }
  const snap: Snapshot = { ticker: c.ticker, cik: c.cik, collectedAt, facts, filings, excerpts };
  fs.writeFileSync(path.join(out, `${c.ticker}.json`), JSON.stringify(snap));
  console.log(c.ticker, 'filings', filings.length, 'excerpt filings', Object.keys(excerpts).length);
  await sleep(300);
}
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ collectedAt: new Date().toISOString(), source: 'SEC EDGAR companyfacts / submissions / Archives' }, null, 2));
