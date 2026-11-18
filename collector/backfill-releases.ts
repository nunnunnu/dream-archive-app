/**
 * 타이틀곡별 과거 자료 채우기 (한 번 돌리면 된다. 이미 찾은 곡은 건너뜀)
 *   유튜브: "NCT DREAM <곡>"을 MV 공개 2주 전부터 두 달 동안 검색 → 음방 무대·출연·라이브 영상 (검색 1번 = 할당량 100)
 *   기사:   같은 기간 구글 뉴스 → 지난 기사라 AI로 해석하지 않고 활동 페이지의 기사 목록으로만 쓴다
 * 사용: npm run backfill:releases [-- --limit 10]
 */
import './lib/env.ts';
import { searchName, type Release } from './lib/discography.ts';
import { GROUP } from './lib/group.ts';
import { searchGoogleNews } from './lib/googleNews.ts';
import { isDreamRelated, stripPublisher } from './lib/news.ts';
import { JsonRepo, type ArticleRecord } from './lib/repo.ts';
import { readJson } from './lib/store.ts';
import { isOutsideCandidate, parseDuration, storeVideos, STAGE_RE, type Video } from './lib/youtube.ts';

const repo = new JsonRepo();
const OFFICIAL = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.id));
const { releases } = await readJson<{ releases: Release[] }>('public/discography.json', { releases: [] });
const done = await repo.getState<Record<string, string>>('backfill/releases', {});
const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 99);
const key = process.env.YOUTUBE_API_KEY!;
const yt = async (path: string, params: Record<string, string>) => {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`);
  if (!res.ok) throw new Error(`YouTube ${path} ${res.status}`);
  return res.json() as Promise<any>;
};
const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const day = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const now = new Date();
const subsCache = new Map<string, number>();

let n = 0;
for (const r of releases) {
  if (done[r.song] || n >= limit) continue;
  n++;
  const name = searchName(r.song);
  const who = r.owner.scope === '유닛' ? r.owner.label : GROUP.name;
  const after = day(r.date, -14);
  const before = day(r.date, 60);

  // 유튜브
  const s = await yt('search', { part: 'snippet', type: 'video', q: `${who} ${name}`, order: 'relevance', maxResults: '50', publishedAfter: `${after}T00:00:00Z`, publishedBefore: `${before}T00:00:00Z`, regionCode: 'KR' });
  const ids: string[] = s.items.map((x: any) => x.id.videoId);
  let saved = 0;
  if (ids.length) {
    const full = await yt('videos', { part: 'snippet,contentDetails', id: ids.join(',') });
    const chIds: string[] = [...new Set<string>(full.items.map((x: any) => x.snippet.channelId as string))].filter((c) => !subsCache.has(c));
    if (chIds.length) for (const c of (await yt("channels", { part: "statistics", id: (chIds as string[]).join(",") })).items) subsCache.set(c.id, Number(c.statistics.subscriberCount ?? 0));
    const list: Video[] = full.items
      .filter((x: any) => isDreamRelated(`${x.snippet.title} ${x.snippet.description}`) && sq(`${x.snippet.title} ${x.snippet.description}`).includes(sq(name)))
      .map((x: any) => {
        const subs = subsCache.get(x.snippet.channelId) ?? 0;
        const title = x.snippet.title as string;
        return {
          videoId: x.id, title, url: `https://www.youtube.com/watch?v=${x.id}`, channel: x.snippet.channelTitle, publishedAt: x.snippet.publishedAt,
          who: { scope: r.owner.scope, members: r.owner.members, label: r.owner.label }, firstSeenAt: now.toISOString(),
          description: x.snippet.description, duration: parseDuration(x.contentDetails.duration), channelSubscribers: subs,
          // 지난 출연 영상은 아카이브용 (AI로 일정을 만들지 않는다: 오래된 영상은 처리 대상 기간 밖)
          // 공식 채널 영상은 출연이 아니다 (storeVideos 에서도 막는다)
          guest: !OFFICIAL.has(x.snippet.channelId) && !STAGE_RE.test(title) && isOutsideCandidate(title, x.snippet.description, subs),
        } as Video;
      });
    saved = (await storeVideos(list)).length;
  }

  // 기사 (AI 해석 없이 기록만)
  const items = await searchGoogleNews(`"${who}" "${name}" after:${after} before:${before}`).catch(() => []);
  const known = new Set((await repo.listArticles('2000-01-01T00:00:00Z')).map((a) => a.guid));
  const arts: ArticleRecord[] = items
    .filter((it) => !known.has(it.guid))
    .map((it) => ({ guid: it.guid, title: stripPublisher(it.title, it.source), link: it.link, source: it.source, publishedAt: it.publishedAt.toISOString(), firstSeenAt: now.toISOString(), origin: 'search' as const, status: 'skipped' as const, note: `지난 기사 (${r.song})` }))
    .filter((a) => isDreamRelated(a.title) || sq(a.title).includes(sq(name)));
  if (arts.length) await repo.putArticles(arts);
  done[r.song] = now.toISOString();
  await repo.putState('backfill/releases', done);
  console.log(`${r.date} ${r.song.padEnd(28)} 유튜브 ${String(s.items.length).padStart(2)}개 중 저장 ${String(saved).padStart(2)} | 기사 ${arts.length}`);
  await new Promise((res) => setTimeout(res, 1200));
}
console.log(`검색한 곡 ${n}개 (유튜브 할당량 약 ${n * 102})`);
