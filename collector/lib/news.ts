/**
 * 기사 수집 (구글 뉴스 RSS, 무료)
 *  - 기본 검색: 그룹·멤버 이름 → NCT DREAM 관련 기사만
 *  - 화제 검색: 팬 글 키워드 → "NCT DREAM {키워드}"
 *  - 빈칸 채우기 검색: 시간·날짜가 빈 일정이나 행사 관련 일정 → 대상 이름이 제목에 있는 기사 (NCT DREAM이 안 나와도 됨)
 */
import { BROADCASTER_PREFIX_RE } from './broadcasters.ts';
import { searchGoogleNews } from './googleNews.ts';
import { coreNames, normTarget } from './consolidate.ts';
import { GROUP, GROUP_NAME_RE, PARENT_RE } from './group.ts';
import { isHidden, MEMBERS } from './members.ts';
import type { ArticleRecord, Repo } from './repo.ts';
import { sleep } from './time.ts';

/** 기본 검색어: 그룹 이름 표기들 + "{상위 그룹} {멤버}" (예: "NCT 지성") */
export const NEWS_QUERIES: NewsQuery[] = [
  ...GROUP.nameVariants.slice(0, 4).map((q) => ({ q, days: 2 })),
  ...MEMBERS.map((m) => ({ q: `${GROUP.parentNames[0]} ${m.name}`, days: 2, member: m.name })),
  // 출국 소식: 제목에 목적이 적혀 있는 경우가 많다 ("재민, 밀라노 패션위크 참석차 출국") → 질문 "왜 출국해?"에 쓴다
  // 공항 소식(출국·입국·귀국): 멤버를 OR로 묶어 한 번에 (구글 뉴스 요청 수를 줄인다). member: '*' = 멤버 한 명만 나와도 관련 기사
  { q: `${GROUP.name} (출국 OR 입국 OR 귀국)`, days: 2 },
  { q: `${GROUP.parentNames[0]} (${MEMBERS.map((m) => m.name).join(' OR ')}) 출국`, days: 2, member: '*' },
  { q: `${GROUP.parentNames[0]} (${MEMBERS.map((m) => m.name).join(' OR ')}) (입국 OR 귀국)`, days: 2, member: '*' },
];

/** 제목에 멤버가 둘 이상 나오면(예: "뱀뱀·재민·천러… '아이돌스 테이블'") 그룹 이름이 없어도 관련 기사 */
const titleHasMembers = (title: string, member?: string) => {
  const names = MEMBERS.filter((m) => m.aliases.some((a) => title.includes(a))).map((m) => m.name);
  return names.length >= 2 || (member === '*' && names.length >= 1) || (member !== undefined && names.includes(member));
};

/** 같은 상위 그룹의 다른 소식(NCT 127 등)과 구분해 이 그룹(또는 멤버) 기사만 */
// 멤버 이름 + 유닛 이름(NCT JNJM 등): "NCT JNJM 'BOTH SIDES' MV"도 우리 그룹 관련으로
const MEMBER_RE = new RegExp([...MEMBERS.flatMap((m) => m.aliases), ...GROUP.units.flatMap((u) => [u.name.replace(/^NCT\s*/i, ''), ...u.aliases])].join('|'), 'i');
export const isDreamRelated = (title: string) => GROUP_NAME_RE.test(title) || (PARENT_RE.test(title) && MEMBER_RE.test(title));

/** 구글 뉴스 제목 끝의 " - 언론사" 떼기 */
export function stripPublisher(title: string, source: string): string {
  const suffix = ` - ${source}`;
  return source && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title.replace(/\s+-\s+[^-]{1,30}$/, '').trim();
}

export interface NewsQuery {
  q: string;
  /** 검색 기간 (일) */
  days: number;
  /** 빈칸 채우기 검색이면 무엇을 찾는지. 제목에 이 이름이 있는 기사만 받는다 */
  focus?: string;
  /** 멤버 검색("NCT 재민")이면 그 멤버. 구글이 본문에서 NCT를 확인했으니 제목에 멤버 이름만 있어도 받는다 */
  member?: string;
}

const normalize = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/**
 * 빈칸 채우기 검색 결과를 받을지: 제목에 대상 이름이 들어 있어야 한다 ("MMA2026", "크래시2", "셀폰KODE").
 * "리스닝 파티", "팬사인회"처럼 고유한 표시(영문·숫자·따옴표 속 이름)가 없는 일반적인 이름이면
 * 다른 가수 소식일 수 있어서 제목에 NCT DREAM도 함께 나와야 받는다.
 */
const QUOTE_RE = /[‘'"“「<《]([^’'"”」>》]{2,20})[’'"”」>》]/g;
const LEADING_BROADCASTER_RE = BROADCASTER_PREFIX_RE;
export function titleHasFocus(title: string, focus: string): boolean {
  const t = normTarget(title);
  const quoted = [...focus.matchAll(QUOTE_RE)].map((m) => normTarget(m[1])).filter((q) => q.length >= 2);
  const coreText = focus.replace(LEADING_BROADCASTER_RE, '').replace(/\([^)]*\)/g, ' ');
  const whole = normTarget(coreText);
  const hit =
    quoted.some((q) => t.includes(q)) ||
    (whole.length >= 3 && t.includes(whole)) ||
    coreNames(focus).some((n) => n.length >= 3 && /[a-z\d]/.test(n) && t.includes(n));
  return hit && (isSpecificFocus(focus) || isDreamRelated(title));
}

/** 대상 이름에 고유한 표시(따옴표 속 이름, 영문, 숫자)가 있는지. 없으면 "리스닝 파티"처럼 일반적인 이름 */
export function isSpecificFocus(focus: string): boolean {
  const coreText = focus.replace(LEADING_BROADCASTER_RE, '').replace(/\([^)]*\)/g, ' ');
  return [...focus.matchAll(QUOTE_RE)].length > 0 || /[A-Za-z]{2,}|\d/.test(coreText);
}

/** 검색해서 처음 보는 기사만 저장소에 추가한다 */
const FOLLOWUP_PER_QUERY = 6;

export async function collectArticles(repo: Repo, queries: NewsQuery[], now: Date): Promise<ArticleRecord[]> {
  const nowIso = now.toISOString();
  const known = await repo.listArticles(new Date(now.getTime() - 120 * 24 * 3600 * 1000).toISOString());
  const seenGuid = new Set(known.map((a) => a.guid));
  const seenTitle = new Set(known.map((a) => normalize(a.title)));
  const added: ArticleRecord[] = [];

  for (const query of queries) {
    // 429면 searchGoogleNews가 기다렸다가 다시 묻는다. 그래도 막히면 이번 실행의 남은 기사 검색은 다음 실행으로
    let results: Awaited<ReturnType<typeof searchGoogleNews>>;
    try {
      results = await searchGoogleNews(`${query.q} when:${query.days}d`);
    } catch (err) {
      if (/429/.test((err as Error).message)) { console.log(`남은 기사 검색 ${queries.length - queries.indexOf(query)}개는 다음 실행으로`); break; }
      console.log(`기사 검색 실패: ${query.q} (${(err as Error).message})`);
      continue;
    }
    // 빈칸 채우기 검색은 한 번에 많이 쌓이면 AI 해석이 오래 걸린다:
    // 그룹이 제목에 나오는 기사 → 최신 순으로 검색어당 최대 6개만
    if (query.focus) {
      results = results
        .filter((it) => titleHasFocus(stripPublisher(it.title, it.source), query.focus!))
        .sort((a, b) => Number(isDreamRelated(b.title)) - Number(isDreamRelated(a.title)) || b.publishedAt.getTime() - a.publishedAt.getTime())
        .slice(0, FOLLOWUP_PER_QUERY);
    }
    for (const it of results) {
      const title = stripPublisher(it.title, it.source);
      if (seenGuid.has(it.guid) || seenTitle.has(normalize(title)) || isHidden(title)) continue;
      if (/weverse/i.test(it.source)) continue; // 위버스 공지·팬 글은 공지 수집에서 따로 다룬다
      if (query.focus ? !titleHasFocus(title, query.focus) : !(isDreamRelated(title) || titleHasMembers(title, query.member))) continue;
      seenGuid.add(it.guid);
      seenTitle.add(normalize(title));
      added.push({
        guid: it.guid,
        title,
        link: it.link,
        source: it.source,
        publishedAt: it.publishedAt.toISOString(),
        firstSeenAt: nowIso,
        origin: query.focus ? 'followup' : 'search',
        focus: query.focus,
        status: 'pending',
      });
    }
  }
  if (added.length) await repo.putArticles(added);
  return added;
}
