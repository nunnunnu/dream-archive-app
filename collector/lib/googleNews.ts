export interface NewsItem {
  title: string;
  link: string;
  guid: string;
  publishedAt: Date;
  source: string;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return NAMED_ENTITIES[e.toLowerCase()] ?? match;
  });
}

function readTag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return '';
  return decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim();
}

/** 구글 뉴스 RSS 검색. 키 없이 동작하며 한 번에 최대 100건 정도를 돌려준다. */
// 요청 제한(429)을 받으면 이 실행 안에서는 10분 동안 다시 묻지 않는다 (같은 곳을 계속 두드리지 않게)
let blockedUntil = 0;
export const googleNewsBlocked = () => Date.now() < blockedUntil;

export async function searchGoogleNews(query: string): Promise<NewsItem[]> {
  if (googleNewsBlocked()) throw new Error(`Google News RSS 429 (쉬는 중): ${query}`);
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url);
  if (res.status === 429) blockedUntil = Date.now() + 10 * 60_000;
  if (!res.ok) throw new Error(`Google News RSS ${res.status}: ${query}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: readTag(item, 'title'),
    link: readTag(item, 'link'),
    guid: readTag(item, 'guid'),
    publishedAt: new Date(readTag(item, 'pubDate')),
    source: readTag(item, 'source'),
  }));
}
