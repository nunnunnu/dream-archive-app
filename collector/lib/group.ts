/**
 * 그룹·멤버 설정 읽기 (config/group.json). 다른 파일은 그룹 이름·멤버를 직접 쓰지 않고 여기서 가져온다.
 * 다른 설정 파일을 쓰려면 GROUP_CONFIG 환경변수로 경로를 준다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './store.ts';

export interface MemberConfig {
  name: string;
  slug: string;
  aliases: string[];
  nicknames?: string[];
  /** 멤버 문서 프로필: 본명·드림 밖 소속(공개된 사실), 포지션(운영자가 직접) */
  realName?: string;
  position?: string;
  /** 팬 커뮤니티에서 멤버를 표시하는 이모지 (예: 지성 🐹) */
  emojis?: string[];
  /** 이 그룹 밖 활동 (예: NCT 127). 그 일정은 수집하지 않는다 */
  otherGroups?: string[];
}

export interface GroupConfig {
  id: string;
  /** 데뷔일 (YYYY-MM-DD) */
  debut?: string;
  name: string;
  nameVariants: string[];
  parentNames: string[];
  extraPatterns: string[];
  fandom: string[];
  nicknames: string[];
  members: MemberConfig[];
  formerMembers: { name: string; aliases: string[]; hide: boolean; emojis?: string[] }[];
  units: { name: string; aliases: string[]; members: string[] }[];
  weverse: { community: string };
  youtube: { channels: { id: string; name: string; filter: boolean; guest?: boolean }[]; stageChannels?: string[]; agencyChannels?: string[] };
  community?: { theqoo?: { board: string; categories: { id: string; name: string }[] } };
}

export const GROUP: GroupConfig = JSON.parse(readFileSync(process.env.GROUP_CONFIG ?? join(ROOT, 'config', 'group.json'), 'utf8'));

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 띄어쓰기는 있어도 없어도 되게: "엔시티 드림" ↔ "엔시티드림" */
const flexible = (s: string) => escapeRe(s).replace(/\s+/g, '\\s*');

/** 그룹 이름(표기 변형 포함) + 추가 패턴 */
export const GROUP_NAME_RE = new RegExp([...GROUP.nameVariants.map(flexible), ...GROUP.extraPatterns].join('|'), 'i');
/** 상위 그룹 이름 (NCT, 엔시티) */
export const PARENT_RE = new RegExp(GROUP.parentNames.map(flexible).join('|'), 'i');
export const FANDOM_RE = new RegExp(GROUP.fandom.map(flexible).join('|'), 'i');
export const MEMBER_NAMES = GROUP.members.map((m) => m.name);
