// Shared types. Server and client both import from here.

export type Mode = 'demo' | 'real';
export type MetricKey = 'revenue' | 'operatingIncome' | 'rnd';

// One XBRL fact as returned by SEC companyfacts (fields we use).
export interface XbrlFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number | null;
  fp?: string | null;
  form: string;
  filed: string;
  frame?: string;
}

// Trimmed companyfacts: taxonomy -> concept -> unit -> facts.
export interface CompanyFacts {
  cik: number;
  entityName: string;
  taxonomies: string[];
  facts: Record<string, Record<string, { label?: string; units: Record<string, XbrlFact[]> }>>;
}

export interface AnnualFiling {
  form: string;
  filed: string;
  reportDate: string;
  accn: string;
  primaryDocument: string;
  url: string; // primary document
  indexUrl: string;
}

export interface Source {
  id: string;
  ticker: string;
  kind: 'xbrl' | 'filing' | 'filing_excerpt' | 'profile';
  title: string;
  url: string;
  form?: string;
  filed?: string;
  period?: string;
  accessedAt: string;
  quote?: string[]; // collected excerpt text (filing_excerpt only)
}

export interface MetricValue {
  ticker: string;
  cik: number;
  metric: MetricKey;
  definition: string;
  concept: string; // original XBRL element name, e.g. us-gaap:OperatingIncomeLoss
  value: number;
  unit: string;
  periodStart: string;
  periodEnd: string;
  fiscalYear: number | null;
  form: string;
  filed: string;
  accn: string;
  url: string;
  collectedAt: string;
  sourceId?: string;
}

export interface PeriodValues {
  periodStart: string;
  periodEnd: string;
  values: Partial<Record<MetricKey, MetricValue>>;
}

export interface Financials {
  ticker: string;
  asOf: string;
  latest: PeriodValues | null;
  prior: PeriodValues | null;
  revenueGrowth: number | null;
  operatingMargin: number | null;
  rndRatio: number | null;
  missing: string[];
  notes: string[];
}

export interface Issue {
  level: 'block' | 'warn' | 'info';
  code: string;
  message: string;
}

export interface Profile {
  ticker: string;
  cik: number;
  name: string;
  short: string; // 2~3단어 요약 (화면 표시용)
  businessModel: string;
  businessModelTag: 'fabless' | 'idm' | 'foundry' | 'ip_licensing' | 'idm_foundry';
  summary: string;
  products: string[];
  productTags: string[];
  endMarkets: string[];
  customerTags: string[];
  aliases: string[];
  note?: string;
}

export type Assessment = 'similar' | 'partial' | 'different' | 'unknown';
export type CriterionKey = 'product' | 'customers' | 'scale' | 'growthProfitability' | 'dataSufficiency';
export type Decision = 'selected' | 'excluded' | 'hold';
export type Relationship = 'business_competitor' | 'financial_comparable' | 'both' | 'none';

export interface CriterionJudgment {
  assessment: Assessment;
  note: string;
  sourceIds: string[];
}

export interface Review {
  ticker: string;
  decision: Decision;
  relationship: Relationship;
  criteria: Record<CriterionKey, CriterionJudgment>;
  reason: string;
  sourceIds: string[];
  author: 'llm' | 'rule';
  warnings: string[]; // e.g. unverified numbers in LLM text, dropped source ids
}

export interface RuleScore {
  total: number;
  parts: Record<CriterionKey, number>;
}

export interface CandidateRecord {
  ticker: string;
  profile?: Profile;
  financials?: Financials;
  issues?: Issue[];
  namedAsCompetitor?: string[]; // source ids of excerpts naming this company
  ruleScore?: RuleScore;
  review?: Review;
}

export interface ToolLogEntry {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  attempts: number;
  ms: number;
}

export interface AnalysisResult {
  mode: Mode;
  modeLabel: string;
  target: string;
  asOf: string;
  startedAt: string;
  finishedAt: string;
  status: 'complete' | 'partial' | 'failed';
  stopReason?: string;
  summary: string;
  target_record: CandidateRecord;
  candidates: CandidateRecord[];
  selected: string[];
  sources: Source[];
  toolLog: ToolLogEntry[];
  warnings: string[];
  limits: Limits;
  dataNote: string;
}

export interface Limits {
  maxToolCalls: number;
  maxTurns: number;
  maxRetries: number;
  timeoutMs: number;
}

export type Stage = 'collect' | 'review' | 'metrics' | 'report';

export type AgentEvent =
  | { type: 'stage'; stage: Stage; status: 'active' | 'done' }
  | { type: 'tool'; entry: ToolLogEntry }
  | { type: 'warning'; message: string }
  | { type: 'result'; result: AnalysisResult }
  | { type: 'error'; message: string };
