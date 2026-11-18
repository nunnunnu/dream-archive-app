import { GROUP } from './lib/group.ts';

/** 위버스 커뮤니티 주소 (weverse.io/{slug}) */
export const WEVERSE_COMMUNITY = GROUP.weverse.community;

/** 위버스 공지를 찾을 때 쓰는 구글 뉴스 검색어 */
export const WEVERSE_QUERIES = [`${GROUP.nameVariants[0]} site:weverse.io`, `${GROUP.nameVariants[3] ?? GROUP.nameVariants[0]} site:weverse.io`];

/** 평소 실행 때 구글 뉴스에서 살펴볼 기간 */
export const RECENT_WINDOW = 'when:7d';

/** 과거 자료 채우기 시작 월 (구글 뉴스에 위버스 글이 잡히는 가장 오래된 시점) */
export const BACKFILL_FROM = '2023-08';

/** 작성 후 이 기간 안의 공지는 매번 다시 읽어서 수정 사항을 반영한다 */
export const RECHECK_DAYS = 3;

/** 공지로 보이는 제목: 맨 앞 대괄호 안에 공지/알림/안내/이벤트/notice 등이 있는 글 */
export const NOTICE_TITLE_RE = /^\s*\[[^\]]*(공지|알림|안내|이벤트|notice|event|お知らせ|公告|通知)[^\]]*\]/i;

/** 페이지 사이 대기 시간 (위버스·구글 부담 줄이기) */
export const NAV_DELAY_MS = 1500;

/** 번호 직접 확인: "찾을 수 없음"이 이만큼 연속으로 나오면 아직 안 올라온 번호로 보고 멈춘다 */
export const MAX_FRONTIER_MISSES = 3;

/** 번호 직접 확인: 한 번 실행에서 열어볼 최대 페이지 수 (오래 멈췄다가 다시 돌 때 폭주 방지) */
export const MAX_PROBES_PER_RUN = 60;

/** 중간에 비어 있던 번호(예약 게시일 수 있음)를 다시 확인하는 기간과 실행당 최대 개수 */
export const GAP_RECHECK_HOURS = 48;
export const MAX_GAP_RECHECKS_PER_RUN = 10;
