// Real-mode policy: Claude chooses tool calls. Swappable with RulePolicy via the Policy interface.
import Anthropic from '@anthropic-ai/sdk';
import { companies } from './datasource.ts';
import { TOOLS, type Ctx, type Policy, type Step, type ToolResult } from './agent.ts';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const EFFORT = (process.env.ANTHROPIC_EFFORT || 'medium') as 'low' | 'medium' | 'high';

function systemPrompt(ctx: Ctx, maxToolCalls: number) {
  return `너는 투자 리서치 담당자를 돕는 '근거 기반 Peer Group 분석 에이전트'다.
분석 대상: ${ctx.target}. 분석 기준일: ${ctx.asOf} (도구는 기준일 이후 공시를 자동 제외한다).
후보군 구성 규칙: ${companies().poolRule}

작업:
1. list_candidates로 후보군을 확인하고, 대상과 각 후보의 프로필·재무지표·비교 가능성을 도구로 확인한다.
2. 사업 유사성이 불명확하면 get_filing_excerpt로 연간보고서 원문(경쟁·고객·사업부문)을 추가 확인한다.
3. 재무자료가 부족하거나 비교가 부적절하면 hold 또는 excluded로 판단하고 그 한계를 적는다.
4. 모든 후보에 대해 save_review를 한 번씩 호출한다. 기준: 주요 제품·사업모델(product), 매출 구성·고객군(customers), 기업 규모(scale), 성장성·수익성(growthProfitability), 자료 충분성·비교 가능성(dataSufficiency).
5. 사업상 경쟁 관계(business_competitor)와 재무적으로 비교하기 좋은 관계(financial_comparable)를 구분한다.
6. 근거가 충분할 때만 3~5개를 selected로 한다. 충분하지 않으면 더 적게 선정하고 이유를 적는다.

규칙:
- 숫자는 도구가 반환한 값만 인용한다. 새로 계산·추정하거나 기억에 의존한 수치를 쓰지 않는다.
- 근거에는 도구 결과에 있는 sourceId(S로 시작)만 쓴다. URL을 만들지 않는다.
- check_comparability의 referenceScore는 초기 설정 규칙 점수로 참고용이며 정답·확률이 아니다.
- 도구 호출은 최대 ${maxToolCalls}회다. 서로 독립적인 호출은 한 응답에서 함께 요청한다.
- 모든 save_review를 마친 뒤 한국어 3~5문장으로 결과를 요약하고 종료한다. 내부 추론 과정은 길게 쓰지 않는다.`;
}

export class LlmPolicy implements Policy {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private pending: string[] = [];
  private maxToolCalls: number;

  constructor(maxRetries: number, maxToolCalls: number) {
    // API key read from server env (ANTHROPIC_API_KEY) by the SDK.
    this.client = new Anthropic({ maxRetries });
    this.maxToolCalls = maxToolCalls;
  }

  async next(ctx: Ctx, results: ToolResult[] | null, budget: { toolCallsLeft: number; msLeft: number }): Promise<Step> {
    if (!results) {
      this.messages.push({ role: 'user', content: `${ctx.target}의 Peer Group 분석을 시작하라. 기준일 ${ctx.asOf}.` });
    } else {
      const content: Anthropic.Beta.BetaToolResultBlockParam[] = this.pending.map((id) => {
        const r = results.find((x) => x.id === id);
        return { type: 'tool_result', tool_use_id: id, content: r?.content ?? '오류: 실행되지 않음', is_error: !r?.ok };
      });
      this.messages.push({ role: 'user', content: [...content, { type: 'text', text: `남은 도구 호출: ${budget.toolCallsLeft}회, 남은 시간: ${Math.round(budget.msLeft / 1000)}초.` }] });
    }

    const res = await this.client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        system: systemPrompt(ctx, this.maxToolCalls),
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema, strict: true })),
        messages: this.messages,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { timeout: Math.max(5000, budget.msLeft) },
    );

    if (res.stop_reason === 'refusal') throw new Error('모델이 요청을 거절함 (refusal)');
    if (res.stop_reason === 'max_tokens') throw new Error('모델 응답이 최대 길이를 초과함');
    this.messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });

    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!uses.length) {
      const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { done: text || '(요약 없음)' };
    }
    this.pending = uses.map((u) => u.id);
    return { calls: uses.map((u) => ({ id: u.id, name: u.name, input: u.input as Record<string, unknown> })) };
  }
}
