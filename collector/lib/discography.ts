/**
 * 디스코그래피: 공식 채널(SMTOWN·NCT DREAM·NCT)의 MV로 타이틀곡 목록을 만든다.
 *  - 중국어 버전, 다른 가수 곡 피처링, 리믹스(RE:WORKS)는 뺀다
 *  - 주인: 제목에 유닛 이름이 있으면 유닛, 아니면 그룹
 * 위버스 공지가 없는 예전 활동(2016~2023)도 이 목록으로 활동 페이지를 만든다.
 */
import { GROUP, GROUP_NAME_RE } from './group.ts';
import type { Video } from './youtube.ts';

export interface Release { song: string; date: string; mvId: string; owner: { scope: '단체' | '유닛'; members: string[]; label: string } }

const OWN = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
const kst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function buildDiscography(videos: Video[]): Release[] {
  const out: Release[] = [];
  for (const v of videos) {
    if (!OWN.has(v.channel)) continue;
    const t = v.title.normalize('NFKC');
    // 곡 이름이 작은따옴표로 끝나는 경우('Ridin'' MV)도 읽는다
    const m = t.match(/[‘']((?:[^’']|['’](?=[A-Za-z]))+['’]?)[’']\s*MV\b/);
    if (!m) continue;
    if (/teaser|behind|reaction|commentary|performance|dance|remix|re:works|track\s*video|lyric|chinese\s*ver|\(feat\./i.test(t)) continue;
    // 그룹(또는 유닛)이 부른 곡만: 제목 앞부분이 그룹·유닛 이름
    const head = t.slice(0, t.indexOf(m[0]));
    const unit = GROUP.units.find((u) => [u.name, ...u.aliases].some((a) => /[A-Za-z]/.test(a) && head.includes(a)));
    if (!unit && !GROUP_NAME_RE.test(head)) continue;
    // 중국어 제목 버전 ('最後的初戀 (My First and Last)'): 괄호 앞 제목에 한글·영문이 없다
    const mainTitle = m[1].replace(/\([^)]*\)/g, '').trim();
    if (!/[가-힣A-Za-z]/.test(mainTitle)) continue;
    const song = m[1].trim();
    if (out.some((r) => r.song === song)) continue;
    out.push({
      song, date: kst(v.publishedAt), mvId: v.videoId,
      owner: unit ? { scope: '유닛', members: unit.members, label: unit.name } : { scope: '단체', members: [], label: '단체' },
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 검색용 곡 이름: "맛 (Hot Sauce)" → "Hot Sauce", "사랑한단 뜻이야 (Candle Light)" → "Candle Light" */
export const searchName = (song: string) => song.match(/\(([^)]*[A-Za-z][^)]*)\)/)?.[1] ?? song;
