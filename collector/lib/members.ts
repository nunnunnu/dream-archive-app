/**
 * 어떤 멤버의 떡밥인지, 단체 떡밥인지 판단한다. 멤버·유닛·탈퇴 멤버는 config/group.json에서 읽는다.
 */
import { GROUP } from './group.ts';

export const MEMBERS: { name: string; aliases: string[] }[] = GROUP.members.map((m) => ({ name: m.name, aliases: m.aliases }));

/** 유닛: 이름이 나오면 소속 멤버의 떡밥으로 본다 */
const UNITS: { name: string; aliases: string[]; members: string[] }[] = GROUP.units;

export type Scope = '단체' | '멤버' | '유닛';

export interface Who {
  scope: Scope;
  members: string[];
  /** 화면에 보여줄 이름: "단체", "지성", "제노·재민 (NCT JNJM)" */
  label: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function aliasRe(alias: string): RegExp {
  // 영어 이름은 단어 단위로 (MARKET 같은 단어 제외), 한글 이름은 그대로
  return /^[A-Z]+$/.test(alias) ? new RegExp(`(?<![A-Za-z])${alias}(?![A-Za-z])`, 'i') : new RegExp(escape(alias));
}

const MEMBER_RES = MEMBERS.map((m) => ({ name: m.name, res: m.aliases.map(aliasRe) }));
const UNIT_RES = UNITS.map((u) => ({ ...u, res: u.aliases.map(aliasRe) }));

/** 글에 이름이 나온 멤버들 (유닛 이름이 나오면 소속 멤버 포함) */
export function mentionedMembers(text: string): { members: string[]; unit?: string } {
  const unit = UNIT_RES.find((u) => u.res.some((re) => re.test(text)));
  const members = new Set(unit?.members ?? []);
  for (const m of MEMBER_RES) if (m.res.some((re) => re.test(text))) members.add(m.name);
  return { members: MEMBERS.map((m) => m.name).filter((n) => members.has(n)), unit: unit?.name };
}

function makeWho(members: string[], unit?: string): Who {
  // 이름이 없거나 멤버 대부분(전체 인원 - 1명 이상)이 나오면 단체 떡밥
  if (members.length === 0 || members.length >= Math.max(2, MEMBERS.length - 1)) return { scope: '단체', members: [], label: '단체' };
  if (unit) return { scope: '유닛', members, label: `${members.join('·')} (${unit})` };
  return { scope: '멤버', members, label: members.join('·') };
}

/** 공지: 제목만 본다. 단체 공지 본문에도 멤버 이름이 나오기 때문. */
export function whoOfNotice(title: string): Who {
  const { members, unit } = mentionedMembers(title);
  return makeWho(members, unit);
}

/**
 * 화제: 기사 제목 여러 개에서 절반 이상에 나온 멤버만 남긴다.
 * ("마크 빠진 NCT DREAM" 같은 기사 하나 때문에 마크 떡밥이 되지 않게)
 */
export function whoOfArticles(titles: string[]): Who {
  if (!titles.length) return makeWho([]);
  const counts = new Map<string, number>();
  let unitName: string | undefined;
  for (const t of titles) {
    const { members, unit } = mentionedMembers(t);
    if (unit) unitName = unit;
    for (const m of members) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const members = MEMBERS.map((m) => m.name).filter((n) => (counts.get(n) ?? 0) >= Math.ceil(titles.length / 2));
  return makeWho(members, unitName && members.length >= 2 ? unitName : undefined);
}

/**
 * 탈퇴 멤버(hide: true) 관련 글은 아카이브·일정에서 모두 숨긴다.
 * 한글 이름은 앞에 다른 한글이 붙은 단어("랜드마크", "북마크") 속이면 제외, 영문 이름은 단어 단위.
 */
const hiddenAliases = GROUP.formerMembers.filter((f) => f.hide).flatMap((f) => f.aliases);
const HIDDEN_RE = hiddenAliases.length
  ? new RegExp(hiddenAliases.map((a) => (/^[A-Za-z ]+$/.test(a) ? `(?<![A-Za-z])${a}(?![A-Za-z])` : `(?<![가-힣])${a}`)).join('|'), 'i')
  : /(?!)/;
export const isHidden = (text: string) => HIDDEN_RE.test(text);
