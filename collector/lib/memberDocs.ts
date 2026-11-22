/**
 * 멤버 문서(그룹 + 멤버 6명)와 아카이브 첫 화면 요약: members.json.
 *  - 프로필: config/group.json(본명·소속·포지션) + config/anniversaries.json(생일·데뷔일)
 *  - 사진: 등록 채널의 최신 멤버 직캠 영상 썸네일 (사진을 다시 올리지 않고, 누르면 그 영상으로)
 *  - 연표·컴백/투어·예능/자컨·화보/광고·최근 소식: 이미 만든 활동·시리즈·소식에서 멤버로 거른다
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicEvent } from './consolidate.ts';
import type { EraPage } from './eras.ts';
import { GROUP } from './group.ts';
import type { FeedItem } from './publish.ts';
import { ROOT } from './store.ts';
import type { Video } from './youtube.ts';

interface SeriesLite { id: string; type: string; name: string; count: number; from: string; to: string; thumb?: string; members: string[] }
const ANNIV = JSON.parse(readFileSync(join(ROOT, 'config', 'anniversaries.json'), 'utf8')) as { items: { date: string; title: string; member?: string; born?: string }[] };
const FANCAM_RE = /focus|직캠|fancam|facecam|페이스캠|얼빡/i;
const STAGE = new Set([...GROUP.youtube.channels.map((c) => c.name), ...(GROUP.youtube.stageChannels ?? [])]);
/** 채널별 직캠 썸네일 구도: 얼굴이 있는 가로 위치 (MBC 음중직캠은 왼쪽 자막·오른쪽 얼굴). 없으면 가운데 */
const THUMB_FOCUS: Record<string, number> = { MBCkpop: 80 };
const LATIN = (aliases: string[]) => aliases.find((a) => /^[A-Z][A-Z\s]+$/.test(a)) ?? '';

export interface MemberDoc {
  slug: string; name: string; en: string; kind: '그룹' | '멤버';
  realName?: string; position?: string; birthday?: string; born?: string; debut?: string; groups: string[];
  photo?: { thumb: string; url: string; title: string; focus?: number };
  timeline: { year: string; items: { date: string; kind: string; title: string; eraId: string; owner: string }[] }[];
  eras: string[];
  variety: { id: string; name: string; type: string; count: number; to: string }[];
  appearances: { date: string; title: string; step: string; url?: string }[];
  pictorial: { title: string; url: string; image?: string; date: string; publisher?: string; topic?: string }[];
  news: { title: string; url: string; date: string; publisher?: string; topic?: string; type: string; image?: string }[];
}

export function buildMemberDocs(input: { events: PublicEvent[]; eras: EraPage[]; series: SeriesLite[]; feed: FeedItem[]; videos: Video[] }) {
  const { events, eras, series, feed, videos } = input;
  const byDateDesc = <T extends { date: string }>(a: T, b: T) => b.date.localeCompare(a.date);
  const latestFancam = (aliases: string[]) => videos
    .filter((v) => STAGE.has(v.channel) && FANCAM_RE.test(v.title) && aliases.some((a) => v.title.includes(a)) && !/shorts/i.test(v.title))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
  const doc = (slug: string, name: string, en: string, kind: MemberDoc['kind'], mine: (members: string[], owner?: EraPage['owner']) => boolean, extra: Partial<MemberDoc>): MemberDoc => {
    const myEras = eras.filter((e) => mine(e.owner.members, e.owner)).sort((a, b) => b.from.localeCompare(a.from));
    const years = [...new Set(myEras.map((e) => e.from.slice(0, 4)))].sort().reverse();
    const fan = kind === '멤버' ? latestFancam(GROUP.members.find((m) => m.name === name)!.aliases) : undefined;
    const groupThumb = myEras.find((e) => e.thumb)?.thumb;
    return {
      slug, name, en, kind, groups: [], ...extra,
      photo: fan ? { thumb: `https://i.ytimg.com/vi/${fan.videoId}/hqdefault.jpg`, url: fan.url, title: fan.title, focus: THUMB_FOCUS[fan.channel] } : groupThumb ? { thumb: groupThumb, url: `/archive/${myEras.find((e) => e.thumb)!.id}/`, title: myEras.find((e) => e.thumb)!.title } : undefined,
      timeline: years.map((y) => ({ year: y, items: myEras.filter((e) => e.from.startsWith(y)).map((e) => ({ date: e.from, kind: e.kind, title: e.title, eraId: e.id, owner: e.owner.label })) })),
      eras: myEras.filter((e) => e.kind === '컴백' || e.kind === '콘서트·투어' || e.kind === '팬미팅').map((e) => e.id),
      variety: series.filter((s) => (kind === '그룹' ? !s.members.length : s.members.includes(name)) && s.count > 0).sort((a, b) => b.to.localeCompare(a.to)).slice(0, 12).map((s) => ({ id: s.id, name: s.name, type: s.type, count: s.count, to: s.to })),
      appearances: events.filter((e) => e.kind === '방송' && mine(e.members) && !/음악중심|뮤직뱅크|인기가요|엠카운트다운|더 ?쇼|쇼챔피언/.test(e.title)).map((e) => ({ date: e.date, title: e.title, step: e.step, url: e.sources[0]?.url })).sort(byDateDesc).slice(0, 12),
      pictorial: feed.filter((f) => f.type === 'news' && (f.topic === '광고' || f.topic === '브랜드·화보') && !f.shared && mine(f.members)).map((f) => ({ title: f.title, url: f.url, image: f.image, date: f.publishedAt.slice(0, 10), publisher: f.publisher, topic: f.topic })).sort(byDateDesc).slice(0, 8),
      news: feed.filter((f) => f.type !== 'youtube' && mine(f.members)).map((f) => ({ title: f.title, url: f.url, date: f.publishedAt.slice(0, 10), publisher: f.publisher, topic: f.topic, type: f.type, image: f.shared ? undefined : f.image })).sort(byDateDesc).slice(0, 8),
    };
  };
  const debut = GROUP.debut;
  const group = doc('nctdream', GROUP.name, GROUP.name, '그룹', (members, owner) => !members.length || owner?.scope === '단체', { debut, groups: [GROUP.name] });
  const members = GROUP.members.map((m) => doc(m.slug, m.name, LATIN(m.aliases), '멤버',
    // 멤버 문서: 단체 활동 + 그 멤버가 들어간 유닛·솔로 활동
    (ms, owner) => owner ? (owner.scope === '단체' || owner.members.includes(m.name)) : ms.includes(m.name),
    {
      realName: m.realName, position: m.position || undefined, debut,
      birthday: ANNIV.items.find((a) => a.member === m.name)?.date,
      born: ANNIV.items.find((a) => a.member === m.name)?.born,
      groups: [GROUP.name, ...GROUP.units.filter((u) => u.members.includes(m.name)).map((u) => u.name), ...(m.otherGroups ?? [])],
    }));
  return { group, members };
}

/** 아카이브 첫 화면: 숫자 요약 + 공백기(최근 12달 중 컴백·투어가 없던 달) */
export function archiveSummary(events: PublicEvent[], eras: EraPage[], feed: FeedItem[], today: string) {
  const big = eras.filter((e) => e.kind === '컴백' || e.kind === '콘서트·투어');
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); months.push(d.toISOString().slice(0, 7)); }
  const offSeason = months.filter((ym) => !big.some((e) => e.from.slice(0, 7) <= ym && e.to.slice(0, 7) >= ym)).map((ym) => {
    const list = events.filter((e) => e.date.startsWith(ym) && e.audience === 'all' && e.category === '공식');
    const top = [...list].sort((a, b) => Number(b.kind === '행사') - Number(a.kind === '행사') || a.date.localeCompare(b.date)).slice(0, 3).map((e) => ({ date: e.date, title: e.title, kind: e.kind }));
    return { month: ym, count: list.length, top };
  });
  return {
    stats: { events: events.length, news: feed.filter((f) => f.type === 'news').length, comebacks: eras.filter((e) => e.kind === '컴백').length, tours: eras.filter((e) => e.kind === '콘서트·투어').length },
    offSeason,
  };
}
