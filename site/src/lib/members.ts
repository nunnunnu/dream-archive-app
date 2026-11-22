// 멤버 문서 데이터 (members.json, 수집기 memberDocs.ts가 만든다)
export interface MemberDoc {
  slug: string; name: string; en: string; kind: '그룹' | '멤버';
  color?: { from: string; to: string; dot: string };
  realName?: string; position?: string; birthday?: string; born?: string; debut?: string; groups: string[];
  photo?: { thumb: string; url: string; title: string; focus?: number };
  timeline: { year: string; items: { date: string; kind: string; title: string; eraId: string; owner: string }[] }[];
  eras: string[];
  variety: { id: string; name: string; type: string; count: number; to: string }[];
  appearances: { date: string; title: string; step: string; url?: string }[];
  pictorial: { title: string; url: string; image?: string; date: string; publisher?: string; topic?: string }[];
  news: { title: string; url: string; date: string; publisher?: string; topic?: string; type: string; image?: string }[];
}
export interface MembersData {
  group: MemberDoc; members: MemberDoc[];
  stats: { events: number; news: number; comebacks: number; tours: number };
  offSeason: { month: string; count: number; top: { date: string; title: string; kind: string }[] }[];
}
export const EMPTY_MEMBERS: MembersData = { group: { slug: 'nctdream', name: '', en: '', kind: '그룹', groups: [], timeline: [], eras: [], variety: [], appearances: [], pictorial: [], news: [] }, members: [], stats: { events: 0, news: 0, comebacks: 0, tours: 0 }, offSeason: [] };

/** 멤버 색: members.json의 color (config/group.json에서), 없으면 기본색 */
const DEFAULT_COLOR = { from: '#1b2a05', to: '#c5f03a', dot: '#c5f03a' };
export const colorOf = (m?: { color?: { from: string; to: string; dot: string } }) => m?.color ?? DEFAULT_COLOR;

/** 한국 시간 오늘 */
export const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
/** 다음 기념일(MM-DD)까지 남은 날 (오늘이면 0) */
export function daysUntil(mmdd: string, today = todayKst()): { days: number; date: string } {
  const y = Number(today.slice(0, 4));
  let date = `${y}-${mmdd}`;
  if (date < today) date = `${y + 1}-${mmdd}`;
  return { days: Math.round((Date.parse(date) - Date.parse(today)) / 864e5), date };
}
export const dday = (mmdd: string) => { const { days } = daysUntil(mmdd); return days === 0 ? '오늘' : `D-${days}`; };
/** 유튜브 썸네일: 큰 것(maxres, 위아래 띠 없음) → 없으면 hq(위아래 검은 띠가 있어 확대) */
export const thumbs = (hq: string) => ({ big: hq.replace(/\/(hq|mq|sd)default\.jpg$/, '/maxresdefault.jpg'), hq });
