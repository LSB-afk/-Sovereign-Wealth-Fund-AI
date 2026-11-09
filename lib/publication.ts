import type { AnalysisResult, CandidateRecord } from './types.ts';

export function canCompare(candidate: CandidateRecord): boolean {
  return candidate.review?.verification.status === 'passed'
    && candidate.review.decision !== 'hold'
    && !candidate.issues?.some((issue) => issue.level === 'block')
    && !!candidate.financials?.latest?.values.revenue;
}

export function assertPublishablePeers(result: AnalysisResult, peers: string[]): void {
  if (new Set(peers).size !== peers.length || peers.some((ticker) => {
    const candidate = result.candidates.find((c) => c.ticker === ticker);
    return !candidate || !canCompare(candidate);
  })) throw new Error('게시 검사를 통과한 비교 가능한 후보만 보고서에 포함할 수 있습니다.');
}
