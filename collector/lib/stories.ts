/**
 * 소식 묶기 (소식 화면용): 제목 글자 겹침(cluster.ts)만으로는 같은 소식을 못 묶는 경우가 많다
 *  ("美 1위·日中 1위…석권" / "일본·중국 동시 정상" / 영어 "ILLIT and NCT DREAM both No. 1 on Hanteo").
 * 최근 7일 기사 중 아직 소식이 없는 것만 AI(무료 Groq 작은 모델, 막히면 nano)에게 "기존 소식 중 어디 / 새 소식"을 묻고 저장한다.
 * 한 번 정한 소식은 바꾸지 않아서 묶음이 실행마다 흔들리지 않는다. 상태: app_state 'feed/stories' = { 기사 guid: 소식 id }
 */
import { createHash } from 'node:crypto';
import type { Budget } from './budget.ts';
import { callModel, hasLlmKey } from './llm.ts';
import type { ArticleRecord, Repo } from './repo.ts';

const DAY = 864e5;
const kst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');

export async function assignStories(repo: Repo, articles: ArticleRecord[], now: Date, budget: Budget): Promise<Map<string, string>> {
  const map = await repo.getState<Record<string, string>>('feed/stories', {});
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const recent = articles.filter((a) => a.publishedAt >= since).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const todo = recent.filter((a) => !map[a.guid]);
  if (todo.length && hasLlmKey() && budget.canSpend()) {
    for (let i = 0; i < todo.length; i += 60) {
      const batch = todo.slice(i, i + 60);
      // 기존 소식: 최근 7일에 이미 정해진 소식마다 대표 제목 하나
      const existing = new Map<string, string>();
      for (const a of recent) if (map[a.guid] && !existing.has(map[a.guid])) existing.set(map[a.guid], `${kst(a.publishedAt)} | ${a.title}`);
      const ids = [...existing.keys()];
      const r = await callModel({
        model: 'gpt-5-nano', effort: 'low',
        instructions: [
          '아이돌 관련 기사 제목을 "같은 소식"끼리 묶는다.',
          '- 같은 소식: 같은 사건·발표를 다른 언론사가 쓴 것 (같은 주의 같은 차트 순위, 같은 날 같은 공항 출국·입국, 같은 화보·광고 공개, 같은 방송 출연 등). 영어 기사도 내용이 같으면 같은 소식.',
          '- 다른 소식: 주제만 비슷한 다른 사건 (다른 주의 차트, 다른 날 출국, 다른 프로그램).',
          '- 새 기사마다 story에 기존 소식 번호(S1 등)를 넣거나, 기존에 없으면 새 소식 이름(N1, N2 …)을 넣는다. 새 기사끼리 같은 소식이면 같은 N 이름.',
        ].join('\n'),
        input: `기존 소식:\n${ids.map((id, k) => `S${k + 1} | ${existing.get(id)}`).join('\n') || '(없음)'}\n\n새 기사:\n${batch.map((a, k) => `[${k}] ${kst(a.publishedAt)} | ${a.title}`).join('\n')}`,
        schema: { name: 'stories', schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'story'], properties: { i: { type: 'integer' }, story: { type: 'string' } } } } } } },
      }).catch(() => null);
      if (!r) break;
      budget.record(r.usage.costUsd);
      const fresh = new Map<string, string>();
      for (const it of (JSON.parse(r.value) as { items: { i: number; story: string }[] }).items) {
        const a = batch[it.i];
        if (!a) continue;
        const s = it.story.trim().toUpperCase();
        const old = /^S(\d+)$/.exec(s);
        if (old && ids[Number(old[1]) - 1]) map[a.guid] = ids[Number(old[1]) - 1];
        else {
          if (!fresh.has(s)) fresh.set(s, `st-${createHash('sha1').update(a.guid).digest('hex').slice(0, 10)}`);
          map[a.guid] = fresh.get(s)!;
        }
      }
      // 답에서 빠진 기사는 혼자인 소식
      for (const a of batch) map[a.guid] ??= `st-${createHash('sha1').update(a.guid).digest('hex').slice(0, 10)}`;
    }
    // 오래된 기록은 지운다 (30일)
    const keep = new Set(articles.filter((a) => a.publishedAt >= new Date(now.getTime() - 30 * DAY).toISOString()).map((a) => a.guid));
    for (const g of Object.keys(map)) if (!keep.has(g)) delete map[g];
    await repo.putState('feed/stories', map);
  }
  return new Map(Object.entries(map));
}
