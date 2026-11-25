/**
 * AI 비용 상한. 월 상한(LLM_MONTHLY_BUDGET_USD, 기본 $5)이나 실행당 호출 수(LLM_MAX_CALLS_PER_RUN, 기본 40)를
 * 넘으면 AI를 부르지 않는다. 그동안 공지는 규칙 방식으로 대신한다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiStats } from './ai-provider.ts';
import { ROOT } from './store.ts';
import type { Repo } from './repo.ts';
import { toKstParts } from './time.ts';

type Usage = Record<string, { costUsd: number; calls: number }>;
// 달별 상한 (config/budget.json): 한 달만 올릴 때 그 달만 적는다
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config', 'budget.json'), 'utf8')) as { monthlyUsd: number; months?: Record<string, number> };

export class Budget {
  /** 개발 비용은 운영 월 상한과 따로 센다: 노트북에서 돌린 것(GitHub Actions가 아닌 실행)과 LLM_BUDGET_BUCKET=dev는 'dev' 누적(상한 LLM_DEV_BUDGET_USD, 기본 $35 ≈ 5만원).
   *  운영 월 상한(LLM_MONTHLY_BUDGET_USD)은 Actions 자동 수집에만 */
  private readonly bucket = process.env.LLM_BUDGET_BUCKET ?? (process.env.GITHUB_ACTIONS === 'true' ? undefined : 'dev');
  get monthlyLimitUsd() {
    if (this.bucket) return Number(process.env.LLM_DEV_BUDGET_USD ?? 35);
    return Number(process.env.LLM_MONTHLY_BUDGET_USD ?? CONFIG.months?.[this.month] ?? CONFIG.monthlyUsd);
  }
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
    this.month = this.bucket ?? `${p.year}-${String(p.month).padStart(2, '0')}`;
  }

  async load() {
    this.usage = await this.repo.getState<Usage>('usage', {});
    return this;
  }

  get monthCostUsd() {
    return this.usage[this.month]?.costUsd ?? 0;
  }

  /** 실행당 상한은 성공한 호출(runCalls)과 실패까지 센 시도(aiStats.attempts, 상한의 2배까지) 둘 다 본다.
   *  예전에는 성공만 세서, AI가 막히면 실패한 호출이 상한에 안 잡혀 제보마다 계속 다시 불렀다 */
  canSpend(): boolean {
    return this.runCalls < this.perRunCalls && aiStats.attempts < this.perRunCalls * 2 && this.monthCostUsd < this.monthlyLimitUsd;
  }

  record(costUsd: number) {
    this.runCalls++;
    this.runCost += costUsd;
    const m = (this.usage[this.month] ??= { costUsd: 0, calls: 0 });
    m.costUsd = Math.round((m.costUsd + costUsd) * 1e6) / 1e6;
    m.calls++;
  }

  summary() {
    return `AI ${this.runCalls}번 (시도 ${aiStats.attempts}번) 약 ${Math.round(this.runCost * 1400)}원 (${this.bucket ? '개발 누적' : '이번 달 누적'} 약 ${Math.round(this.monthCostUsd * 1400)}원 / 상한 ${Math.round(this.monthlyLimitUsd * 1400)}원)`;
  }

  save() {
    return this.repo.putState('usage', this.usage);
  }
}
