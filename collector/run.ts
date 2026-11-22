/**
 * 전체 수집 한 번 돌리기 (GitHub Actions가 15분마다 실행)
 *
 *  ① 수집       위버스 공지 · 기사(구글 뉴스) · 유튜브 · 팬 글 키워드 · 빈칸 채우기 검색 · 제보
 *  ② 처리       공지 본문 · 같은 소식 대표 기사 본문 · 제보 글 → AI 일정 추출 → 원문 대조
 *  ③ 합치기     여러 출처의 같은 일정을 하나로, 반복 방송은 회차로, 날짜 미정은 따로
 *  ④ 빈칸 채우기 비어 있는 시간·날짜·관련 일정을 찾을 검색 → 바로 한 번 더 ①~③ (최대 2바퀴)
 *  ⑤ 내보내기   data/public/ (사이트·캘린더 구독용)
 *
 * 실행 방식 두 가지 (GitHub Actions에서 나눠 돌린다)
 *   빠른 실행 (15분마다)  npm run collect -- --fast
 *       위버스 공지 · 제보 · 등록 채널 영상 · 영상 공개 시각 확인 → 새 문서만 AI → 합치기·내보내기 (한 바퀴)
 *   전체 실행 (1시간마다) npm run collect
 *       위 + 기사 수집·해석 · 유튜브 출연 탐색(6시간마다) · 빈칸 채우기 검색 (최대 2바퀴)
 * AI는 처음 보는 문서(또는 본문이 바뀐 문서)만 부른다. 한 번 해석한 문서는 저장해 두고 다시 부르지 않는다.
 *
 * 사용: npm run collect
 *       npm run collect -- --fast                                  (빠른 실행)
 *       npm run collect -- --articles-days=14 --notices-days=90   (처리할 기간)
 *       npm run collect -- --backfill                              (위버스 공지 과거 자료 채우기)
 *       npm run collect -- --publish-only                          (수집·AI 없이 합치기·내보내기만)
 */
import { assignStories } from './lib/stories.ts';
import { leadsWithGroup } from './lib/publish.ts';
import { stripBroadcaster } from './lib/broadcasters.ts';
import { chromium } from 'playwright';
import { Budget } from './lib/budget.ts';
import { GROUP, GROUP_NAME_RE } from './lib/group.ts';
import { clusterArticles } from './lib/cluster.ts';
import { consolidate, type PendingItem, type PublicEvent, type ReviewItem, type RumorItem } from './lib/consolidate.ts';
import { extractKeywords } from './lib/fanKeywords.ts';
import { markFillDone, planFill } from './lib/fill.ts';
import { buildItems, itemsFromGuestVideos, itemsFromOfficialVideos } from './lib/items.ts';
import { NEWS_QUERIES, collectArticles, isDreamRelated, type NewsQuery } from './lib/news.ts';
import { processArticles, processNotices, processVideos } from './lib/process.ts';
import { buildFeed, publishAll } from './lib/publish.ts';
import { JsonRepo } from './lib/repo.ts';
import { processSubmissions } from './lib/submissions.ts';
import { Tagger } from './lib/tags.ts';
import { buildEraPages, siteConfig } from './lib/eras.ts';
import { localizeEvents } from './lib/timezones.ts';
import { linkTrailers } from './lib/trailers.ts';
import { stabilizeEraIds } from './lib/eraIds.ts';
import { orderSources } from './lib/sourceOrder.ts';
import { addReleases, findActivities } from './lib/activities.ts';
import { buildDiscography } from './lib/discography.ts';
import { buildSeries } from './lib/series.ts';
import { applyOverrides, loadOverrides, mergeOverrides, type Overrides } from './lib/overrides.ts';
import { finalizeReports, pullReports, queueReports, type Report } from './lib/reports.ts';
import { judgeDeleteReports } from './lib/reportDelete.ts';
import { isHidden } from './lib/members.ts';
import { transcribeNoticeImages } from './lib/noticeImages.ts';
// 커뮤니티(더쿠) 수집은 비공개 레포에만 있다. 파일이 없으면(공개 레포) 건너뛴다
const community = await import('./lib/theqoo.ts').catch(() => null);
const communityFeed: (r: typeof repo) => Promise<never[]> = community ? (community.communityFeed as never) : async () => [];
import { readOpenNotice } from './lib/weverse.ts';
import { itemsFromTracked, loadTracked, syncTracked } from './lib/tracked.ts';
import { kstDate, toKstParts } from './lib/time.ts';
import { collectWeverse } from './lib/weverseCollect.ts';
import { checkAvailability, collectVideos, discoverVideos, searchActivityVideos, unavailableVideoIds, isAppearance, isArchiveClip, loadRecentVideos, refreshVideoTimes, searchVideos } from './lib/youtube.ts';

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const ARTICLES_DAYS = arg('articles-days', 14);
const NOTICES_DAYS = arg('notices-days', 90);
const backfill = process.argv.includes('--backfill');
const fast = process.argv.includes('--fast');
// 며칠 비웠을 때 따라잡기: 기사 검색 기간, 더쿠 스퀘어 페이지 수
const NEWS_DAYS = arg('news-days', 2);
const COMMUNITY_PAGES = arg('community-pages', 1);

const repo = new JsonRepo();
const now = new Date();
const p = toKstParts(now);
const today = kstDate(p.year, p.month, p.day);
const budget = await new Budget(repo, now).load();
let reports: Record<string, Report> = {};
const started = Date.now();
let stepAt = started;
const elapsed = (from: number) => `${((Date.now() - from) / 1000).toFixed(0)}초`;
const step = (s: string) => {
  if (stepAt !== started) console.log(`   (${elapsed(stepAt)})`);
  stepAt = Date.now();
  console.log(`\n── ${s}`);
};

async function consolidateAndPublish(): Promise<{ events: PublicEvent[]; pending: PendingItem[]; rumors: RumorItem[]; review: ReviewItem[] }> {
  const videos = await loadRecentVideos(now, 2);
  const guestVideoIds = new Set(
    videos.filter((v) => v.guest && isAppearance(v.title, v.description ?? '') && !isArchiveClip(v.title, v.description ?? '', v.publishedAt)).map((v) => v.videoId),
  );
  const { items, ruleNotices } = await buildItems(repo, { guestVideoIds });
  const interpreted = new Set((await repo.listExtractions('video')).map((x) => x.docId));
  const related = videos.filter((v) => isDreamRelated(`${v.title} ${v.description ?? ''}`));
  const trustedVideoUrls = new Set(videos.filter((v) => v.guest && (v.channelSubscribers ?? 0) >= 300_000).map((v) => v.url));
  // 공식 채널 MV·티저·트레일러·자컨 회차 (최근 6개월, 그 전은 아카이브 페이지의 영상 목록으로 충분)
  const ownChannels = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
  const officialItems = itemsFromOfficialVideos((await loadRecentVideos(now, 6)).filter((v) => ownChannels.has(v.channel) && (v.channel === GROUP.name || isDreamRelated(v.title))), ownChannels, GROUP_NAME_RE);
  const { events, pending, rumors, review } = consolidate([...items, ...itemsFromGuestVideos(videos, interpreted), ...officialItems, ...itemsFromTracked(await loadTracked(repo))], { today, videos: related, trustedVideoUrls, seriesVideos: videos });
  // 삭제 제보 자동 판정 (확실할 때만 숨기기에 추가, 같은 실행부터 적용)
  for (const l of await judgeDeleteReports(repo, reports, events, budget, now)) console.log(l);
  // 운영자가 승인한 삭제·보완 제보 (config/overrides.json)
  const reportOverrides = await repo.getState<Overrides>('report-overrides', { hide: [], patch: [] });
  const ov = applyOverrides(events, mergeOverrides(loadOverrides(), reportOverrides));
  // 비공개·삭제된 영상은 일정 출처에서 뺀다 (출처가 그것뿐이면 일정은 남기고 링크만 없앤다)
  const gone = await unavailableVideoIds();
  for (const e of events) e.sources = e.sources.filter((s) => !gone.has(s.url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/)?.[1] ?? ''));
  const tr = linkTrailers(events);
  if (tr.merged || tr.renamed) console.log(`트레일러 잇기: 합침 ${tr.merged}개, 이름 맞춤 ${tr.renamed}개`);
  const tz = localizeEvents(events);
  const durations = new Map((await loadRecentVideos(now, 6)).map((v) => [v.videoId, v.duration]));
  orderSources(events, (u) => durations.get(u.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/)?.[1] ?? ''));
  if (tz.fixed.length) console.log(`해외 시간대 정리 ${tz.fixed.length}개`);
  if (ov.hidden || ov.patched) console.log(`제보 반영: 숨김 ${ov.hidden}개, 고침 ${ov.patched}개`);
  const tracked = await syncTracked(repo, events, today, now);
  const notices = (await repo.listNotices()).filter((n) => !isHidden(n.title));
  const archiveVideos = await loadRecentVideos(now, 12);
  const yearArticles = await repo.listArticles(new Date(now.getTime() - 365 * 24 * 3600 * 1000).toISOString());
  // 최근 7일은 AI가 정한 "같은 소식"으로 묶음끼리 다시 합친다 (제목 글자만으론 못 묶는 경우: 표현이 다르거나 영어 기사)
  const stories = await assignStories(repo, yearArticles, now, budget);
  const merged = new Map<string, ReturnType<typeof clusterArticles>[number]>();
  for (const c of clusterArticles(yearArticles)) {
    const votes = c.articles.map((a) => stories.get(a.guid)).filter(Boolean) as string[];
    const key = votes.length ? votes.sort((x, y) => votes.filter((v) => v === y).length - votes.filter((v) => v === x).length)[0] : c.id;
    const m = merged.get(key);
    if (m) m.articles.push(...c.articles); else merged.set(key, { ...c, articles: [...c.articles] });
  }
  const clusters = [...merged.values()].map((c) => {
    // 대표 기사: 드림·멤버가 제목 앞에 오는 기사 중 가장 먼저 나온 것 (없으면 가장 먼저 나온 기사)
    const byTime = [...c.articles].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    const first = byTime.find((a) => leadsWithGroup(a.title)) ?? byTime[0];
    const resolved = c.articles.find((a) => a.originalUrl) ?? first;
    const pictured = c.articles.find((a) => a.image);
    // 매체별 기사 (같은 매체는 하나만, 시간순, 최대 8개): 소식 화면에서 묶음을 펼쳐 볼 때
    const seenPub = new Set<string>();
    const articles = [...c.articles].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
      .filter((a) => (seenPub.has(a.source) ? false : (seenPub.add(a.source), true))).slice(0, 8)
      .map((a) => ({ title: a.title, url: a.originalUrl ?? a.link, publisher: a.source, publishedAt: a.publishedAt }));
    return { title: first.title, url: resolved.originalUrl ?? first.link, image: pictured?.image, publishedAt: first.publishedAt, publisher: first.source, count: c.articles.length, articles };
  });
  // 모아보기 태그
  const tagger = new Tagger({ videoTitles: archiveVideos.map((v) => v.title), tracked });
  for (const e of [...events, ...review]) e.tags = tagger.event(e);
  const feed = buildFeed(notices, clusters, archiveVideos, now, await communityFeed(repo));
  // 비공개·삭제된 영상을 가리키는 소식(커뮤니티 글의 유튜브 링크 포함)은 뺀다
  const goneIds = await unavailableVideoIds();
  for (let i = feed.length - 1; i >= 0; i--) if ([...goneIds].some((id) => JSON.stringify(feed[i]).includes(id))) feed.splice(i, 1);
  for (const f of feed) f.tags = tagger.feed(f);
  const tags = tagger.index([...events.map((e) => e.tags ?? []), ...feed.map((f) => f.tags ?? [])]);
  const changes = await publishAll(repo, { events, pending, rumors, review, feed, tags }, now);
  // 활동(컴백·투어) 페이지 데이터
  // 활동 자동 묶기: 작품 이름 어휘 = 제목의 따옴표·괄호 속 이름 + 고정 출연 + 모아보기 작품 태그
  const allArticles = await repo.listArticles('2000-01-01T00:00:00Z');
  const acts = findActivities(events, [
    ...tracked.map((t) => stripBroadcaster(t.title).split(/\s*[:：]\s*/)[0]),
    ...tagger.projectNames(),
  ], allArticles);
  // 진행 중인 드라마는 다음 실행 때 이름으로 유튜브를 검색한다 (예고·클립·OST: 그룹 이름 없이 올라옴)
  await repo.putState('youtube/activity-queries', acts
    .filter((a) => a.kind === '드라마' && today >= new Date(Date.parse(a.from) - 14 * 864e5).toISOString().slice(0, 10) && today <= new Date(Date.parse(a.to) + 7 * 864e5).toISOString().slice(0, 10))
    .map((a) => ({ id: a.id, q: [...a.keys].sort((x, y) => x.length - y.length)[0], from: a.from, to: a.to })));
  // 디스코그래피(공식 MV)로 예전 컴백도 활동으로
  const allVideos = await loadRecentVideos(now, 160);
  const releases = buildDiscography(allVideos);
  addReleases(acts, releases, allArticles);
  await repo.publish('discography.json', { releases });
  const keptIds = await stabilizeEraIds(repo, acts);
  if (keptIds) console.log(`활동 주소 유지 ${keptIds}개`);
  const eras = buildEraPages(events, allVideos, acts, today, allArticles);
  for (const era of eras) await repo.publish(`eras/${era.id}.json`, era);
  await repo.publish('eras.json', { eras: eras.map(({ official, stages, fancams, related, own, shorts, outside, timeline, schedule, ownGroups, news, guide, ...rest }) => ({ ...rest, guideCount: guide?.length ?? 0 })) });
  // 시리즈: 자체 콘텐츠 시리즈 · 종류별 모아보기 · 고정 출연 · 반복 활동
  const series = buildSeries(await loadRecentVideos(now, 130), events, acts, eras);
  for (const sr of series) await repo.publish(`series/${sr.id}.json`, sr);
  await repo.publish('series.json', { series: series.map(({ seasons, episodes, activities, ...rest }) => rest) });
  // 목록에 없는 지난 파일은 지운다 (주소가 바뀐 활동의 옛 파일이 남아 옛 내용이 보이지 않게)
  {
    const { readdirSync, rmSync, existsSync } = await import('node:fs');
    const { DATA_DIR } = await import('./lib/store.ts');
    for (const [dir, ids] of [['eras', new Set(eras.map((e) => e.id))], ['series', new Set(series.map((x) => x.id))]] as const) {
      const path = `${DATA_DIR}/public/${dir}`;
      if (!existsSync(path)) continue;
      for (const f of readdirSync(path)) if (f.endsWith('.json') && !ids.has(f.slice(0, -5).normalize('NFC'))) rmSync(`${path}/${f}`);
    }
  }
  // 사이트가 쓰는 설정 (사이트 코드에 그룹·멤버·활동 이름을 적지 않도록)
  await repo.publish('site.json', siteConfig());
  console.log(`일정 ${events.length}개 (문서 ${items.length}건에서, 규칙 방식 공지 ${ruleNotices}개), 확인 대기 ${review.length}개, 날짜 미정 ${pending.length}개, 추측·예고 ${rumors.length}개`);
  const line = (x: { date: string; time: string | null; title: string; step: string }) => `${x.date} ${x.time ?? '시간 미정'} ${x.title} · ${x.step}`;
  for (const x of changes.added) console.log(`  + ${line(x)}`);
  for (const x of changes.removed) console.log(`  - ${line(x)}`);
  for (const x of changes.changed) console.log(`  ~ ${x.title} · ${x.step}: ${x.from} → ${x.to}`);
  const active = tracked.filter((t) => t.status === 'active');
  if (active.length) console.log(`추적 중인 고정 출연: ${active.map((t) => `${t.title}(${t.weekdays.join('')} ${t.time ?? '시간?'}${t.episodes ? `, ${t.episodes}부작` : ''})`).join(', ')}`);
  return { events, pending, rumors, review };
}

if (process.argv.includes('--publish-only')) {
  step('합치기 · 내보내기만');
  await consolidateAndPublish();
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
try {
  const pulled = await pullReports(repo).catch((err) => {
    console.log(`제보 가져오기 실패: ${(err as Error).message}`);
    return { reports: {}, fetched: 0 };
  });
  reports = pulled.reports;
  const queuedReports = await queueReports(repo, reports, now);
  if (pulled.fetched || queuedReports) console.log(`사이트 제보: 가져옴 ${pulled.fetched}개 · 자동 검증 대기 ${queuedReports}개`);
  step('① 수집');
  const weverse = await collectWeverse(repo, page, now, { backfill });
  for (const l of weverse.log) console.log(l);
  {
    const all = await repo.listNotices();
    const since = new Date(now.getTime() - NOTICES_DAYS * 24 * 3600 * 1000).toISOString();
    const recent = all.filter((n) => n.postedAt >= since && !isHidden(n.title));
    let checked = 0;
    for (const n of recent.filter((x) => !x.images).slice(0, 10)) {
      await page.goto(n.url, { waitUntil: 'domcontentloaded' });
      n.images = (await readOpenNotice(page, now).catch(() => null))?.images ?? [];
      checked++;
    }
    if (checked) await repo.putNotices(all);
    const shot = await browser.newPage();
    for (const l of await transcribeNoticeImages(repo, shot, budget, recent)) console.log(l);
    // 팬 커뮤니티(더쿠 스퀘어): 공식 SNS 소식 재게시
    if (community) for (const l of await community.collectCommunity(repo, shot, budget, now, { pages: COMMUNITY_PAGES, readDays: Math.max(3, NEWS_DAYS), maxRead: 12 * COMMUNITY_PAGES })) console.log(l);
    await shot.close();
  }

  if (fast) {
    // 빠른 실행(15분마다): 위버스 하이라이트·공지와 사이트 제보만. 유튜브·기사는 매시 전체 실행에서
    step('② 처리 (새 공지·제보만)');
    for (const l of await processNotices(repo, budget, now, { sinceDays: NOTICES_DAYS })) console.log(l);
    for (const l of await processSubmissions(repo, page, budget, now)) console.log(l);
    const moderation = await finalizeReports(repo, reports, now);
    if (moderation.approved) console.log(`제보 자동 승인 ${moderation.approved}개 · 확인 대기 ${moderation.pending}개`);
    step('③ 합치기 · 내보내기');
    await consolidateAndPublish();
  }

  if (!fast) {
    const fanQueries: NewsQuery[] = [...new Set(weverse.fanPostTexts.flatMap((t) => extractKeywords(t).slice(0, 2)))]
      .slice(0, 6)
      .map((kw) => ({ q: `${GROUP.name} ${kw}`, days: 3 }));
    const queued = await repo.getState<{ news: NewsQuery[]; youtube: { focus: string; after: string }[] }>('fillQueue', { news: [], youtube: [] });
    const doneKeys = new Set<string>();
    const added = await collectArticles(repo, [...NEWS_QUERIES.map((q) => ({ ...q, days: NEWS_DAYS })), ...fanQueries, ...queued.news], now, (q) => q.fillKey && doneKeys.add(q.fillKey));
    await markFillDone(repo, doneKeys, now);
    console.log(`기사 새로 ${added.length}개 (팬 글 화제 검색 ${fanQueries.length}개, 빈칸 채우기 검색 ${queued.news.length}개)`);

    const yt = await collectVideos(now);
    const guest = await discoverVideos(repo, now).catch((err) => {
      console.log(`유튜브 출연 탐색 실패: ${(err as Error).message}`);
      return { added: [], ran: false };
    });
    const avail = await checkAvailability(repo, now).catch((err) => { console.log(`영상 공개 여부 확인 실패: ${(err as Error).message}`); return null; });
    if (avail) console.log(`영상 공개 여부 확인 ${avail.checked}개: 비공개·삭제 ${avail.gone.length}개${avail.gone.length ? ` (${avail.gone.slice(0, 3).map((v) => v.title.slice(0, 20)).join(', ')}…)` : ''}${avail.back ? `, 다시 공개 ${avail.back}개` : ''}`);
    const actVids = await searchActivityVideos(repo, now).catch((err) => { console.log(`드라마 영상 검색 실패: ${(err as Error).message}`); return []; });
    if (actVids.length) console.log(`드라마 영상 검색: 새 영상 ${actVids.length}개`);
    if (guest.ran) console.log(`유튜브 출연 탐색: 새 출연 영상 ${guest.added.length}개${guest.added.length ? ` (${guest.added.slice(0, 5).map((v) => v.channel).join(', ')}…)` : ''}`);
    let ytFound = 0;
    for (const y of queued.youtube) ytFound += (await searchVideos(y.focus, new Date(y.after), now).catch(() => [])).length;
    for (const l of await refreshVideoTimes(now).catch((err) => [`영상 공개 시각 확인 실패: ${(err as Error).message}`])) console.log(l);
    console.log(`유튜브 새 영상 ${yt.added.length}개${ytFound ? `, 빈칸 채우기 검색으로 ${ytFound}개` : ''}${yt.failed.length ? ` (실패: ${yt.failed.length}개 채널)` : ''}`);
  }

  for (let pass = 1; !fast && pass <= 2; pass++) {
    step(`② 처리${pass > 1 ? ' (빈칸 채우기 결과)' : ''}`);
    for (const l of await processNotices(repo, budget, now, { sinceDays: NOTICES_DAYS })) console.log(l);
    for (const l of await processSubmissions(repo, page, budget, now)) console.log(l);
    const moderation = await finalizeReports(repo, reports, now);
    if (moderation.approved) console.log(`제보 자동 승인 ${moderation.approved}개 · 확인 대기 ${moderation.pending}개`);
    for (const l of await processVideos(repo, budget, now)) console.log(l);
    const newPage = () => browser.newPage({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    for (const l of await processArticles(repo, newPage, budget, now, { windowDays: ARTICLES_DAYS, concurrency: 6 })) console.log(l);

    step('③ 합치기 · 내보내기');
    const { events, pending, rumors, review } = await consolidateAndPublish();

    step('④ 빈칸 채우기');
    const plan = await planFill(repo, events, pending, now, await loadTracked(repo), rumors, review, budget);
    console.log(`검색 계획: 기사 ${plan.news.length}개, 유튜브 ${plan.youtube.length}개`);
    if (pass === 2 || (!plan.news.length && !plan.youtube.length)) {
      // 남은 계획은 다음 실행 때
      await repo.putState('fillQueue', { news: plan.news, youtube: plan.youtube.map((y) => ({ focus: y.focus, after: y.after.toISOString() })) });
      break;
    }
    const fillDone = new Set<string>();
    const more = await collectArticles(repo, plan.news, now, (q) => q.fillKey && fillDone.add(q.fillKey));
    await markFillDone(repo, fillDone, now);
    let moreYt = 0;
    for (const y of plan.youtube) moreYt += (await searchVideos(y.focus, y.after, now).catch(() => [])).length;
    console.log(`빈칸 채우기로 기사 ${more.length}개, 영상 ${moreYt}개`);
    await repo.putState('fillQueue', { news: [], youtube: [] });
    if (!more.length && !moreYt) break;
  }
} finally {
  await browser.close();
  await budget.save();
  console.log(`   (${elapsed(stepAt)})\n\n${budget.summary()} · 전체 ${elapsed(started)}`);
}
