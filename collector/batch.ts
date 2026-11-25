/**
 * 하루 한 번 배치 (lib/batch.ts): 지난 묶음 결과 반영 → 대기열을 새 묶음으로 보내기
 *   STORE=pg npm run batch            결과 반영 + 새로 보내기
 *   STORE=pg npm run batch -- --check 결과 반영만 (새로 보내지 않음)
 */
import './lib/env.ts';
import { batchEnabled, BATCH_JOBS, BATCH_STATE, collectBatches, submitBatch, type BatchArticle, type BatchJob } from './lib/batch.ts';
import { Budget } from './lib/budget.ts';
import { JsonRepo } from './lib/repo.ts';

const repo = new JsonRepo();
const now = new Date();
if (!batchEnabled()) {
  console.log('배치 꺼짐 (OPENAI_API_KEY 없음 또는 BATCH_OLD_ARTICLES=0)');
  process.exit(0);
}
const budget = await new Budget(repo, now).load();
try {
  for (const l of await collectBatches(repo, budget, now)) console.log(l);
  if (!process.argv.includes('--check')) for (const l of await submitBatch(repo, budget, now)) console.log(l);
} finally {
  await budget.save();
}
const queue = Object.values(await repo.getState<Record<string, BatchArticle>>(BATCH_STATE, {}));
const jobs = await repo.getState<BatchJob[]>(BATCH_JOBS, []);
console.log(`대기열 ${queue.length}개 (보낸 것 ${queue.filter((x) => x.jobId).length}개) · 진행 중 묶음 ${jobs.length}개 · ${budget.summary()}`);
