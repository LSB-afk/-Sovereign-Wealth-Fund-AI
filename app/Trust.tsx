'use client';
import { useEffect, useMemo, useState } from 'react';
import type { AnalysisResult, EvidenceCheck } from '@/lib/types.ts';
import type { RunSummary, StoredRun } from '@/lib/runs.ts';

interface Props {
  result: AnalysisResult | null;
  edited: boolean;
  onLoad: (r: AnalysisResult) => void;
}

const approvalLabel = { pending: '검토 대기', approved: '승인됨', rejected: '반려됨' };
const time = (value: string) => new Date(value).toLocaleString('ko-KR');

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청을 처리할 수 없습니다.');
  return body as T;
}

export default function TrustView({ result, edited, onLoad }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [receipt, setReceipt] = useState<StoredRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const runId = result?.runId;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setReceipt(null);
    setNote('');
    const init = { signal: controller.signal };
    Promise.all([
      json<{ runs: RunSummary[] }>('/api/runs', init).then((data) => setRuns(data.runs)),
      runId ? json<StoredRun>(`/api/runs/${runId}`, init).then((data) => { setReceipt(data); setNote(data.approval.note || ''); }) : Promise.resolve(),
    ]).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [runId]);

  const checks = useMemo(() => {
    const items: EvidenceCheck[] = [
      ...(result?.reliability?.checks ?? []),
      ...(result?.candidates.flatMap((c) => (c.review?.verification?.checks ?? []).map((check) => ({ ...check, ticker: check.ticker ?? c.ticker }))) ?? []),
    ];
    return items.filter((item, i) => items.findIndex((other) => other.code === item.code && other.ticker === item.ticker && other.message === item.message) === i);
  }, [result]);

  async function refresh() {
    setLoading(true); setError(null);
    try { setRuns((await json<{ runs: RunSummary[] }>('/api/runs')).runs); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function load(id: string) {
    setBusy(id); setError(null);
    try {
      const stored = await json<StoredRun>(`/api/runs/${id}`);
      setReceipt(stored); setNote(stored.approval.note || '');
      onLoad(stored.result);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function review(decision: 'approved' | 'rejected') {
    if (!receipt || receipt.id !== runId) return;
    setBusy('review'); setError(null);
    try {
      const stored = await json<StoredRun>(`/api/runs/${receipt.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note, digest: receipt.digest }),
      });
      setReceipt(stored);
      setRuns((all) => all.map((run) => run.id === stored.id ? { ...run, approval: stored.approval } : run));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  const passed = result?.reliability?.status === 'passed';
  const currentReceipt = receipt?.id === runId ? receipt : null;
  const canApprove = !!currentReceipt && result?.status === 'complete' && passed && !edited && !busy;

  return (
    <>
      {error && <div className="banner err" role="alert">{error}</div>}
      <div className="sheet">
        <h3>게시 전 검증 <span>{result ? `${result.target} · 기준일 ${result.asOf}` : '분석 결과를 실행하거나 기록에서 불러오세요'}</span></h3>
        {result ? (
          <>
            <p><b style={{ color: passed ? 'var(--green)' : 'var(--orange)' }}>{passed ? '게시 검사 통과' : '추가 검토 필요'}</b></p>
            <p className="foot">이 상태는 출처·수치·게시 규칙 검사 결과입니다. 원문 자체의 정확성이나 투자 판단의 정답을 보장하지 않습니다.</p>
            <table className="grid" style={{ marginTop: 12 }}>
              <thead><tr><th>게시 가능한 후보 검토</th><th>검증 보류</th><th>수집 출처</th><th>에이전트 제안 Peer</th></tr></thead>
              <tbody><tr><td>{result.reliability?.published ?? 0}건</td><td>{result.reliability?.held ?? result.candidates.length}건</td><td>{result.sources.length}건</td><td>{result.selected.length}곳</td></tr></tbody>
            </table>
          </>
        ) : <p>근거가 부족한 결과는 보류하고, 게시 규칙을 통과한 결과만 검토합니다.</p>}
        <table className="grid" style={{ marginTop: 14 }}>
          <thead><tr><th>정보의 종류</th><th>확인 범위</th></tr></thead>
          <tbody>
            <tr><td>공시 원값</td><td>수집한 공시 출처와 연결합니다. 자료가 없으면 누락으로 남깁니다.</td></tr>
            <tr><td>계산 지표</td><td>성장률·영업이익률 등은 공시 원값으로 코드에서 계산합니다.</td></tr>
            <tr><td>정성 비교</td><td>제품·고객 태그는 큐레이션에 따른 비교 가설입니다. 출처가 있다는 이유만으로 사실 확정으로 취급하지 않습니다.</td></tr>
            <tr><td>LLM 자유 서술</td><td>검증된 보고서에 게시하지 않습니다. 수집된 자료와 계산 결과를 바탕으로 정해진 형식의 설명을 사용합니다.</td></tr>
          </tbody>
        </table>
      </div>

      {result && <div className="sheet">
        <h3>후보별 게시 검사</h3>
        <div className="scroll"><table className="grid">
          <thead><tr><th>후보</th><th>게시 검사</th><th>보류 사유</th></tr></thead>
          <tbody>{result.candidates.map((candidate) => <tr key={candidate.ticker}>
            <td><b>{candidate.ticker}</b></td>
            <td>{candidate.review?.verification?.status === 'passed' ? '통과' : '보류'}</td>
            <td>{candidate.review?.verification?.checks.map((check) => check.message).join(' · ') || (candidate.review?.verification?.status === 'passed' ? '게시 규칙 검사 통과' : '검토 또는 검증 결과가 없습니다.')}</td>
          </tr>)}</tbody>
        </table></div>
        {checks.length > 0 && <details style={{ marginTop: 12 }}>
          <summary>검사 세부사항 {checks.length}건</summary>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead><tr><th>기업</th><th>검사 코드</th><th>내용</th></tr></thead>
            <tbody>{checks.map((check, i) => <tr key={`${check.ticker}-${check.code}-${i}`}><td>{check.ticker || '전체'}</td><td><code>{check.code}</code></td><td>{check.message}</td></tr>)}</tbody>
          </table>
        </details>}
      </div>}

      {result && <div className="sheet">
        <h3>담당자 검토 <span>{currentReceipt ? approvalLabel[currentReceipt.approval.decision] : loading ? '기록 확인 중…' : '저장 기록 없음'}</span></h3>
        <p>저장된 원래 실행 결과를 확인한 뒤 승인하거나 반려합니다. 승인은 투자 실행을 뜻하지 않습니다.</p>
        {edited && <p className="foot" style={{ color: 'var(--orange)' }}>현재 Peer 구성을 직접 변경했습니다. 이 구성으로 원래 실행을 승인할 수 없습니다. 원래 제안으로 돌아오거나 별도로 다시 분석하세요.</p>}
        {!passed && <p className="foot">추가 검토가 필요한 결과는 승인할 수 없습니다. 근거를 보완한 새 분석이 필요합니다.</p>}
        {result.status !== 'complete' && <p className="foot">완료되지 않은 실행은 승인할 수 없습니다.</p>}
        <label style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
          검토 메모
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} disabled={!currentReceipt || !!busy} rows={3} style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, border: '1px solid var(--line)', borderRadius: 8, resize: 'vertical' }} />
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn" disabled={!canApprove} onClick={() => review('approved')}>원래 실행 승인</button>
          <button className="btn" disabled={!currentReceipt || !!busy} onClick={() => review('rejected')}>원래 실행 반려</button>
          {busy === 'review' && <span className="tiny" role="status">검토 저장 중…</span>}
        </div>
        {currentReceipt?.approval.at && <p className="foot">마지막 검토: {time(currentReceipt.approval.at)}{currentReceipt.approval.note ? ` · ${currentReceipt.approval.note}` : ''}</p>}
      </div>}

      <div className="sheet">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>실행 기록 <button className="btn" onClick={refresh} disabled={loading || !!busy}>새로고침</button></h3>
        <p className="foot">저장된 실행 원본을 불러옵니다. 이후 사용자가 바꾼 Peer 구성은 포함하지 않습니다.</p>
        {loading ? <p role="status" style={{ marginTop: 12 }}>실행 기록 확인 중…</p> : runs.length === 0 ? <p style={{ marginTop: 12 }}>아직 저장된 실행이 없습니다.</p> : <div className="scroll"><table className="grid" style={{ marginTop: 12 }}>
          <thead><tr><th>실행 시각</th><th>대상 · 기준일</th><th>모드</th><th>Peer</th><th>담당자 검토</th><th></th></tr></thead>
          <tbody>{runs.map((run) => <tr key={run.id}>
            <td>{time(run.createdAt)}</td><td><b>{run.target}</b> · {run.asOf}</td>
            <td>{run.mode === 'demo' ? '데모 · LLM 미사용' : '실제'}</td><td>{run.selected.join(', ') || '없음'}</td>
            <td>{approvalLabel[run.approval.decision]}</td>
            <td><button className="btn" disabled={!!busy} onClick={() => load(run.id)}>{busy === run.id ? '불러오는 중…' : run.id === runId ? '원본 다시 보기' : '불러오기'}</button></td>
          </tr>)}</tbody>
        </table></div>}
      </div>
    </>
  );
}
