/**
 * 댄스 챌린지 분류: 쇼츠 제목만으로는 규칙으로 알기 어려워서("blue check #JAEMIN …") AI(nano)가 50개씩 판단한다.
 * 결과는 state/youtube/challenges 에 { 영상 id: { c: 챌린지인지, song: 노래 이름 } } 로 저장하고, 새 영상만 판단한다.
 */
import type { Budget } from './budget.ts';
import { callModel, hasLlmKey } from './llm.ts';
import type { Repo } from './repo.ts';
import { GROUP } from './group.ts';
import type { Video } from './youtube.ts';

export type ChallengeMap = Record<string, { c: boolean; song?: string }>;
const OWN = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));

/** 챌린지 후보: 공식 채널의 짧은 영상(90초 이하·길이 모름) + 챌린지 검색으로 찾은 다른 채널 영상 */
export const isChallengeCandidate = (v: Video) => (OWN.has(v.channel) && (v.duration === undefined || v.duration <= 90)) || Boolean(v.challengeSearch);

export async function classifyChallenges(repo: Repo, budget: Budget, videos: Video[]): Promise<string[]> {
  const map = await repo.getState<ChallengeMap>('youtube/challenges', {});
  const todo = videos.filter((v) => isChallengeCandidate(v) && !map[v.videoId]);
  if (!todo.length || !hasLlmKey()) return [];
  let added = 0;
  for (let i = 0; i < todo.length && budget.canSpend(); i += 50) {
    const batch = todo.slice(i, i + 50);
    const r = await callModel({
      model: 'gpt-5-nano', effort: 'low',
      instructions: [
        `${GROUP.name} 관련 짧은 영상 제목들이다. 번호마다 "댄스 챌린지"인지 판단한다.`,
        '- 댄스 챌린지: 노래 한 구간에 맞춰 춤추는 짧은 영상. 다른 가수와 함께 추는 것(with #가수), 다른 가수 노래 챌린지(루시퍼·Blue Check 등), 자기 노래 챌린지 모두 포함.',
        '- 아님: 일상·셀카·비하인드·브이로그·인사·예고·무대 클립·라이브 일부·음식·장난.',
        '- 챌린지면 song에 노래 이름(원래 표기, 예: Lucifer, Blue Check, Smoothie). 모르겠으면 null. 확신이 없으면 challenge=false.',
      ].join('\n'),
      input: batch.map((v, j) => `[${j}] ${v.channel} | ${v.title}`).join('\n'),
      schema: { name: 'challenges', schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'challenge', 'song'], properties: { i: { type: 'integer' }, challenge: { type: 'boolean' }, song: { type: ['string', 'null'] } } } } } } },
    }).catch(() => null);
    if (!r) continue;
    budget.record(r.usage.costUsd);
    const got = new Map((JSON.parse(r.value) as { items: { i: number; challenge: boolean; song: string | null }[] }).items.map((x) => [x.i, x]));
    batch.forEach((v, j) => {
      const x = got.get(j);
      const song = x?.song?.trim();
      map[v.videoId] = x?.challenge ? { c: true, ...(song && !/^(null|none|unknown|없음|미상)$/i.test(song) ? { song } : {}) } : { c: false };
      if (x?.challenge) added++;
    });
  }
  await repo.putState('youtube/challenges', map);
  return [`댄스 챌린지 분류: 새 영상 ${todo.length}개 중 챌린지 ${added}개`];
}
