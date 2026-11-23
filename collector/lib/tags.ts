/**
 * 모아보기 태그: 일정·소식마다 여러 태그를 붙여 특정 활동만 모아 볼 수 있게 한다.
 *  - 활동기(era)   config/tags.json 의 날짜 범위 + 키워드 (예: Boogie Woogie 활동). 음악방송은 범위 안이면 그 활동기
 *  - 작품(project) config/tags.json 키워드 + 자동: 영상 제목의 "OO EP.n" 시리즈, 고정 출연 추적 목록
 *  - 종류(type)    자체 콘텐츠 · 외부 출연 · 음악방송 · 공연·행사 · 참여(신청·예매·투표)
 *  - 연도(year), 멤버(member: 이름이 나온 멤버, 단체)
 * 태그 id 예: "era:boogie-woogie", "project:crash2", "type:외부 출연", "year:2026", "member:지성"
 */
import { stripBroadcaster } from './broadcasters.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicEvent } from './consolidate.ts';
import { GROUP, GROUP_NAME_RE } from './group.ts';
import { ROOT } from './store.ts';
import type { Tracked } from './tracked.ts';

interface Era { id: string; name: string; from: string; to: string; keywords: string[] }
interface Project { id: string; name: string; keywords: string[] }
const CONFIG: { eras: Era[]; projects: Project[] } = JSON.parse(readFileSync(join(ROOT, 'config', 'tags.json'), 'utf8'));
const PROGRAMS: { names: string[] }[] = JSON.parse(readFileSync(join(ROOT, 'config', 'programs.json'), 'utf8')).programs;
const OWN_CHANNELS = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));

export type TagKind = 'era' | 'project' | 'type' | 'year' | 'member';
export interface TagInfo { id: string; kind: TagKind; name: string; count: number }

const squash = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const has = (text: string, kw: string) => squash(text).includes(squash(kw));
const isMusicShow = (text: string) => PROGRAMS.some((p) => p.names.some((n) => has(text, n)));

/** 영상 제목에서 시리즈 이름: "모먹티비 EP.37", "빈집대성 ep.8", "| OFF TO DREAM in Mukho | EP.2", "[리무진서비스 EP242]" */
export function seriesName(title: string): string | null {
  const t = title.normalize('NFKC');
  // "|" 로 나뉜 제목: 회차(Ep.N) 칸의 앞 글자 → 회차 칸 다음 칸(시리즈 이름이 뒤에 오는 형식) → 회차 칸 앞 칸
  //   "부산에서 … | 천지의 이것저것 시즌2 Ep.15" → 천지의 이것저것 시즌2
  //   "내기를 한 번 해볼까? | Ep.1 실탄 사격 | JUST DO IT:제대로 재밌게" → JUST DO IT:제대로 재밌게
  //   "하늘을 나는 … | OFF TO DREAM in Mukho | EP.2" → OFF TO DREAM in Mukho
  const EP = /\b(?:EP|ep|Ep)\.?\s*\d+/;
  const segs = t.split(/\s*[|｜]\s*|\s+l\s+/).map((x) => x.trim()).filter(Boolean);
  const epIdx = segs.findIndex((x) => EP.test(x));
  const tidy = (x: string) => x.replace(/^[\s\-–#]+|[\s\-–:]+$/g, '').trim();
  if (segs.length > 1 && epIdx >= 0) {
    let before = segs[epIdx].split(EP)[0];
    if (before.includes('[')) before = before.slice(before.lastIndexOf('[') + 1);
    before = tidy(before.replace(/#\S+/g, ''));
    if (squash(before).length >= 2) return before;
    const after = segs[epIdx + 1];
    if (after && !after.startsWith('#') && squash(tidy(after.replace(/#\S+/g, ''))).length >= 2) return tidy(after.replace(/#\S+/g, ''));
    const prev = segs[epIdx - 1];
    if (epIdx > 0 && prev && squash(tidy(prev)).length >= 2) return tidy(prev);
  }
  const m = t.match(/(?:^|[|\[｜(/])\s*([^|\[\]｜()/]{2,40}?)\s*[|｜]?\s*\bEP\.?\s*\d+/i);
  if (!m) return null;
  const name = m[1].replace(/^[\s\-–#]+|[\s\-–:]+$/g, '').trim();
  return squash(name).length >= 2 ? name : null;
}

export class Tagger {
  private projects: Project[];
  private names = new Map<string, string>();

  constructor(opts: { videoTitles: string[]; tracked: Tracked[] }) {
    // 자동 작품 태그: 영상 시리즈 + 고정 출연 추적
    const auto = new Map<string, Project>();
    for (const t of opts.videoTitles) {
      const name = seriesName(t);
      // 그룹 이름만 있는 "시리즈"(예: "NCT DREAM 엔시티 드림 EP.1" 트레일러)는 활동기 태그로 충분하다
      if (!name || OWN_CHANNELS.has(name) || GROUP_NAME_RE.test(name)) continue;
      const id = squash(name);
      if (!CONFIG.projects.some((p) => p.keywords.some((k) => has(name, k))) && !auto.has(id)) auto.set(id, { id, name, keywords: [name] });
    }
    for (const t of opts.tracked) {
      const core = stripBroadcaster(t.title);
      const id = squash(core);
      if (!CONFIG.projects.some((p) => p.keywords.some((k) => has(core, k))) && !auto.has(id)) auto.set(id, { id, name: core, keywords: [core] });
    }
    this.projects = [...CONFIG.projects, ...auto.values()];
    for (const e of CONFIG.eras) this.names.set(`era:${e.id}`, e.name);
    for (const p of this.projects) this.names.set(`project:${p.id}`, p.name);
  }

  private common(text: string, date: string, members: string[]): string[] {
    const tags: string[] = [];
    for (const era of CONFIG.eras) {
      if (date >= era.from && date <= era.to && (era.keywords.some((k) => has(text, k)) || isMusicShow(text))) tags.push(`era:${era.id}`);
    }
    for (const p of this.projects) if (p.keywords.some((k) => has(text, k))) tags.push(`project:${p.id}`);
    tags.push(`year:${date.slice(0, 4)}`);
    if (members.length) for (const m of members) tags.push(`member:${m}`);
    else tags.push('member:단체');
    return tags;
  }

  event(e: PublicEvent): string[] {
    const text = [e.title, e.step, e.evidence, ...e.sources.map((s) => s.title)].join('\n');
    const tags = this.common(text, e.date, e.members);
    const yt = e.sources.filter((s) => s.type === 'youtube');
    if (e.category === '참여') tags.push('type:참여');
    else if (isMusicShow(`${e.title} ${e.step}`)) tags.push('type:음악방송');
    else if (yt.length && yt.every((s) => OWN_CHANNELS.has(s.publisher ?? ''))) tags.push('type:자체 콘텐츠');
    else if (e.kind === '방송' || e.kind === '발매') tags.push(yt.some((s) => !OWN_CHANNELS.has(s.publisher ?? '')) || e.kind === '방송' ? 'type:외부 출연' : 'type:발매');
    if (e.kind === '행사') tags.push('type:공연·행사');
    return [...new Set(tags)];
  }

  feed(f: { type: string; title: string; publisher?: string; publishedAt: string; members: string[]; guest?: boolean }): string[] {
    const date = new Date(new Date(f.publishedAt).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const tags = this.common(`${f.title}\n${f.publisher ?? ''}`, date, f.members);
    if (f.type === 'youtube') tags.push(OWN_CHANNELS.has(f.publisher ?? '') ? 'type:자체 콘텐츠' : isMusicShow(f.title) ? 'type:음악방송' : 'type:외부 출연');
    return [...new Set(tags)];
  }

  /** 작품 태그 이름들 (활동 자동 묶기 어휘로 쓴다) */
  projectNames(): string[] {
    return this.projects.map((p) => p.keywords[0]);
  }

  /** 붙은 태그 목록과 개수 (사이트의 모아보기 메뉴용) */
  index(all: string[][]): TagInfo[] {
    const count = new Map<string, number>();
    for (const tags of all) for (const t of tags) count.set(t, (count.get(t) ?? 0) + 1);
    const order: TagKind[] = ['era', 'project', 'type', 'member', 'year'];
    return [...count.entries()]
      .map(([id, n]) => {
        const kind = id.split(':')[0] as TagKind;
        return { id, kind, name: this.names.get(id) ?? id.slice(id.indexOf(':') + 1), count: n };
      })
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.count - a.count);
  }
}
