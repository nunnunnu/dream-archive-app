/**
 * 급하지 않은 AI 일(일주일 넘은 기사 일정 뽑기, 일주일 넘은 소식의 제보 판정)은 OpenAI Batch API로 하루에 한 번 몰아서 (값 절반, 결과는 24시간 안).
 *  - 평소 수집(processArticles)은 기사 본문만 읽고 여기 대기열(app_state 'batch/articles')에 넣는다
 *  - npm run batch (매일 한국 5:30, Cloudflare 예약 작업이 mode=batch 로 띄움):
 *      1) 지난번에 보낸 묶음 결과를 가져와 바로 부른 것과 똑같이 저장(원문 대조 → extractions, 기사 상태 processed)
 *      2) 대기열에 남은 것을 새 묶음으로 보낸다 (월 상한 안에서)
 * Groq 무료 한도는 최근 소식에 남겨 두려는 것.
 */
import { createHash } from 'node:crypto';
import { openaiBody, readOpenAiResponse } from './ai-provider.ts';
import type { Budget } from './budget.ts';
import type { SourceRef } from './consolidate.ts';
import { ARTICLE_PROMPT_VERSION, articleRequest, checkAgainstSource, parseArticleEvents } from './llm.ts';
import { pgSelect, usePg } from './pg.ts';
import type { ArticleRecord, Repo } from './repo.ts';
import { applyJudgement, batchJudgeable, judgeRequest, JUDGE_SCHEMA, type Judgement } from './reportNews.ts';
import type { Report } from './reports.ts';
import { BATCH_AGE_DAYS, BATCH_JUDGE_MODEL, BATCH_MODEL, BATCH_WAIT_REASON, batchEnabled } from './batchConfig.ts';

export { BATCH_AGE_DAYS, BATCH_MODEL, batchEnabled };

export const BATCH_STATE = 'batch/articles';
export const BATCH_JOBS = 'batch/jobs';

export interface BatchArticle {
  queuedAt: string; title: string; writtenAt: string; url: string; publisher?: string;
  /** 본문을 못 열어 제목만으로 뽑을 때의 글 (보통은 저장된 본문을 다시 읽는다) */
  body?: string;
  /** 보낸 묶음 id (결과를 기다리는 중) */
  jobId?: string;
  tries?: number;
}
export interface BatchJob { id: string; createdAt: string; count: number }

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const api = (path: string, init?: RequestInit) => fetch(`https://api.openai.com/v1${path}`, {
  ...init, headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...(init?.headers ?? {}) },
});
const ok = async (res: Response, what: string) => {
  if (!res.ok) throw new Error(`${what} 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
};

async function bodyOf(repo: Repo, guid: string, item: BatchArticle) {
  return item.body ?? (await repo.getBody('article', guid)) ?? `(본문을 열지 못해 제목만 있음) ${item.title}`;
}

async function articlesByGuid(repo: Repo, guids: string[]): Promise<ArticleRecord[]> {
  if (!guids.length) return [];
  if (!usePg()) { const set = new Set(guids); return (await repo.listArticles('2000-01-01')).filter((a) => set.has(a.guid)); }
  const out: ArticleRecord[] = [];
  for (let i = 0; i < guids.length; i += 100) {
    const list = guids.slice(i, i + 100).map((g) => `"${g.replace(/"/g, '\\"')}"`).join(',');
    out.push(...(await pgSelect<{ data: ArticleRecord }>('articles', `select=data&guid=in.(${encodeURIComponent(list)})`)).map((r) => r.data));
  }
  return out;
}

/** 1) 끝난 묶음 결과 반영. 결과가 안 온 항목(만료·오류)은 다시 보낼 수 있게 묶음 표시를 지운다 (3번 넘게 실패하면 뺀다) */
export async function collectBatches(repo: Repo, budget: Budget, now: Date): Promise<string[]> {
  const queue = await repo.getState<Record<string, BatchArticle>>(BATCH_STATE, {});
  const jobs = await repo.getState<BatchJob[]>(BATCH_JOBS, []);
  const reports = jobs.length ? await repo.getState<Record<string, Report>>('reports', {}) : {};
  const log: string[] = [];
  const keep: BatchJob[] = [];
  const done: { guid: string; kept: number }[] = [];
  for (const job of jobs) {
    type BatchInfo = { status: string; output_file_id?: string; error_file_id?: string; request_counts?: { completed: number; failed: number; total: number } };
    let b: BatchInfo;
    const lines: string[] = [];
    try {
      const res = await api(`/batches/${job.id}`);
      // OpenAI가 묶음을 모르면(404) 결과는 영영 안 온다 → 그 기사들은 다시 보낸다
      b = res.status === 404 ? { status: 'lost' } : await (await ok(res, '배치 확인')).json() as BatchInfo;
      const age = now.getTime() - Date.parse(job.createdAt);
      if (!['completed', 'failed', 'expired', 'cancelled', 'lost'].includes(b.status)) {
        // 24시간 창을 넘어 사흘이 지나도 안 끝나면 포기하고 다시 보낸다 (가능하면 취소)
        if (age < 3 * 864e5) { keep.push(job); log.push(`배치 ${job.id}: ${b.status} (${b.request_counts?.completed ?? 0}/${b.request_counts?.total ?? job.count}), 다음 날 다시 확인`); continue; }
        await api(`/batches/${job.id}/cancel`, { method: 'POST' }).catch(() => null);
        b = { status: 'stuck' };
      }
      for (const f of [b.output_file_id, b.error_file_id]) if (f) lines.push(...(await (await ok(await api(`/files/${f}/content`), '배치 결과 받기')).text()).split('\n').filter(Boolean));
    } catch (err) {
      // 잠깐의 네트워크·서버 오류: 묶음은 그대로 두고 다음 날 다시 확인 (다른 묶음과 새로 보내기는 계속)
      keep.push(job);
      log.push(`배치 ${job.id}: 확인 실패, 다음 날 다시 (${(err as Error).message.slice(0, 120)})`);
      continue;
    }
    let applied = 0, failed = 0;
    for (const line of lines) {
      const row = JSON.parse(line) as { custom_id: string; response?: { status_code: number; body: unknown }; error?: { message?: string } };
      if (row.custom_id.startsWith('report:')) {
        const r = reports[row.custom_id.slice('report:'.length)];
        // 표시가 다른 묶음이면 건너뛴다. 표시가 지워졌어도(그사이 다른 실행이 덮어씀) 아직 대기 중이면 반영한다
        if (!r || (r.batchJob && r.batchJob !== job.id)) continue;
        try {
          if (row.response?.status_code !== 200) throw new Error(row.error?.message ?? `상태 ${row.response?.status_code}`);
          const res = readOpenAiResponse(BATCH_JUDGE_MODEL, row.response.body as never, { schema: JUDGE_SCHEMA }, true);
          budget.record(res.usage.costUsd);
          // 그사이 운영자가 처리했으면 판정은 버린다
          if (r.status === 'pending') applyJudgement(r, JSON.parse(res.value) as Judgement, now);
          r.batchJob = undefined;
          applied++;
        } catch { failed++; }
        continue;
      }
      const guid = row.custom_id.replace(/^article:/, '');
      const item = queue[guid];
      if (!item || (item.jobId && item.jobId !== job.id)) continue;
      try {
        if (row.response?.status_code !== 200) throw new Error(row.error?.message ?? `상태 ${row.response?.status_code}`);
        const req = articleRequest({ title: item.title, publishedAt: item.writtenAt, body: await bodyOf(repo, guid, item) });
        const r = readOpenAiResponse(BATCH_MODEL, row.response.body as never, req, true);
        budget.record(r.usage.costUsd);
        const events = parseArticleEvents(r.value);
        const body = await bodyOf(repo, guid, item);
        const { kept, dropped } = checkAgainstSource(events, `${item.title}\n${body}`, item.writtenAt);
        const source: SourceRef = { type: 'news', id: guid, url: item.url, title: item.title, publisher: item.publisher, publishedAt: item.writtenAt };
        await repo.putExtraction({
          docType: 'article', docId: guid, model: `${BATCH_MODEL} (batch)`, promptVersion: ARTICLE_PROMPT_VERSION, contentHash: hash(body),
          events, checked: kept, dropped, source, usage: r.usage, createdAt: now.toISOString(),
        });
        done.push({ guid, kept: kept.length });
        delete queue[guid];
        applied++;
      } catch {
        failed++;
      }
    }
    // 결과가 없거나 실패한 항목은 다음 묶음에 다시 (3번째 실패면 뺀다)
    let retry = 0, dropped = 0;
    for (const [guid, item] of Object.entries(queue)) {
      if (item.jobId !== job.id) continue;
      item.jobId = undefined;
      item.tries = (item.tries ?? 0) + 1;
      if (item.tries >= 3) { delete queue[guid]; dropped++; } else retry++;
    }
    for (const r of Object.values(reports)) {
      if (r.batchJob !== job.id) continue;
      r.batchJob = undefined;
      r.batchTries = (r.batchTries ?? 0) + 1;
      if (r.batchTries >= 3) { Object.assign(r, { reviewMode: 'manual', reviewReason: '배치 판정이 3번 실패해 사람이 확인해요.' }); dropped++; } else retry++;
    }
    log.push(`배치 ${job.id}: ${b.status} · 반영 ${applied}개 · 실패 ${failed}개 · 다시 보낼 것 ${retry}개${dropped ? ` · 3번 실패로 뺀 것 ${dropped}개` : ''}`);
  }
  // 기사 상태: 처리됨 (같은 묶음의 나머지 기사는 다음 수집이 "같은 소식"으로 정리)
  const articles = await articlesByGuid(repo, done.map((d) => d.guid));
  const kept = new Map(done.map((d) => [d.guid, d.kept]));
  for (const a of articles) Object.assign(a, { status: 'processed', note: `일정 ${kept.get(a.guid) ?? 0}개 (배치)` });
  if (articles.length) await repo.putArticles(articles);
  if (jobs.length) await repo.putState('reports', reports);
  await repo.putState(BATCH_STATE, queue);
  await repo.putState(BATCH_JOBS, keep);
  return log;
}

/** 2) 대기열(기사) + 오래된 소식 제보 판정 → 새 묶음 하나 (월 상한의 남은 몫 안에서, 기사는 한 번에 최대 BATCH_MAX개) */
export async function submitBatch(repo: Repo, budget: Budget, now: Date): Promise<string[]> {
  const queue = await repo.getState<Record<string, BatchArticle>>(BATCH_STATE, {});
  const jobs = await repo.getState<BatchJob[]>(BATCH_JOBS, []);
  const reports = await repo.getState<Record<string, Report>>('reports', {});
  // 없어진 묶음을 가리키는 표시는 지운다 (다른 실행이 지난 상태를 덮어써서 남은 것: 그대로 두면 영영 다시 안 보낸다)
  const live = new Set(jobs.map((j) => j.id));
  let stale = 0;
  for (const item of Object.values(queue)) if (item.jobId && !live.has(item.jobId)) { item.jobId = undefined; stale++; }
  for (const r of Object.values(reports)) if (r.batchJob && !live.has(r.batchJob)) { r.batchJob = undefined; stale++; }
  if (stale) await repo.putState('reports', reports);
  const waiting = Object.entries(queue).filter(([, x]) => !x.jobId).sort(([, a], [, b]) => b.writtenAt.localeCompare(a.writtenAt));
  const judge = Object.values(reports).filter((r) => !r.batchJob && batchJudgeable(r, now)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!waiting.length && !judge.length) return ['배치: 보낼 것 없음'];
  // 기사 한 건 약 0.1센트(gpt-5-mini 배치 값, 본문 6천 자 기준 넉넉히), 판정 한 건 약 0.02센트(nano) → 남은 월 상한의 절반까지만
  const perArticle = Number(process.env.BATCH_EST_USD ?? 0.001), perJudge = 0.0002;
  let room = Math.max(0, (budget.monthlyLimitUsd - budget.monthCostUsd) * 0.5);
  const pickJudge = judge.slice(0, Math.floor(room / perJudge));
  room -= pickJudge.length * perJudge;
  const pick = waiting.slice(0, Math.min(Number(process.env.BATCH_MAX ?? 1000), Math.floor(room / perArticle)));
  if (!pick.length && !pickJudge.length) return [`배치: 이번 달 AI 상한이 거의 차서 보내지 않음 (기사 ${waiting.length}개 · 제보 판정 ${judge.length}개 대기)`];
  // OpenAI Batch 는 묶음 하나에 모델 하나만 받는다 → 기사(mini)와 제보 판정(nano)은 따로 보낸다
  const send = async (kind: string, lines: string[]) => {
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([lines.join('\n')], { type: 'application/jsonl' }), `${kind}-${now.toISOString().slice(0, 10)}.jsonl`);
    const file = await (await ok(await api('/files', { method: 'POST', body: form }), '배치 파일 올리기')).json() as { id: string };
    const batch = await (await ok(await api('/batches', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input_file_id: file.id, endpoint: '/v1/responses', completion_window: '24h', metadata: { kind } }),
    }), '배치 만들기')).json() as { id: string };
    jobs.push({ id: batch.id, createdAt: now.toISOString(), count: lines.length });
    return batch.id;
  };
  const log: string[] = [];
  if (pick.length) {
    const lines: string[] = [];
    for (const [guid, item] of pick) {
      const req = articleRequest({ title: item.title, publishedAt: item.writtenAt, body: await bodyOf(repo, guid, item) });
      lines.push(JSON.stringify({ custom_id: `article:${guid}`, method: 'POST', url: '/v1/responses', body: openaiBody(BATCH_MODEL, req) }));
    }
    const id = await send('articles', lines);
    for (const [, item] of pick) item.jobId = id;
    await repo.putState(BATCH_STATE, queue);
    log.push(`배치 보냄 ${id}: 기사 ${pick.length}개 (${BATCH_MODEL}, 남은 대기 ${waiting.length - pick.length}개)`);
  }
  if (pickJudge.length) {
    const lines: string[] = [];
    for (const r of pickJudge) lines.push(JSON.stringify({ custom_id: `report:${r.id}`, method: 'POST', url: '/v1/responses', body: openaiBody(BATCH_JUDGE_MODEL, { ...(await judgeRequest(repo, r, now)), maxOutputTokens: 4000 }) }));
    const id = await send('reports', lines);
    for (const r of pickJudge) Object.assign(r, { batchJob: id, reviewReason: BATCH_WAIT_REASON });
    await repo.putState('reports', reports);
    log.push(`배치 보냄 ${id}: 소식 제보 판정 ${pickJudge.length}개 (${BATCH_JUDGE_MODEL}, 남은 대기 ${judge.length - pickJudge.length}개)`);
  }
  await repo.putState(BATCH_JOBS, jobs);
  return log;
}
