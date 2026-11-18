/**
 * 같은 소식 기사 묶기 (Rocket Discover의 중복 묶기 아이디어)
 * 같은 소식을 여러 언론사가 쓰면 묶어서 대표 기사만 본문을 읽는다 → AI 비용 절약.
 * 제목을 글자 2개씩 잘라(바이그램) 겹치는 정도로 비교한다. 3일 안에 나온 기사끼리만.
 */
import { GROUP_NAME_RE, PARENT_RE } from './group.ts';
import type { ArticleRecord } from './repo.ts';

/** 비교할 때 빼는 말: 그룹 이름, 괄호 머리말([포토] 등), 기호 */
function normalizeTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]|【[^】]*】/g, ' ')
    .replace(new RegExp(GROUP_NAME_RE.source, 'gi'), ' ')
    .replace(new RegExp(PARENT_RE.source, 'gi'), ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 짧은 쪽 제목 기준으로 겹치는 비율 (언론사마다 제목 길이가 달라서 합집합 기준보다 잘 맞는다).
 * 우연히 한두 글자 겹치는 경우를 막으려고 겹치는 조각이 3개 미만이면 0.
 */
export function similarity(a: string, b: string): number {
  const A = bigrams(normalizeTitle(a));
  const B = bigrams(normalizeTitle(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter < 3 ? 0 : inter / Math.min(A.size, B.size);
}

const THRESHOLD = 0.45;
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface Cluster {
  id: string;
  articles: ArticleRecord[];
}

/** 이미 묶인 기사(clusterId 있음)는 그 묶음에, 새 기사는 가장 비슷한 묶음에 붙이거나 새 묶음을 만든다 */
export function clusterArticles(articles: ArticleRecord[]): Cluster[] {
  const sorted = [...articles].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const clusters = new Map<string, Cluster>();
  for (const a of sorted.filter((x) => x.clusterId)) {
    const c = clusters.get(a.clusterId!) ?? { id: a.clusterId!, articles: [] };
    c.articles.push(a);
    clusters.set(c.id, c);
  }
  for (const a of sorted.filter((x) => !x.clusterId)) {
    const t = Date.parse(a.publishedAt);
    let best: { c: Cluster; s: number } | null = null;
    for (const c of clusters.values()) {
      const near = c.articles.some((x) => Math.abs(Date.parse(x.publishedAt) - t) <= WINDOW_MS);
      if (!near) continue;
      const s = Math.max(...c.articles.map((x) => similarity(x.title, a.title)));
      if (s >= THRESHOLD && (!best || s > best.s)) best = { c, s };
    }
    if (best) {
      a.clusterId = best.c.id;
      best.c.articles.push(a);
    } else {
      a.clusterId = a.guid;
      clusters.set(a.guid, { id: a.guid, articles: [a] });
    }
  }
  return [...clusters.values()];
}

/** 일정과 관계있어 보이는 소식인지 (아니면 본문을 읽지 않는다) */
const SCHEDULE_CUE_RE =
  /출연|방송|방영|공개|컴백|공연|콘서트|팬미팅|팬콘|라이브|출격|개최|첫방|예능|드라마|OST|발매|티켓|예매|투표|오늘|내일|합류|게스트|무대|시상식|생중계|촬영|녹화|팝업|이벤트|투어|페스티벌|유튜브|웹예능|\d+\s*일|\d+\s*월/;
/** 일정과 관계없는 소식 (사진 기사, 차트·기록 기사) */
const NOISE_RE = /^\s*\[(포토|사진|화보|PHOTO)\]|차트\s*1위|1위\s*(석권|달성|직행|싹쓸이)|순위|판매량|스트리밍\s*\d|조회수|돌파|누적|社区帖子|社群貼文|コミュニティの投稿|커뮤니티 포스트|Community Post/i;
/** 제목 끝에 붙은 (프로그램명) 또는 [종합]: 방송·예능 후기 기사 → 본문에 방송일이 나오는 경우가 많다 ("…(가짜 김효연)") */
const SHOW_RECAP_RE = /\([^)]{2,20}\)\s*(\[[^\]]*\])?\s*$/;

export function looksLikeSchedule(c: Cluster): boolean {
  const titles = c.articles.map((a) => a.title);
  if (titles.every((t) => NOISE_RE.test(t))) return false;
  return titles.some((t) => (SCHEDULE_CUE_RE.test(t) || SHOW_RECAP_RE.test(t)) && !NOISE_RE.test(t));
}
