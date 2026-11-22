/**
 * 활동 자동 묶기: 일정 제목 속 작품 이름으로 같은 활동의 일정을 묶는다 (설정에 활동을 적지 않아도 된다).
 *  1) 어휘 만들기: 제목의 따옴표·괄호 속 이름 ('BOTH SIDES', [DUALITY], <THE SWEET DREAM HOTEL>, [THE DREAM SHOW 4 : …] → "THE DREAM SHOW 4")
 *     + 고정 출연 추적 목록(크래시2) + 모아보기 작품 태그(config/tags.json projects, 영상 시리즈)
 *  2) 제목마다 어휘가 들어 있으면 그 이름에 붙이고, 한 제목에 두 이름이 같이 나오면 같은 활동으로 합친다
 *     (예: "DREAM AFTER DREAM 발매 기념 Let's Boogie Woogie!" → 앨범 'DREAM AFTER DREAM' + 곡 <Boogie Woogie>)
 *  3) 종류(컴백·팬미팅·콘서트·드라마…)와 주인(단체·유닛·멤버)은 묶인 일정에서 정한다
 */
import type { PublicEvent } from './consolidate.ts';
import { GROUP } from './group.ts';

export type ActivityKind = '컴백' | '팬미팅' | '콘서트·투어' | '드라마' | '예능' | '팝업' | '시상식' | '페스티벌' | '활동';
export interface Activity {
  id: string;
  name: string;
  kind: ActivityKind;
  /** 같은 활동으로 묶인 이름들 (앨범·곡·투어명 …) */
  keys: string[];
  /** 이 활동에 합쳐진 작은 활동 (예: 컴백 기간의 팝업 "WELCOME, DREAMERS") */
  parts: string[];
  /** 영상 찾기에만 쓰는 이름: 일정 제목에서 작품 이름 옆에 함께 나온 말 (예: "10TH ANNIVERSARY PARTY <THE SWEET DREAM HOTEL>" → "10TH ANNIVERSARY PARTY") */
  videoKeys: string[];
  owner: { scope: '단체' | '유닛' | '멤버'; members: string[]; label: string };
  from: string;
  to: string;
  eventIds: string[];
  /** 한 줄 설명 (예: "맛 (Hot Sauce) 리패키지") */
  subtitle?: string;
}

const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const GENERIC = /^(공지|알림|안내|이벤트|event|notice|티켓|선예매|일반예매|오픈|공식|official|album|앨범|md|preview|gl|팬클럽|멤버십|특전.*|투어 일정|teaser|티저|mv|m\/v|live|라이브|shorts|ep\.?\d+|\d+회|\d{4}|sub|eng|ko|kr|en)$/i;
const NAMES = [...GROUP.nameVariants, ...GROUP.parentNames, ...GROUP.members.flatMap((m) => [m.name, ...m.aliases]), ...GROUP.units.flatMap((u) => [u.name, ...u.aliases])].map(sq);
const EVENT_TYPE_RE = /event|이벤트|팬사인|fansign|video\s*call|영상\s*통화|영통|unboxing|언박싱|mini\s*fan\s*meeting|미니\s*팬미팅|lucky\s*draw|럭키\s*드로우|특전|사인회|응모|pre-?order|예약\s*판매/i;
const PROGRAMS_RE = /뮤직뱅크|음악중심|인기가요|엠카운트다운|쇼\s*챔피언|더\s*쇼|music\s*bank|inkigayo|m\s*countdown/i;

/**
 * 발음 뼈대: 자음 순서만 남긴 것. 한글 표기와 영어 이름이 같은지 본다
 * ("더 스위트 드림 호텔" = "THE SWEET DREAM HOTEL" = TSTLMHTL, "글리치 모드" = "Glitch Mode" = KLJMT, "룸메이트" = "ROOMMATE" = LMT)
 */
const CHO = ['K', 'K', 'N', 'T', 'T', 'L', 'M', 'P', 'P', 'S', 'S', '', 'J', 'J', 'J', 'K', 'T', 'P', 'H'];
const JONG = ['', 'K', 'K', 'K', 'N', 'N', 'N', 'T', 'L', 'L', 'L', 'L', 'L', 'L', 'L', 'L', 'M', 'P', 'P', 'T', 'T', 'N', 'T', 'T', 'K', 'T', 'P', 'T'];
const collapse = (t: string) => t.replace(/(.)\1+/g, '$1');
export function soundSkeleton(name: string): string {
  const t = name.normalize('NFC');
  if (/[가-힣]/.test(t) && !/[A-Za-z]/.test(t)) {
    let out = '';
    for (const ch of t) {
      const c = ch.charCodeAt(0) - 0xac00;
      if (c < 0 || c > 11171) continue;
      out += CHO[Math.floor(c / 588)] + JONG[c % 28];
    }
    return collapse(out);
  }
  if (!/[A-Za-z]/.test(t) || /[가-힣]/.test(t)) return '';
  const words = t.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return collapse(words.map((w) => w
    .replace(/tch/g, 'J').replace(/ch/g, 'J').replace(/sh/g, 'S').replace(/ph/g, 'P').replace(/th/g, 'T').replace(/ck/g, 'K').replace(/ng/g, 'N').replace(/qu/g, 'K').replace(/x/g, 'KS')
    .replace(/c(?=[eiy])/g, 'S').replace(/^h/, 'H').replace(/h/g, '')
    .replace(/[bpfv]/g, 'P').replace(/[ckgq]/g, 'K').replace(/[dt]/g, 'T').replace(/j/g, 'J').replace(/[sz]/g, 'S').replace(/[lr]/g, 'L').replace(/m/g, 'M').replace(/n/g, 'N')
    .replace(/[aeiouwy]/g, '')).join(''));
}
const isHangulName = (t: string) => /[가-힣]/.test(t) && !/[A-Za-z]/.test(t);

/** 제목 속 작품 이름 후보 */
export function quotedNames(title: string): string[] {
  const out: string[] = [];
  // 괄호 안은 작은따옴표가 있어도 된다 ([Lele’s Show 2]), 따옴표 안은 같은 종류 따옴표 전까지
  const t = title.normalize('NFKC');
  const found = [
    ...t.matchAll(/[\[<《「]([^\]>》」]{2,60})[\]>》」]/g),
    ...t.matchAll(/‘((?:[^’]|’(?=[A-Za-z]))+)’/g),
    ...t.matchAll(/'((?:[^']|'(?=[A-Za-z]))+)'(?![A-Za-z])/g),
    ...t.matchAll(/[“"]([^”"]{2,60})[”"]/g),
  ].filter((m) => m[1].length >= 2 && m[1].length <= 60);
  for (const m of found) {
    let name = m[1].split(/\s+[:：]\s*|\s+-\s+/)[0].replace(/^[\s#]+|[\s#,.!]+$/g, '').trim();
    name = name.replace(/^(\d{4}\s+)/, '');
    const k = sq(name);
    if (k.length < 3 || GENERIC.test(name) || EVENT_TYPE_RE.test(name) || NAMES.includes(k) || PROGRAMS_RE.test(name)) continue;
    if (NAMES.some((n) => k === n + k.replace(n, '') && /^\d+$/.test(k.replace(n, '')))) continue; // "NCT 2026" 같은 그룹명+연도
    out.push(name);
  }
  return out;
}

export function findActivities(events: PublicEvent[], extraKeys: string[], articles: { title: string }[] = []): Activity[] {
  // 1) 어휘
  const display = new Map<string, string>();
  for (const e of events) for (const n of quotedNames(e.title)) if (!display.has(sq(n))) display.set(sq(n), n);
  for (const k of extraKeys) if (sq(k).length >= 3 && !display.has(sq(k))) display.set(sq(k), k);
  // 이름 바로 뒤에 숫자가 붙은 후속편("THE DREAM SHOW2 : In A DREAM")은 따로: 따옴표 없이 나와도 어휘에 넣는다 (원래 이름에 묶이지 않게)
  for (const name of [...display.values()].filter((n) => sq(n).length >= 5 && !/\d$/.test(n.trim()))) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s?(\\d))(?![\\p{N}.])`, 'iu');
    for (const e of events) {
      const m = re.exec(e.title.normalize('NFKC'));
      if (m && !display.has(sq(m[2]))) display.set(sq(m[2]), `${name.trim()} ${m[3]}`);
    }
  }
  const vocab = [...display.keys()].sort((a, b) => b.length - a.length);

  // 2) 제목마다 어휘 붙이기 + 함께 나온 이름 합치기 (union-find)
  const parent = new Map(vocab.map((k) => [k, k]));
  const find = (k: string): string => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k)!)), parent.get(k)!));
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  // 긴 이름 안에 짧은 이름이 낱말로 들어 있으면 같은 활동 ("2026 NCT JNJM FANMEETING TOUR [DUALITY]" ⊃ "DUALITY")
  //   단 투어명의 부제(":" 뒤, THE DREAM SHOW 3 : DREAM( )SCAPE)와 그룹 이름(DREAM 등)은 빼고, 짧은 이름은 5글자 넘게
  const groupSq = new Set([GROUP.name, ...GROUP.nameVariants, ...GROUP.parentNames].map(sq));
  for (const long of vocab) for (const short of vocab) {
    if (short === long || short.length < 5 || !long.includes(short) || groupSq.has(short)) continue;
    const shown = (display.get(long) ?? '').normalize('NFKC');
    const core = (display.get(short) ?? '').normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!core || sq(shown.split(/[:：]/).slice(1).join(' ')).includes(short)) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${core}([^\\p{L}\\p{N}]|$)`, 'iu').test(shown)) { if (process.env.DEBUG_UNION && new RegExp(process.env.DEBUG_UNION).test(`${long} ${short}`)) console.log(`[contain] ${long} ⊃ ${short}`); union(long, short); }
  }
  // 한글 표기와 영어 이름이 같은 발음이면 같은 이름 (기사는 한글, 공지는 영어로 쓰는 경우)
  const skel = new Map(vocab.map((k) => [k, soundSkeleton(display.get(k) ?? '')]));
  for (const h of vocab) {
    if (!isHangulName(display.get(h) ?? '') || (skel.get(h) ?? '').length < 3) continue;
    const latin = vocab.find((k) => k !== h && skel.get(k) === skel.get(h) && /[A-Za-z]/.test(display.get(k) ?? ''));
    if (latin) union(h, latin);
  }
  const keysOf = new Map<string, string[]>();
  for (const e of events) {
    const t = sq(e.title);
    const hit: string[] = [];
    for (const k of vocab) if (t.includes(k) && !hit.some((h) => h.includes(k))) hit.push(k);
    if (!hit.length) continue;
    keysOf.set(e.id, hit);
    // "THE DREAM SHOW 3 : DREAM( )SCAPE"처럼 투어명의 부제로 앨범명이 붙은 건 같은 활동이 아니다 (투어 ≠ 앨범)
    const [head, ...tail] = e.title.normalize('NFKC').split(/[:：]/);
    const after = sq(tail.join(' '));
    const isSubtitle = (a: string, b: string) => tail.length > 0 && ((sq(head).includes(a) && after.includes(b) && !sq(head).includes(b)) || (sq(head).includes(b) && after.includes(a) && !sq(head).includes(a)));
    for (let i = 1; i < hit.length; i++) if (!isSubtitle(hit[0], hit[i])) { if (process.env.DEBUG_UNION && new RegExp(process.env.DEBUG_UNION).test(`${hit[0]} ${hit[i]}`)) console.log(`[union] ${hit[0]} + ${hit[i]} ← ${e.date} ${e.title}`); union(hit[0], hit[i]); }
  }

  // 3) 묶음 → 활동
  const groups = new Map<string, PublicEvent[]>();
  for (const e of events) {
    const ks = keysOf.get(e.id);
    if (!ks) continue;
    const root = find(ks[0]);
    groups.set(root, [...(groups.get(root) ?? []), e]);
  }
  const acts: Activity[] = [];
  const chunks: [string, PublicEvent[]][] = [];
  for (const [root, all] of groups) {
    const sorted = [...all].sort((a, b) => a.date.localeCompare(b.date));
    let cur: PublicEvent[] = [];
    for (const e of sorted) {
      const lastEnd = cur.length ? cur.map((x) => x.endDate ?? x.date).sort().at(-1)! : e.date;
      if (cur.length && Date.parse(e.date) - Date.parse(lastEnd) > 90 * 864e5) {
        chunks.push([root, cur]);
        cur = [];
      }
      cur.push(e);
    }
    if (cur.length) chunks.push([root, cur]);
  }
  for (const [root, list] of chunks) {
    if (list.length < 2) continue;
    const keys = [...new Set(list.flatMap((e) => keysOf.get(e.id)!).filter((k) => find(k) === root))];
    const text = list.map((e) => `${e.title} ${e.step}`).join('\n');
    const share = (re: RegExp) => list.filter((e) => re.test(e.title)).length / list.length;
    const ks = keys.map(sq).filter((k) => k.length >= 3);
    const isDrama = /드라마|drama/i.test(text) || articles.filter((a) => /드라마|drama/i.test(a.title) && ks.some((k) => sq(a.title).includes(k))).length >= 2;
    const kind: ActivityKind =
      share(/팝업|pop[\s-]?up/i) >= 0.5 ? '팝업'
      : list.some((e) => e.kind === '발매') && /정규|미니|싱글|앨범|album/i.test(text) ? '컴백'
      : /fan\s*meeting|팬미팅|팬콘|party|파티/i.test(text) ? '팬미팅'
      : /tour|투어|콘서트|concert|dream\s*show/i.test(text) ? '콘서트·투어'
      : /mma|mama|awards|시상식|어워즈/i.test(text) ? '시상식'
      : /페스티벌|festival|코첼라|coachella/i.test(text) ? '페스티벌'
      : isDrama ? '드라마'
      : /팝업|pop[\s-]?up/i.test(text) ? '팝업'
      : list.some((e) => e.kind === '발매') && /정규|미니|싱글|앨범|album|발매/i.test(text) ? '컴백'
      : list.every((e) => e.kind === '방송' || e.kind === '발매') ? '예능'
      : '활동';
    // 주인: 유닛 이름이 나오면 유닛, 모두 같은 한 멤버면 그 멤버, 아니면 단체
    // 유닛: 제목에 유닛 이름(영문)이 나올 때만 ("제노·재민"처럼 멤버 이름만 나열된 건 멤버로)
    const titles = list.map((e) => e.title).join('\n');
    const unit = GROUP.units.find((u) => [u.name, ...u.aliases.filter((a) => /[A-Za-z]/.test(a))].some((a) => titles.includes(a)));
    // 가장 많이 나온 멤버 조합이 절반 이상이면 그 멤버들의 활동 (예: 빈집대성 제노·재민 고정 출연)
    const memberSets = list.map((e) => e.members.join('·'));
    const topSet = [...new Set(memberSets.filter(Boolean))].map((m) => [m, memberSets.filter((x) => x === m).length] as const).sort((a, b) => b[1] - a[1])[0];
    const single = topSet && topSet[1] * 2 >= list.length ? topSet[0].split('·') : null;
    const owner: Activity['owner'] = unit
      ? { scope: '유닛', members: unit.members, label: unit.name }
      : single && single.length < GROUP.members.length - 1
        ? { scope: '멤버', members: single, label: single.join('·') }
        : { scope: '단체', members: [], label: '단체' };
    // 대표 이름: 가장 많이 나온 이름 (곡보다 앨범·투어명이 보통 더 많이 나온다)
    // 긴 이름에 들어 있는 짧은 이름도 함께 센다 ("…TOUR [DUALITY]" 일정도 DUALITY로) → 공통 핵심 이름이 대표가 된다
    const freq = keys.map((k) => [k, list.filter((e) => keysOf.get(e.id)!.some((x) => x === k || (k.length >= 5 && x.includes(k)))).length] as const).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    // 더 긴 이름이 대표 이름을 포함하면 긴 쪽 ("Lele’s Show" → "Lele’s Show 2")
    const top = freq[0][0];
    // 긴 이름은 그 자체로도 자주 나올 때만 (Lele's Show 2는 대부분 일정에 나옴, Beat It Up Showcase는 쇼케이스 일정에만)
    const own = (k: string) => list.filter((e) => keysOf.get(e.id)!.includes(k)).length;
    const topCount = freq[0][1];
    const nameKey = keys.filter((k) => k.startsWith(top) && k !== top && own(k) >= topCount * 0.5).sort((a, b) => b.length - a.length)[0] ?? top;
    const spellings = list.flatMap((e) => quotedNames(e.title)).filter((n) => sq(n) === nameKey);
    let name = spellings.length
      ? [...new Set(spellings)].map((n) => [n, spellings.filter((x) => x === n).length] as const).sort((a, b) => b[1] - a[1])[0][0]
      : display.get(nameKey)!;
    // 한글 이름이면 영어 이름을 쓴다: 같은 발음의 영어 키, 또는 제목 속 "'룸메이트' (ROOMMATE)"
    if (isHangulName(name)) {
      const sameSound = keys.find((k) => /[A-Za-z]/.test(display.get(k) ?? '') && soundSkeleton(display.get(k)!) === soundSkeleton(name));
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const paren = list.map((e) => e.title.normalize('NFKC').match(new RegExp(`${esc}['’"]?\\s*\\(([A-Za-z][^)]{1,40})\\)`))?.[1]).find(Boolean);
      if (sameSound) name = display.get(sameSound)!;
      else if (paren) { name = paren.trim(); if (!display.has(sq(name))) display.set(sq(name), name); if (!keys.includes(sq(name))) keys.push(sq(name)); }
    }
    const dates = list.flatMap((e) => [e.date, e.endDate ?? e.date]).sort();
    // 영상 찾기용 이름: 일정 제목에서 작품 이름·그룹 이름·연도·안내 말을 뗀 나머지 영문 구절 (두 단어 이상, 두 번 이상 나온 것)
    const phraseCount = new Map<string, number>();
    for (const e of list) {
      let rest = e.title.normalize('NFKC');
      for (const k of keys) rest = rest.replace(new RegExp(display.get(k)!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
      for (const n of [...GROUP.nameVariants, ...GROUP.parentNames, ...GROUP.units.map((u) => u.name)]) rest = rest.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
      for (const m of rest.matchAll(/[A-Za-z0-9][A-Za-z0-9 .&'’-]{6,40}[A-Za-z0-9]/g)) {
        const phrase = m[0].replace(/\b(19|20)\d{2}\b/g, '').replace(/\s{2,}/g, ' ').trim();
        if (phrase.split(' ').length < 2 || EVENT_TYPE_RE.test(phrase) || /^(the|in|at|of|and)\b/i.test(phrase) && phrase.split(' ').length < 3) continue;
        phraseCount.set(phrase, (phraseCount.get(phrase) ?? 0) + 1);
      }
    }
    const videoKeys = [...phraseCount.entries()].filter(([, n]) => n >= 2).map(([p]) => p);
    acts.push({
      parts: [],
      videoKeys,
      id: `${dates[0].slice(0, 4)}-${sq(name).replace(/[^a-z0-9가-힣]/g, '').slice(0, 30)}`,
      name, kind, keys: keys.map((k) => display.get(k)!), owner, from: dates[0], to: dates.at(-1)!,
      eventIds: list.map((e) => e.id),
    });
  }
  const merged = mergeParts(acts, events).sort((a, b) => b.from.localeCompare(a.from));
  const seen = new Map<string, number>();
  for (const a of [...merged].reverse()) {
    const n = seen.get(a.id) ?? 0;
    seen.set(a.id, n + 1);
    if (n) a.id = `${a.id}-${a.from.slice(5, 7)}`;
  }
  return merged;
}

/**
 * 작은 활동을 큰 활동에 합친다.
 *  - 팝업·MD처럼 그것만으로 활동이 아닌 것은 같은 주인의 컴백 기간(앞뒤 2주) 안에 있으면 그 컴백에 (WELCOME, DREAMERS → DREAM AFTER DREAM)
 *  - 일정 내용(근거 문장)에 다른 활동 이름이 나오면 그 활동에
 */
const STANDALONE = new Set<string>(['시상식', '팬미팅', '콘서트·투어', '드라마', '페스티벌']);
function mergeParts(acts: Activity[], events: PublicEvent[]): Activity[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const ownerKey = (a: Activity) => `${a.owner.scope}:${a.owner.members.join('·')}`;
  const pad = (d: string, days: number) => new Date(Date.parse(d) + days * 864e5).toISOString().slice(0, 10);
  const absorb = (big: Activity, small: Activity) => {
    const partName = small.name.replace(new RegExp(`^(${[GROUP.name, ...GROUP.units.map((u) => u.name)].map((n) => n.replace(/\s+/g, '\\s*')).join('|')})\\s*[-–:]?\\s*`, 'i'), '').trim() || small.name;
    if (sq(partName) !== sq(big.name) && !big.parts.some((p) => sq(p).endsWith(sq(partName)))) big.parts.push(`${small.kind === '팝업' ? '팝업' : small.kind === '컴백' ? '앨범' : '곡'} ${partName}`);
    big.keys = [...new Set([...big.keys, ...small.keys])];
    big.videoKeys = [...new Set([...big.videoKeys, ...small.videoKeys])];
    big.eventIds = [...new Set([...big.eventIds, ...small.eventIds])];
    big.from = [big.from, small.from].sort()[0];
    big.to = [big.to, small.to].sort()[1];
  };
  const removed = new Set<Activity>();
  for (const small of acts) {
    const evidence = small.eventIds.map((id) => byId.get(id)).filter(Boolean).map((e) => `${e!.evidence} ${e!.step}`).join('\n');
    // 곡: 일정 절반 이상이 음방·사전녹화·사전투표면 그 곡의 음방 활동
    const smallEvents = small.eventIds.map((id) => byId.get(id)).filter(Boolean) as PublicEvent[];
    const isSong = small.kind !== '컴백' && smallEvents.filter((e) => PROGRAMS_RE.test(e.title) || /사전\s*녹화|사전\s*투표|음악\s*방송|음방/.test(e.title)).length * 2 >= smallEvents.length;
    const near = (big: Activity, days: number) => small.from >= pad(big.from, -days) && small.to <= pad(big.to, days);
    const host = acts.find((big) => big !== small && !removed.has(big) && (
      (small.kind === '팝업' && big.kind === '컴백' && ownerKey(big) === ownerKey(small) && near(big, 14))
      || (isSong && big.kind === '컴백' && ownerKey(big) === ownerKey(small) && near(big, 21))
      // 근거 문장에 큰 활동 이름이 나오면 흡수. 단 기간이 가까울 때(앞뒤 30일)만, 그 자체로 독립된 활동(시상식·팬미팅·투어·드라마·페스티벌)은 다른 종류에 흡수하지 않는다
      //   (MMA2026 근거에 후보곡 "DREAM AFTER DREAM" → 흡수 X, 2024-11 DREAMSCAPE ↔ 2024-03 DREAM( )SCAPE → 흡수 X)
      || (big.eventIds.length > small.eventIds.length && near(big, 30) && !(STANDALONE.has(small.kind) && small.kind !== big.kind)
        && big.keys.some((k) => sq(k).length >= 5 && sq(evidence).includes(sq(k))))
    ));
    if (!host) continue;
    absorb(host, small);
    removed.add(small);
  }
  return acts.filter((a) => !removed.has(a));
}

/**
 * 디스코그래피로 활동 채우기: 이미 있는 활동이 그 곡을 품고 있으면 곡 이름만 더하고,
 * 없으면(위버스 공지가 없던 예전 컴백) MV 공개일부터 7주를 활동 기간으로 새로 만든다.
 */
/**
 * 타이틀곡(디스코그래피)을 활동에 붙인다. 기사 제목으로 곡의 성격을 본다:
 *  - 리패키지 ("리패키지 앨범 'Hello Future'"): 앞 활동에 붙이지 않고 따로 활동 (설명 "○○ 리패키지")
 *  - 선공개 ("'Broken Melodies' 선공개"): 45일 안에 나온 다음 타이틀곡 활동에 합치고 활동 이름은 뒤 곡으로
 *  - 그 밖: 같은 이름이 있거나, 활동 시작 2주 전 ~ 3주 뒤에 나온 곡(더블 타이틀·선공개)만 같은 활동
 */
export function addReleases(
  acts: Activity[],
  releases: { song: string; date: string; owner: Activity['owner'] }[],
  articles: { title: string; publishedAt: string }[] = [],
  events: PublicEvent[] = [],
): Activity[] {
  const pad = (d: string, days: number) => new Date(Date.parse(d) + days * 864e5).toISOString().slice(0, 10);
  const assigned = new Set(acts.flatMap((a) => a.eventIds));
  const namesOf = (song: string) => [song.replace(/\([^)]*\)/g, ''), ...[...song.matchAll(/\(([^)]+)\)/g)].map((m) => m[1])].map(sq).filter((n) => n.length >= 3);
  const evidence = (r: { song: string; date: string }, re: RegExp) => articles.some((a) => {
    const d = a.publishedAt.slice(0, 10);
    return d >= pad(r.date, -30) && d <= pad(r.date, 30) && re.test(a.title) && namesOf(r.song).some((n) => sq(a.title).includes(n));
  });
  const preReleaseActs = new Set<Activity>();
  for (const r of [...releases].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = sq(r.song);
    const isRepackage = evidence(r, /리패키지|repackage/i);
    // 이름 겹침은 4글자 넘을 때만 ("GO"가 "Go Back To The Future"에 붙지 않게)
    const overlap = (k: string) => sq(k) === key || (key.length > 4 && sq(k).length > 4 && (sq(k).includes(key) || key.includes(sq(k))));
    const sameOwner = (a: Activity) => a.kind === '컴백' && a.owner.scope === r.owner.scope && a.owner.label === r.owner.label;
    const byName = acts.find((a) => a.keys.some(overlap));
    const preHost = isRepackage ? undefined : acts.find((a) => preReleaseActs.has(a) && sameOwner(a) && r.date > a.from && r.date <= pad(a.from, 45));
    const byDate = isRepackage ? undefined : acts.find((a) => sameOwner(a) && r.date >= pad(a.from, -14) && r.date <= pad(a.from, 21));
    const host = byName ?? preHost ?? byDate;
    if (host) {
      if (host === preHost && !byName) {
        // 선공개곡 활동 → 이 곡(앨범 타이틀) 활동으로 이름을 바꾼다
        host.parts.push(`선공개 ${host.name}`);
        host.name = r.song;
        host.id = `${r.date.slice(0, 4)}-${key.replace(/[^a-z0-9가-힣]/g, '').slice(0, 30) || 'release'}`;
        host.to = pad(r.date, 49);
        preReleaseActs.delete(host);
      } else if (host.kind === '컴백' && !host.parts.some((p) => sq(p).endsWith(key)) && sq(host.name) !== key) host.parts.push(`곡 ${r.song}`);
      if (!host.keys.some((k) => sq(k) === key)) host.keys.push(r.song);
      // 타이틀곡이 붙은 컴백은 적어도 MV 공개 후 7주가 활동 기간 (일정 몇 개만 있으면 기간이 짧아져 그 뒤 무대·비하인드 영상이 빠짐)
      if (host.kind === '컴백' && host.to < pad(r.date, 49)) {
        const next = acts.filter((a) => a !== host && sameOwner(a) && a.from > r.date).map((a) => a.from).sort()[0];
        host.to = next && next <= pad(r.date, 49) ? pad(next, -1) : pad(r.date, 49);
      }
      continue;
    }
    const prev = isRepackage ? acts.filter((a) => sameOwner(a) && a.from < r.date).sort((a, b) => b.from.localeCompare(a.from))[0] : undefined;
    const act: Activity = {
      id: `${r.date.slice(0, 4)}-${key.replace(/[^a-z0-9가-힣]/g, '').slice(0, 30) || 'release'}`,
      name: r.song, kind: '컴백', keys: [r.song, ...(r.song.match(/\(([^)]+)\)/) ? [r.song.match(/\(([^)]+)\)/)![1]] : [])],
      owner: r.owner, from: r.date, to: pad(r.date, 49), eventIds: [], parts: [], videoKeys: [],
      subtitle: isRepackage ? `${prev ? `${prev.name} ` : ''}리패키지` : undefined,
    };
    // MV로 새로 만든 컴백에도 그 시기 일정을 붙인다: 제목·단계에 곡 이름이 나오는 일정 (프로그램 이름이 제목인 "더 스테이지 · 타이틀곡 'Ridin''"),
    // 발매 1주 안의 앨범 발매 일정 ("새 앨범 '리로드'(Reload) 발매"). 다른 활동에 이미 묶인 일정은 건드리지 않는다
    const names = namesOf(r.song);
    for (const e of events) {
      if (assigned.has(e.id) || e.date < pad(r.date, -14) || e.date > act.to) continue;
      const text = sq(`${e.title} ${e.step}`);
      const album = e.kind === '발매' && Math.abs(Date.parse(e.date) - Date.parse(r.date)) <= 7 * 864e5 && /앨범|album|정규|미니/i.test(`${e.title} ${e.step}`);
      if (names.some((n) => text.includes(n)) || album) { act.eventIds.push(e.id); assigned.add(e.id); }
    }
    // 앞 활동과 기간이 겹치면 앞 활동을 이 곡 전날까지로 줄인다 (영상·기사가 두 활동에 겹치지 않게)
    for (const a of acts) if (sameOwner(a) && a.from < r.date && a.to >= r.date) a.to = pad(r.date, -1);
    acts.push(act);
    if (evidence(r, /선공개|pre-?release/i)) preReleaseActs.add(act);
  }
  return acts.sort((a, b) => b.from.localeCompare(a.from));
}
