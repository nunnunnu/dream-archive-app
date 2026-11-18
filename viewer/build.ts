/**
 * 사이트용 결과(data/public)를 한 파일짜리 HTML 미리보기로 만든다 (서버 없이 브라우저로 바로 열림).
 * 공지 탭은 원문 본문(.cache)과 뽑힌 일정을 나란히 보여줘서 추출을 검증하는 용도.
 *
 * 사용: npm run view
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PendingItem, PublicEvent, ReviewItem, RumorItem } from '../collector/lib/consolidate.ts';
import { isHidden, whoOfNotice } from '../collector/lib/members.ts';
import type { FeedItem } from '../collector/lib/publish.ts';
import { JsonRepo } from '../collector/lib/repo.ts';
import { readJson } from '../collector/lib/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, 'dist', 'index.html');
const repo = new JsonRepo();

const { events } = await readJson<{ events: PublicEvent[] }>('public/events.json', { events: [] });
const { items: pending } = await readJson<{ items: PendingItem[] }>('public/pending.json', { items: [] });
const { items: feed } = await readJson<{ items: FeedItem[] }>('public/feed.json', { items: [] });
const { items: rumors } = await readJson<{ items: RumorItem[] }>('public/rumors.json', { items: [] });
const { items: review } = await readJson<{ items: ReviewItem[] }>('public/review.json', { items: [] });
const { tags } = await readJson<{ tags: { id: string; kind: string; name: string; count: number }[] }>('public/tags.json', { tags: [] });

const whoOf = (scope: string, members: string[]) => ({ scope, members, label: scope === '단체' ? '단체' : members.join('·') });

// 미리보기 화면이 쓰는 형태로 바꾸기
const viewEvents = events.map((e) => ({
  id: e.id,
  date: e.date,
  time: e.time ?? undefined,
  endDate: e.endDate ?? undefined,
  endTime: e.endTime ?? undefined,
  timezone: e.timezone ?? undefined,
  label: e.step,
  context: e.title,
  kind: e.kind,
  detail: e.evidence,
  uncertain: e.status === 'needs-check' || undefined,
  who: whoOf(e.scope, e.members),
  source: e.sources[0],
  otherSources: e.sources.slice(1),
  extractedBy: e.sources[0]?.type === 'weverse-notice' ? e.extractedBy : 'news',
  category: e.category,
  calendars: e.calendars ?? [e.category],
  audience: e.audience,
  tags: e.tags ?? [],
}));

const notices = [];
for (const n of await repo.listNotices()) {
  if (isHidden(n.title)) continue;
  notices.push({ id: n.id, title: n.title, url: n.url, postedAt: n.postedAt, body: (await repo.getBody('notice', n.id)) ?? '(본문 캐시 없음)', who: whoOfNotice(n.title) });
}

const data = {
  builtAt: new Date().toISOString(),
  events: viewEvents,
  notices,
  pending: pending.map((p) => ({ title: p.title, step: p.step, whenText: p.whenText, who: whoOf(p.scope, p.members), sources: p.sources })),
  feed,
  tags,
  rumors,
  review: review.map((e) => ({ date: e.date, time: e.time, title: e.title, step: e.step, reason: e.reason, evidence: e.evidence, who: whoOf(e.scope, e.members), sources: e.sources })),
};

// 공지 본문에 "<Boogie Woogie>" 같은 꺾쇠가 있어서 </script>로 끊기지 않게 이스케이프한다
const json = JSON.stringify(data)
  .replaceAll('<', '\\u003c')
  .replaceAll(String.fromCharCode(0x2028), '\\u2028')
  .replaceAll(String.fromCharCode(0x2029), '\\u2029');
const template = await readFile(join(here, 'template.html'), 'utf8');
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, template.replace('/*__DATA__*/null', () => json), 'utf8');
console.log(`미리보기 생성: ${outPath} (일정 ${events.length}개, 날짜 미정 ${pending.length}개, 소식 ${feed.length}개, 공지 ${notices.length}개)`);
