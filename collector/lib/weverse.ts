import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { kstIso, toKstParts } from './time.ts';

export interface Notice {
  id: string;
  community: string;
  url: string;
  title: string;
  /** 위버스에 표시된 작성 시각 (KST ISO) */
  postedAt: string;
  body: string;
  bodyHash: string;
  /** 처음 읽은 시각 / 본문이 마지막으로 바뀐 시각 (ISO). 매 실행마다 바뀌는 값은 두지 않아 불필요한 커밋을 막는다. */
  firstFetchedAt: string;
  lastChangedAt: string;
}

export interface NoticeRef {
  community: string;
  id: string;
}

const NOTICE_PATH_RE = /^\/([^/]+)\/notice\/(\d+)/;

export function noticeUrl(ref: NoticeRef): string {
  return `https://weverse.io/${ref.community}/notice/${ref.id}`;
}

/**
 * 구글 뉴스 RSS 링크는 암호화된 주소라서, 브라우저로 열어 실제 위버스 주소로 넘어간 뒤의 URL을 읽는다.
 * 위버스 공지가 아니면 null.
 */
export async function resolveGoogleNewsLink(page: Page, link: string): Promise<NoticeRef | null> {
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForURL((u) => !u.hostname.endsWith('news.google.com'), { timeout: 20_000 }).catch(() => {});
  const url = new URL(page.url());
  if (!url.hostname.endsWith('weverse.io')) return null;
  const m = url.pathname.match(NOTICE_PATH_RE);
  return m ? { community: m[1], id: m[2] } : null;
}

/** 공지 메타 표기("11. 11. 15:55" 또는 "2025. 11. 11. 15:55")를 KST ISO로. 연도가 없으면 기준 시각으로 추정한다. */
export function parseNoticeMeta(meta: string, reference: Date): string | null {
  const m = meta.match(/(?:(\d{4})\.\s*)?(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const ref = toKstParts(reference);
  const month = Number(m[2]);
  const day = Number(m[3]);
  let year = m[1] ? Number(m[1]) : ref.year;
  // 연도 없이 표시된 날짜가 기준 시각보다 미래면 작년 글로 본다
  if (!m[1] && (month > ref.month || (month === ref.month && day > ref.day + 1))) year -= 1;
  return kstIso({ year, month, day, hour: Number(m[4]), minute: Number(m[5]) });
}

export function normalizeBody(text: string): string {
  return text
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface NoticeContent {
  title: string;
  postedAt: string;
  body: string;
  bodyHash: string;
  /** 본문 속 큰 이미지 주소 (일정표·포스터 등) */
  images: string[];
}

const TITLE_SELECTOR = 'h3[class*="notice-post-header"][class*="title"]';
const NOT_FOUND_TEXT = '페이지를 찾을 수 없습니다';

export type ProbeResult = { status: 'notfound' } | { status: 'found'; community: string };

/**
 * 공지 번호를 직접 연다. 공지 번호는 위버스 전체에서 순서대로 매겨진다.
 * - 다른 커뮤니티 공지면 그 커뮤니티 주소로 넘어간다 (/nctdream/notice/40925 → /sb19/notice/40925)
 * - 없는 번호면 "페이지를 찾을 수 없습니다"가 뜬다
 * found면 페이지가 열린 상태로 끝나므로 이어서 readOpenNotice로 본문을 읽을 수 있다.
 */
export async function probeNotice(page: Page, community: string, id: number): Promise<ProbeResult> {
  await page.goto(`https://weverse.io/${community}/notice/${id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const title = page.locator(TITLE_SELECTOR).first();
  const notFound = page.getByText(NOT_FOUND_TEXT).first();
  await title.or(notFound).first().waitFor({ timeout: 30_000 });
  if (await notFound.isVisible()) {
    // 다른 커뮤니티로 넘어가기 전에 잠깐 뜨는 경우를 걸러낸다
    await page.waitForTimeout(2000);
    if (!(await title.isVisible())) return { status: 'notfound' };
  }
  const m = new URL(page.url()).pathname.match(NOTICE_PATH_RE);
  return { status: 'found', community: m?.[1] ?? community };
}

/** 공지 상세 페이지를 열어 제목·작성 시각·본문을 읽는다. 공지 상세는 로그인 없이 보인다. */
export async function readNotice(page: Page, ref: NoticeRef, reference: Date): Promise<NoticeContent> {
  await page.goto(noticeUrl(ref), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return readOpenNotice(page, reference);
}

/** 이미 열려 있는 공지 상세 페이지에서 제목·작성 시각·본문을 읽는다. */
export async function readOpenNotice(page: Page, reference: Date): Promise<NoticeContent> {
  const titleLoc = page.locator(TITLE_SELECTOR).first();
  const metaLoc = page.locator('div[class*="notice-post-header"][class*="meta"]').first();
  const bodyLoc = page.locator('.WeverseViewer').first();
  await titleLoc.waitFor({ timeout: 30_000 });
  await bodyLoc.waitFor({ timeout: 30_000 });

  const title = (await titleLoc.innerText()).trim();
  const meta = (await metaLoc.innerText().catch(() => '')).trim();
  const body = normalizeBody(await bodyLoc.innerText());
  const postedAt = parseNoticeMeta(meta, reference);
  if (!postedAt) throw new Error(`공지 작성 시각을 읽지 못함: ${page.url()} (meta="${meta}")`);
  // 본문 이미지는 글보다 늦게 붙는다 (없는 공지면 최대 5초 기다림)
  await bodyLoc.locator('img').first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {});
  // 본문 이미지는 늦게 불러와져서 크기로 거르지 않는다 (아직 안 불러온 이미지는 크기가 0). 이미 불러온 작은 아이콘만 뺀다
  const images = (await bodyLoc
    .evaluate((el) => [...el.querySelectorAll('img')].filter((i) => !i.complete || i.naturalWidth === 0 || i.naturalWidth >= 400).map((i) => i.currentSrc || i.src).filter(Boolean))
    .catch(() => [])) as string[];

  return { title, postedAt, body, bodyHash: createHash('sha256').update(body).digest('hex').slice(0, 16), images: [...new Set(images)] };
}
