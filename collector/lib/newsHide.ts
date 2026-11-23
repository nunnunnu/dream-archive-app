/**
 * 소식 삭제 제보: 소식 탭에서 항목 숨기기.
 *  - 소식에는 고정 id가 없어서 원문 주소로 찾는다 (묶인 기사는 그 안의 매체별 주소까지)
 *  - 권리자·초상권, 사생활 요청은 바로 내린다 (먼저 내리고 운영자가 나중에 보는 쪽이 안전)
 *  - 그 밖의 이유는 AI가 "제보 이유가 확실히 맞다"고 볼 때만 자동으로 숨기고, 애매하면 운영자 확인
 * 숨긴 목록은 앱 상태 news-hidden 에 쌓고, 소식을 내보내기 전에 빼낸다.
 */
import type { Budget } from './budget.ts';
import { GROUP } from './group.ts';
import { callModel, hasLlmKey } from './llm.ts';
import type { FeedItem } from './publish.ts';
import type { Repo } from './repo.ts';
import { saveReport, type Report } from './reports.ts';

export interface NewsHide { url: string; urls: string[]; title: string; reason: string; reportId?: string; at: string }
export const NEWS_HIDE_STATE = 'news-hidden';
/** 바로 내리는 이유 */
export const TAKEDOWN_REASONS = new Set(['rights', 'privacy']);
const REASONS: Record<string, string> = { unrelated: '드림 소식이 아님', duplicate: '같은 소식이 또 있음', wrong: '틀린 내용', rights: '권리자·초상권 요청', privacy: '사생활 침해', other: '기타' };

export const isNewsDelete = (r: Pick<Report, 'type' | 'target'>) => r.type === 'delete' && r.target === 'news';

/** 주소 비교용: 앞뒤 공백·끝 슬래시·utm 파라미터·#조각 제거, 호스트 소문자 */
export function normUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.toLowerCase().replace(/^www\./, '');
    return x.toString().replace(/\/$/, '');
  } catch {
    return u.trim();
  }
}
const urlsOf = (f: FeedItem) => [f.url, ...(f.articles ?? []).map((a) => a.url)].map(normUrl);

export function findFeedItem(feed: FeedItem[], url: string): FeedItem | undefined {
  const u = normUrl(url);
  return feed.find((f) => urlsOf(f).includes(u));
}

/** 숨긴 소식 빼기 (묶음 안의 기사 하나라도 숨긴 주소면 그 묶음째 뺀다) */
export function hideNews(feed: FeedItem[], hidden: NewsHide[]): FeedItem[] {
  if (!hidden.length) return feed;
  const set = new Set(hidden.flatMap((h) => [h.url, ...h.urls]).map(normUrl));
  return feed.filter((f) => !urlsOf(f).some((u) => set.has(u)));
}

export function hideEntry(r: Report, item: FeedItem | undefined, reason: string, now: Date): NewsHide {
  const url = item?.url ?? r.newsUrl ?? '';
  return { url, urls: item ? urlsOf(item) : [normUrl(url)], title: item?.title ?? r.newsTitle ?? '', reason, reportId: r.id, at: now.toISOString() };
}

export async function judgeNewsDeleteReports(repo: Repo, reports: Record<string, Report>, feed: FeedItem[], budget: Budget, now: Date): Promise<string[]> {
  const todo = Object.values(reports).filter((r) => isNewsDelete(r) && r.status === 'pending' && r.reviewMode !== 'manual');
  if (!todo.length) return [];
  const hidden = await repo.getState<NewsHide[]>(NEWS_HIDE_STATE, []);
  const log: string[] = [];
  const approve = async (r: Report, reason: string) => {
    Object.assign(r, { status: 'approved', reviewedAt: now.toISOString(), reviewMode: 'auto', reviewReason: reason });
    await saveReport(r);
  };
  const hide = (r: Report, item: FeedItem | undefined, reason: string) => {
    const kept = hidden.filter((h) => h.reportId !== r.id);
    hidden.length = 0;
    hidden.push(...kept, hideEntry(r, item, reason, now));
  };
  for (const r of todo) {
    const item = r.newsUrl ? findFeedItem(feed, r.newsUrl) : undefined;
    if (!item) {
      await approve(r, '이미 소식에서 빠져 있어요.');
      log.push(`소식 삭제 제보 ${r.id}: 이미 없음`);
      continue;
    }
    if (TAKEDOWN_REASONS.has(r.reasonCode ?? '')) {
      hide(r, item, REASONS[r.reasonCode!]);
      await approve(r, `${REASONS[r.reasonCode!]}이라 바로 내렸어요.`);
      log.push(`소식 삭제 제보 ${r.id}: 바로 내림 (${REASONS[r.reasonCode!]}) ${item.title.slice(0, 40)}`);
      continue;
    }
    if (!hasLlmKey() || !budget.canSpend()) { r.reviewReason = 'AI 판정을 기다려요.'; continue; }
    const res = await callModel({
      model: 'gpt-5-nano', effort: 'low',
      instructions: [
        `${GROUP.name} 팬 사이트의 소식 탭(화보·광고·공항·기사·영상)에 "이 소식을 지워 달라"는 제보가 왔다. 제보 이유가 맞는지 판정한다.`,
        `- 소식 탭에 맞는 것: ${GROUP.name}(또는 멤버)가 주인공이거나 직접 나오는 기사·영상·공지.`,
        '- 지울 만한 것: 다른 가수가 주인공인 기사, 이름만 스친 기사, 같은 소식이 겹친 것, 내용이 틀린 것.',
        '- 제보 이유가 확실히 맞으면 agree=true, sure=true. 근거가 부족하거나 애매하면 sure=false.',
        '- reason은 한국어 한 문장.',
      ].join('\n'),
      input: [
        `소식: ${item.type} · ${item.publisher ?? ''} · ${item.title}`,
        item.articles?.length ? `같이 묶인 기사: ${item.articles.slice(0, 5).map((a) => `${a.publisher} ${a.title}`).join(' / ')}` : '',
        `제보 이유: ${REASONS[r.reasonCode ?? ''] ?? r.reasonCode ?? ''} ${r.message}`,
      ].filter(Boolean).join('\n'),
      schema: { name: 'judge', schema: { type: 'object', additionalProperties: false, required: ['agree', 'sure', 'reason'], properties: { agree: { type: 'boolean' }, sure: { type: 'boolean' }, reason: { type: 'string' } } } },
    }).catch(() => null);
    if (!res) { r.reviewReason = 'AI 판정을 기다려요.'; continue; }
    budget.record(res.usage.costUsd);
    const v = JSON.parse(res.value) as { agree: boolean; sure: boolean; reason: string };
    if (v.agree && v.sure) {
      hide(r, item, v.reason);
      await approve(r, `AI 판정으로 소식에서 내렸어요: ${v.reason}`);
      log.push(`소식 삭제 제보 ${r.id}: 자동으로 내림 (${item.title.slice(0, 40)}) ${v.reason}`);
    } else {
      r.reviewReason = `AI가 확실하지 않다고 봐서 사람이 확인해요: ${v.reason}`;
      log.push(`소식 삭제 제보 ${r.id}: 사람 확인 (${v.reason})`);
    }
  }
  await repo.putState(NEWS_HIDE_STATE, hidden);
  await repo.putState('reports', reports);
  return log;
}
