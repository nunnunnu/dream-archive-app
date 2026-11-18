import type { Page } from 'playwright';
import type { NoticeRef } from './weverse.ts';

/** highlight 페이지는 로그인 없이 최신 공지 4개와 팬 글 몇 개를 보여준다 */
const NOTICE_TITLE_SELECTOR = '[class*="highlight_notice_item_title_text"]';
/** 팬 글 본문만 고른다 (닉네임·좋아요 수는 다른 요소라 읽지 않는다) */
const FAN_POST_TEXT_SELECTOR = '[class*="fan-post-module"] p[class*="-_-text"]';
const NOTICE_PATH_RE = /^\/([^/]+)\/notice\/(\d+)/;

export interface Highlight {
  noticeTitles: string[];
  /** 팬 글 본문. 화제 키워드를 뽑는 데만 쓰고 저장하지 않는다. */
  fanPostTexts: string[];
}

const highlightUrl = (community: string) => `https://weverse.io/${community}/highlight`;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function openHighlight(page: Page, community: string): Promise<void> {
  await page.goto(highlightUrl(community), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator(NOTICE_TITLE_SELECTOR).first().waitFor({ timeout: 30_000 });
}

export async function readHighlight(page: Page, community: string): Promise<Highlight> {
  await openHighlight(page, community);
  // 팬 글은 공지보다 늦게 뜨기도 하고, 없을 수도 있다
  await page.locator(FAN_POST_TEXT_SELECTOR).first().waitFor({ timeout: 10_000 }).catch(() => {});
  const clean = (texts: string[]) => texts.map((t) => t.trim()).filter(Boolean);
  return {
    noticeTitles: clean(await page.locator(NOTICE_TITLE_SELECTOR).allInnerTexts()),
    fanPostTexts: clean(await page.locator(FAN_POST_TEXT_SELECTOR).allInnerTexts()),
  };
}

/** highlight의 공지 항목을 눌러 공지 번호를 알아낸다. 누른 뒤에는 그 공지 상세가 열려 있다. */
export async function openHighlightNotice(page: Page, community: string, title: string): Promise<NoticeRef | null> {
  if (!new URL(page.url()).pathname.endsWith('/highlight')) await openHighlight(page, community);
  await page
    .locator(NOTICE_TITLE_SELECTOR, { hasText: new RegExp(`^\\s*${escapeRegExp(title)}\\s*$`) })
    .first()
    .click();
  await page.waitForURL(/\/notice\/\d+/, { timeout: 15_000 });
  const m = new URL(page.url()).pathname.match(NOTICE_PATH_RE);
  return m ? { community: m[1], id: m[2] } : null;
}
