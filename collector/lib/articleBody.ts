/**
 * 기사 본문 읽기: 구글 뉴스 링크를 브라우저로 열어 원문 사이트로 넘어간 뒤 본문 글자를 가져온다.
 */
import type { Page } from 'playwright';

const BODY_SELECTORS = [
  '[itemprop="articleBody"]',
  '#articleBody',
  '#article-view-content-div',
  '#newsct_article',
  '.article_body',
  '.article-body',
  '.news_view',
  '#article_txt',
  'article',
];

const DATE_META = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[property="og:published_time"]',
  'meta[itemprop="datePublished"]',
  'meta[name="pubdate"]',
  'meta[name="date"]',
];

/**
 * 기사 페이지에 적힌 작성 시각. 구글 뉴스가 옛 기사를 새 날짜로 다시 올리는 경우가 있어서
 * (예: 2024년 월드투어 기사가 2026-11-09로 들어옴) 페이지의 날짜를 따로 확인한다.
 */
export async function pageDate(page: Page): Promise<string | undefined> {
  for (const sel of DATE_META) {
    const c = await page.locator(sel).first().getAttribute('content', { timeout: 1000 }).catch(() => null);
    if (c && !Number.isNaN(Date.parse(c))) return new Date(c).toISOString();
  }
  const ld = (await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? '').join('\n')).catch(() => '')) as string;
  const m = ld.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (m && !Number.isNaN(Date.parse(m[1]))) return new Date(m[1]).toISOString();
  const body = (await page.locator('body').innerText().catch(() => '')) as string;
  const t = body.match(/(?:입력|등록|기사입력|승인)\s*[:：]?\s*(20\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/);
  if (t) return new Date(Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3])) - 9 * 3600 * 1000).toISOString();
  return undefined;
}

export async function openArticle(page: Page, googleLink: string): Promise<{ url: string; text: string; publishedAt?: string } | null> {
  await page.goto(googleLink, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForURL((u) => !u.hostname.endsWith('news.google.com'), { timeout: 20_000 }).catch(() => {});
  if (new URL(page.url()).hostname.endsWith('news.google.com')) return null;
  await page.waitForTimeout(1500);
  const publishedAt = await pageDate(page);
  for (const sel of BODY_SELECTORS) {
    const loc = page.locator(sel).first();
    if (!(await loc.count())) continue;
    const text = (await loc.innerText().catch(() => '')).trim();
    if (text.length > 200) return { url: page.url(), text, publishedAt };
  }
  const text = (await page.locator('body').innerText().catch(() => '')).trim();
  return text ? { url: page.url(), text, publishedAt } : null;
}

/**
 * 본문에서 찾는 말(날짜 등) 앞뒤만 잘라낸다. AI에 보내는 양을 줄이고 엉뚱한 부분(메뉴·광고)을 뺀다.
 * 찾는 말이 하나도 없으면 빈 문자열 (AI를 부르지 않는다).
 */
export function snippetsAround(text: string, needles: RegExp[], radius = 250, max = 2000): string {
  const ranges: [number, number][] = [];
  for (const re of needles) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) ranges.push([Math.max(0, m.index - radius), Math.min(text.length, m.index + m[0].length + radius)]);
  }
  if (!ranges.length) return '';
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged.map(([a, b]) => text.slice(a, b).replace(/\s+/g, ' ')).join('\n…\n').slice(0, max);
}
