/**
 * AI 비용 상한. 월 상한(LLM_MONTHLY_BUDGET_USD, 기본 $5)이나 실행당 호출 수(LLM_MAX_CALLS_PER_RUN, 기본 40)를
 * 넘으면 AI를 부르지 않는다. 그동안 공지는 규칙 방식으로 대신한다.
 */
import type { Repo } from './repo.ts';
import { toKstParts } from './time.ts';

type Usage = Record<string, { costUsd: number; calls: number }>;

export class Budget {
  readonly monthlyLimitUsd = Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 5);
  readonly perRunCalls = Number(process.env.LLM_MAX_CALLS_PER_RUN ?? 40);
  private usage: Usage = {};
  private runCalls = 0;
  private runCost = 0;
  private readonly month: string;

  constructor(
    private repo: Repo,
    now: Date,
  ) {
    const p = toKstParts(now);
    this.month = `${p.year}-${String(p.month).padStart(2, '0')}`;
  }

  async load() {
    this.usage = await this.repo.getState<Usage>('usage', {});
    return this;
  }

  get monthCostUsd() {
    return this.usage[this.month]?.costUsd ?? 0;
  }

  canSpend(): boolean {
    return this.runCalls < this.perRunCalls && this.monthCostUsd < this.monthlyLimitUsd;
  }

  record(costUsd: number) {
    this.runCalls++;
    this.runCost += costUsd;
    const m = (this.usage[this.month] ??= { costUsd: 0, calls: 0 });
    m.costUsd = Math.round((m.costUsd + costUsd) * 1e6) / 1e6;
    m.calls++;
  }

  summary() {
    return `AI ${this.runCalls}번 약 ${Math.round(this.runCost * 1400)}원 (이번 달 누적 약 ${Math.round(this.monthCostUsd * 1400)}원 / 상한 ${Math.round(this.monthlyLimitUsd * 1400)}원)`;
  }

  save() {
    return this.repo.putState('usage', this.usage);
  }
}
