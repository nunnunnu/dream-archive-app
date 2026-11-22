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
// 짧은 시간에 몰아서 부르면 요청 제한(429)이 걸린다:
//  - 모든 호출(기사·공지 찾기·과거 기사) 사이에 최소 간격을 둔다 (GOOGLE_NEWS_GAP_SEC, 기본 8초)
//  - 429면 기다렸다가 다시 묻는다 (Retry-After가 있으면 그만큼, 없으면 1분 → 2분 → 4분)
//  - 한 실행에서 기다린 시간이 GOOGLE_NEWS_WAIT_MAX_MIN(기본 10분, 빠른 실행 4분)을 넘으면 이번 실행은 구글을 그만 부른다 (다음 실행에서 다시)
const GAP_MS = Number(process.env.GOOGLE_NEWS_GAP_SEC ?? 8) * 1000;
const WAIT_MAX_MS = Number(process.env.GOOGLE_NEWS_WAIT_MAX_MIN ?? (process.argv.includes('--fast') ? 4 : 10)) * 60_000;
const BACKOFF_MS = [60_000, 120_000, 240_000];
let lastCall = 0;
let waited = 0;
let gaveUp = false;
export const googleNewsBlocked = () => gaveUp;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function searchGoogleNews(query: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  for (let attempt = 0; ; attempt++) {
    if (gaveUp) throw new Error(`Google News RSS 429 (이번 실행은 그만): ${query}`);
    const gap = lastCall + GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();
    const res = await fetch(url);
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after')) * 1000;
      const wait = Math.max(Number.isFinite(after) ? after : 0, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      if (attempt >= BACKOFF_MS.length || waited + wait > WAIT_MAX_MS) {
        gaveUp = true;
        console.log(`구글 뉴스 요청 제한(429): 이번 실행에서 ${Math.round(waited / 60_000)}분 기다렸는데도 막혀서 남은 구글 검색은 다음 실행으로`);
        throw new Error(`Google News RSS 429: ${query}`);
      }
      console.log(`구글 뉴스 요청 제한(429) → ${Math.round(wait / 1000)}초 기다렸다가 다시 (${attempt + 1}번째)`);
      waited += wait;
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Google News RSS ${res.status}: ${query}`);
    return parse(await res.text());
  }
}

function parse(xml: string): NewsItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: readTag(item, 'title'),
    link: readTag(item, 'link'),
    guid: readTag(item, 'guid'),
    publishedAt: new Date(readTag(item, 'pubDate')),
    source: readTag(item, 'source'),
  }));
}
