/**
 * 질문 에이전트 (Node용): 저장소에서 자료를 읽어 askCore 에 넘긴다. 사이트용 묶음(ask-index)도 여기서 만든다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { askCore, supabaseVector, type AskData, type AskDoc, type AskResult } from './ask-core.ts';
import type { Budget } from './budget.ts';
import type { PublicEvent } from './consolidate.ts';
import { GROUP } from './group.ts';
import { callModel } from './llm.ts';
import type { JsonRepo } from './repo.ts';
import { ROOT } from './store.ts';

export type { AskResult } from './ask-core.ts';
const kst = (d: Date) => new Date(d.getTime() + 9 * 3600 * 1000);

/** 질문에 쓸 자료: 일정 + 공지 본문(이미지 속 글 포함) + 본문이 있는 기사 */
export async function loadAskData(repo: JsonRepo, opts: { articleDays?: number } = {}): Promise<AskData> {
  const docs: AskDoc[] = [];
  for (const n of await repo.listNotices()) {
    const body = await repo.getBody('notice', n.id);
    if (!body) continue;
    const image = (await repo.getBody('notice-image' as never, n.id)) ?? '';
    const posted = kst(new Date(n.postedAt)).toISOString();
    docs.push({ kind: 'notice', title: n.title, date: posted.slice(0, 10), time: posted.slice(11, 16), url: n.url, text: image ? `${body}\n${image}` : body });
  }
  const since = opts.articleDays ? new Date(Date.now() - opts.articleDays * 864e5).toISOString() : '2000-01-01T00:00:00Z';
  for (const a of await repo.listArticles(since)) {
    const body = await repo.getBody('article', a.guid);
    if (body) docs.push({ kind: 'article', title: a.title, date: a.publishedAt.slice(0, 10), url: a.link, text: body });
  }
  // 최근 영상 제목 (다른 채널의 출연·공항 영상): 출국 목적·출연 정보가 제목에 있다
  const { loadRecentVideos, originalAirDate, isFanMade } = await import('./youtube.ts');
  const own = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
  for (const v of await loadRecentVideos(new Date(), 160)) {
    // 공식 채널 영상은 제목만 (시리즈·커버·안무 영상 찾기), 다른 채널은 출연·공항 영상만
    if (own.has(v.channel)) {
      if (originalAirDate(v)) continue;
      const at0 = kst(new Date(v.publishedAt)).toISOString();
      docs.push({ kind: 'video', title: `${v.title} (${v.channel})`, date: at0.slice(0, 10), time: at0.slice(11, 16), url: v.url, text: v.title });
      continue;
    }
    if (!v.guest && !/출국|입국|공항|airport|departure/i.test(v.title)) continue;
    if (isFanMade(v.title)) continue;
    if (originalAirDate(v)) continue; // 지난 방송을 다시 올린 영상은 지금 소식이 아니다
    const at = kst(new Date(v.publishedAt)).toISOString();
    docs.push({ kind: 'video', title: `${v.title} (${v.channel})`, date: at.slice(0, 10), time: at.slice(11, 16), url: v.url, text: `${v.title}\n${(v.description ?? '').slice(0, 300)}` });
  }
  return {
    groupName: GROUP.name,
    members: GROUP.members.map((m) => m.name),
    watch: JSON.parse(readFileSync(join(ROOT, 'config', 'watch.json'), 'utf8')).watch,
    rules: { answer: JSON.parse(readFileSync(join(ROOT, 'config', 'ask-rules.json'), 'utf8')).answer },
    // 조회 도구용: 시리즈·종류별 모아보기 전체 (회차·영상 목록, 멤버)
    series: readdirSync(join(ROOT, 'data', 'public', 'series')).filter((f) => f.endsWith('.json')).map((f) => {
      const sr = JSON.parse(readFileSync(join(ROOT, 'data', 'public', 'series', f), 'utf8')) as { name: string; type: string; seasons: { name: string; videos: { title: string; date: string; url: string; members: string[]; ep: number | null }[] }[] };
      return { name: sr.name, type: sr.type, seasons: sr.seasons.map((s) => ({ name: s.name, videos: s.videos.map((v) => ({ title: v.title, date: v.date, url: v.url, members: v.members, ep: v.ep })) })) };
    }),
    memberAliases: Object.fromEntries(GROUP.members.map((m) => [m.name, m.aliases.filter((a) => a !== m.name)])),
    otherGroups: Object.fromEntries(GROUP.members.filter((m) => m.otherGroups?.length).map((m) => [m.name, m.otherGroups!])),
    programs: JSON.parse(readFileSync(join(ROOT, 'config', 'programs.json'), 'utf8')).programs,
    synonyms: JSON.parse(readFileSync(join(ROOT, 'config', 'ask-synonyms.json'), 'utf8')).synonyms,
    events: (JSON.parse(readFileSync(join(ROOT, 'data', 'public', 'events.json'), 'utf8')) as { events: PublicEvent[] }).events,
    docs,
  };
}

let cached: AskData | null = null;
export async function askQuestion(question: string, opts: { repo: JsonRepo; budget?: Budget; today?: string; model?: string; log?: (s: string) => void; history?: { q: string; a: string }[]; retrieval?: 'keyword' | 'hybrid' }): Promise<AskResult> {
  cached ??= await loadAskData(opts.repo);
  return askCore(question, cached, (o) => callModel(o), {
    today: opts.today, model: opts.model ?? process.env.ASK_MODEL, log: opts.log, history: opts.history,
    vector: opts.retrieval === 'keyword' ? undefined : supabaseVector(process.env), onCost: (usd) => opts.budget?.record(usd),
  });
}
