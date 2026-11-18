/**
 * 저장된 추출 결과를 합치기 단계의 입력(ExtractedItem)으로 모은다.
 * AI 결과가 없는 공지는 규칙 방식(정규식)으로 대신한다 (키가 없거나 비용 상한에 걸렸을 때).
 */
import { similarTarget, type ExtractedItem, type SourceRef } from './consolidate.ts';
import { isSpecificFocus } from './news.ts';
import { mentionsGroup, NOTICE_PROMPT_VERSION } from './llm.ts';
import { noticeSource } from './noticeImages.ts';
import { isHidden, whoOfNotice } from './members.ts';
import type { Repo } from './repo.ts';
import { noticeTopic, parseScheduleFromBody, parseScheduleFromTitle } from './scheduleParser.ts';
import { kstDate, kstTime, toKstParts } from './time.ts';
import type { Video } from './youtube.ts';

export async function buildItems(repo: Repo, opts: { guestVideoIds?: Set<string> } = {}): Promise<{ items: ExtractedItem[]; ruleNotices: number }> {
  const items: ExtractedItem[] = [];
  let ruleNotices = 0;

  for (const n of await repo.listNotices()) {
    if (isHidden(n.title)) continue;
    const ext = await repo.getExtraction('notice', n.id);
    if (ext && ext.contentHash === (await noticeSource(repo, n)).hash && ext.promptVersion === NOTICE_PROMPT_VERSION) {
      for (const e of ext.checked) items.push({ ...e, source: ext.source, by: 'ai' });
      continue;
    }
    // AI 결과가 없으면 규칙 방식
    const body = await repo.getBody('notice', n.id);
    if (!body) continue;
    ruleNotices++;
    const source: SourceRef = { type: 'weverse-notice', id: n.id, url: n.url, title: n.title, publishedAt: n.postedAt };
    const members = whoOfNotice(n.title).members;
    const parsed = [parseScheduleFromTitle(n.title, n.postedAt), ...parseScheduleFromBody(body, n.postedAt, n.title)].filter(Boolean);
    for (const p of parsed) {
      items.push({
        date: p!.date,
        time: p!.time ?? null,
        end_date: p!.endDate ?? null,
        end_time: p!.endTime ?? null,
        timezone: p!.timezone ?? null,
        target: noticeTopic(n.title),
        step: p!.label,
        kind: p!.kind,
        members,
        evidence: p!.detail,
        verified: !p!.uncertain,
        problems: p!.uncertain ? ['요일 확인 필요'] : [],
        source,
        by: 'rule',
      });
    }
  }

  // 기사·영상: 그룹(멤버)이 직접 나온다는 문장(participation)이 원문에 있어야 일정이 된다.
  // 참여 문장이 없는 것은 빈칸 채우기 검색으로 찾은 "관련 대상" 기사일 때만 쓴다:
  //   - 티켓 예매·투표: 그룹 관련 출처에 이미 있는 대상이면 일정으로 (예: 드림이 나오는 MMA의 티켓 예매)
  //   - 그 밖(방송 시간 등): 이미 있는 일정의 빈칸만 채우고 새 일정은 만들지 않는다 (fillOnly)
  const articles = new Map((await repo.listArticles(new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString())).map((a) => [a.guid, a]));
  const related: ExtractedItem[] = [];
  for (const ext of await repo.listExtractions('video')) {
    if (opts.guestVideoIds && !opts.guestVideoIds.has(ext.docId)) continue;
    for (const e of ext.checked) if (e.participates) items.push({ ...e, source: ext.source, by: 'ai' });
  }
  for (const ext of await repo.listExtractions('post')) {
    for (const e of ext.checked) if (e.participates || e.members.length) items.push({ ...e, source: ext.source, by: 'ai' });
  }
  for (const ext of await repo.listExtractions('submission')) {
    // 제보는 사용자가 고른 글이라 참여 문장 없이도 쓴다 (멤버 미확인 예고는 합치기 단계에서 추측 목록으로)
    for (const e of ext.checked) items.push({ ...e, source: ext.source, by: 'ai' });
  }
  for (const ext of await repo.listExtractions('article')) {
    const a = articles.get(ext.docId);
    for (const e of ext.checked) {
      const it: ExtractedItem = { ...e, source: ext.source, by: 'ai' };
      // "14일과 15일 이틀간 열리는 MMA" 처럼 날짜 문장에 그룹이 없고 여러 날이면 그룹이 나오는 날을 알 수 없다 → 채우기 전용
      const multiDay = (e.end_date && e.end_date !== e.date) || /\d+\s*일\s*(과|와|~|-|부터|,)\s*\d+\s*일|이틀|사흘/.test(e.evidence);
      if (e.participates && multiDay && !mentionsGroup(e.evidence)) items.push({ ...it, end_date: null, end_time: null, fillOnly: true });
      else if (e.participates) items.push(it);
      else if (a?.focus && isSpecificFocus(a.focus) && similarTarget(e.target, a.focus)) related.push(it);
    }
  }
  const anchors = items.map((x) => x.target);
  for (const it of related) {
    if (!anchors.some((t) => similarTarget(t, it.target))) continue;
    items.push(it.kind === '판매' || it.kind === '투표' ? it : { ...it, fillOnly: true });
  }

  // 마크(탈퇴) 관련은 모두 숨긴다
  const visible = items.filter((x) => ![x.target, x.step, x.evidence, x.source.title].some(isHidden));
  return { items: visible, ruleNotices };
}

/** 영상 제목을 일정 이름으로: "[SUB]", "[EN/ID]", 이모지를 빼고 짧게 */
const shortTitle = (t: string) =>
  t.replace(/\[(SUB|ENG?|EN\/[A-Z]+|[A-Z]{2}(\/[A-Z]{2})*)\]/gi, '').replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, '').replace(/\s{2,}/g, ' ').trim().slice(0, 50);

/** AI 해석이 아직 없는 출연 영상만 공개 시각에 "보기" 일정으로 (AI 키가 없거나 비용 상한에 걸렸을 때) */
export function itemsFromGuestVideos(videos: Video[], interpreted: Set<string> = new Set()): ExtractedItem[] {
  return videos
    .filter((v) => v.guest && !isHidden(v.title) && !interpreted.has(v.videoId))
    .map((v) => {
      const p = toKstParts(new Date(v.publishedAt));
      return {
        date: kstDate(p.year, p.month, p.day),
        time: kstTime(p.hour, p.minute),
        end_date: null,
        end_time: null,
        timezone: null,
        target: `유튜브 ${v.channel}`,
        step: `${shortTitle(v.title)} 공개`,
        kind: '발매' as const,
        members: v.who.members,
        evidence: v.title,
        verified: true,
        problems: [],
        source: { type: 'youtube' as const, id: v.videoId, url: v.url, title: v.title, publisher: v.channel, publishedAt: v.publishedAt },
        by: 'rule' as const,
      };
    });
}

/** 공식 채널 영상 중 일정으로 남길 것: 뮤직비디오·티저·트레일러, 회차가 있는 자체 콘텐츠(EP.n) */
const OFFICIAL_RELEASE_RE = /M\/?V\b|뮤직비디오|teaser|티저|trailer|트레일러|\bEP\.?\s*\d+/i;

/**
 * 공식 채널(소속사·그룹 채널)에 올라온 MV·티저·트레일러·자컨 회차를 공개 시각 그대로 일정으로.
 * 영상 자체가 증거라 바로 믿는 출처다. 기사로 먼저 들어온 같은 일정("첫 번째 트레일러 공개")과는 시간·날짜로 합쳐진다.
 */
export function itemsFromOfficialVideos(videos: Video[], ownChannels: Set<string>, groupNameRe: RegExp): ExtractedItem[] {
  return videos
    .filter((v) => ownChannels.has(v.channel) && !isHidden(v.title) && OFFICIAL_RELEASE_RE.test(v.title) && !/react|리액션|#shorts/i.test(v.title) && !(v.duration !== undefined && v.duration <= 60))
    .map((v) => {
      const p = toKstParts(new Date(v.publishedAt));
      const clean = v.title.replace(groupNameRe, '').replace(/엔시티\s*드림/g, '').replace(/\s{2,}/g, ' ').trim();
      // 시리즈 이름: "하늘을 나는 자전거 | OFF TO DREAM in Mukho | EP.2" → "OFF TO DREAM in Mukho", 없으면 "공식 영상"
      const series = clean.match(/\|\s*([^|]+?)\s*\|\s*EP\.?\s*\d+/i)?.[1] ?? null;
      const ep = clean.match(/\bEP\.?\s*(\d+)/i)?.[1];
      const target = series ?? (/M\/?V|뮤직비디오/i.test(clean) ? clean.replace(/\s*M\/?V.*$/i, '').trim() || '뮤직비디오' : '공식 영상');
      const step = series ? `EP.${ep} 공개` : `${clean} 공개`;
      return {
        date: kstDate(p.year, p.month, p.day), time: kstTime(p.hour, p.minute), end_date: null, end_time: null, timezone: null,
        target: `유튜브 ${v.channel} ${target}`.trim(), step, kind: '발매' as const, members: v.who.members,
        evidence: `${v.title} (공개 ${kstDate(p.year, p.month, p.day)} ${kstTime(p.hour, p.minute)})`, verified: true, problems: [],
        source: { type: 'youtube' as const, id: v.videoId, url: v.url, title: v.title, publisher: v.channel, publishedAt: v.publishedAt },
        by: 'rule' as const, participates: true,
      };
    });
}
