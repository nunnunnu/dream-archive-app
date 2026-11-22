/**
 * 응원법 게임 채보: 스키마, 검사, 노래 시각 ↔ 영상 시각 (FANCHANT_GAME_SPEC.md §3.3·§4)
 * 어드민 저장 API(서버), 채보 도구·게임 화면(브라우저), 수집기 공개 단계가 함께 쓴다. 순수 함수만.
 */
export type FanchantMode = 'guide' | 'mv';
/** hold: 길게 누르는 큐의 길이(초, 노래 시각). 없으면 탭 한 번 */
export interface FanchantCue { t: number; text: string; member?: string; section?: string; hold?: number }
export interface FanchantSegment { from: number; to: number; offset: number }
export interface FanchantVideo { mode: FanchantMode; youtubeId: string; offset: number; segments?: FanchantSegment[] }
export interface FanchantChart {
  songId: string;
  title: string;
  album?: string;
  year?: number;
  durationSec: number;
  bpm?: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  difficultyLabel: string;
  author: string;
  verified: boolean;
  cover?: { youtubeId: string; credit?: string };
  cues: FanchantCue[];
  videos: FanchantVideo[];
  /** 어드민 저장 정보 (공개 파일에는 빠진다) */
  updatedAt?: string;
  updatedBy?: string;
}
export interface FanchantIndexSong {
  songId: string; title: string; album?: string; year?: number;
  difficulty: number; difficultyLabel: string; noteCount: number; durationSec: number;
  author: string; verified: boolean; coverYoutubeId?: string; hasGuide: boolean; hasMv: boolean;
}

/** config/fanchant.json 이 없을 때 쓰는 기본값 (원본은 config) */
export const FANCHANT_DEFAULTS = {
  perfectMs: 80, goodMs: 150, approachMs: 1500, step2LookaheadMs: 350, step2LingerMs: 80, clockSampleMs: 200,
  minCueGapMs: 80, holdMinMs: 300, nudgeMs: 10, practiceLeadInSec: 3, practiceTrailSec: 1.5, missGroupSec: 8, maxMissSections: 3,
  clearAccuracy: 0.7, storagePrefix: 'fanchant.',
};
export type FanchantConfig = typeof FANCHANT_DEFAULTS;

export const DIFFICULTY_LABELS = ['쉬움', '보통', '조금 어려움', '어려움'] as const;
/** 난이도 점(1~5) → 표시 이름: 1 쉬움, 2·3 보통, 4 조금 어려움, 5 어려움 */
export const difficultyLabelOf = (d: number) => DIFFICULTY_LABELS[[0, 0, 1, 1, 2, 3][Math.round(d)] ?? 1];
export const SONG_ID = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const YT_ID = /^[\w-]{11}$/;
/** 공개 폴더에서 따로 쓰는 이름이라 곡 ID로 못 쓴다 */
const RESERVED = new Set(['index', 'config']);
const LIMITS = { cues: 3000, text: 40, section: 40, title: 80 };

/** 유튜브 주소나 ID에서 11자리 ID 꺼내기 */
export function youtubeIdFrom(input: string): string | null {
  const s = input.trim();
  if (YT_ID.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    const id = host === 'youtu.be' ? u.pathname.slice(1).split('/')[0]
      : host === 'youtube.com' || host === 'youtube-nocookie.com'
        ? u.searchParams.get('v') ?? u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1] ?? ''
        : '';
    return YT_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** 제목에서 곡 ID 제안 (영문·숫자만 남김, 한글 제목이면 빈 값) */
export const suggestSongId = (title: string) =>
  title.normalize('NFKD').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** 이 영상 시각에 쓰는 오프셋 (segments 의 [from, to) 안이면 그 구간 값) */
export function activeOffset(v: Pick<FanchantVideo, 'offset' | 'segments'>, videoTime: number): number {
  const seg = v.segments?.find((s) => videoTime >= s.from && videoTime < s.to);
  return seg ? seg.offset : v.offset;
}
export const songTimeAt = (v: Pick<FanchantVideo, 'offset' | 'segments'>, videoTime: number) => videoTime - activeOffset(v, videoTime);

/** 노래 시각 → 영상 시각. 구간 오프셋이 걸리는 곳이면 그 구간 값으로 (구간 밖으로 나가면 기본 오프셋) */
export function videoTimeAt(v: Pick<FanchantVideo, 'offset' | 'segments'>, songTime: number): number {
  for (const s of v.segments ?? []) {
    const vt = songTime + s.offset;
    if (vt >= s.from && vt < s.to) return vt;
  }
  return songTime + v.offset;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);

export interface ChartCheck { chart: FanchantChart | null; errors: string[]; warnings: string[] }

/**
 * 채보 검사 + 정리. errors 가 있으면 저장하지 않는다. warnings 는 저장은 되지만 확인할 것.
 * memberSlugs 를 주면 큐 member 가 그 안에 있는지 경고만 한다.
 */
export function checkChart(input: unknown, opts: { memberSlugs?: string[]; minCueGapMs?: number } = {}): ChartCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input || typeof input !== 'object') return { chart: null, errors: ['채보 형식이 아니에요'], warnings };
  const o = input as Record<string, unknown>;

  const songId = str(o.songId, 60);
  if (!SONG_ID.test(songId) || RESERVED.has(songId)) errors.push('곡 ID는 영문 소문자·숫자·하이픈으로 (예: when-im-with-you)');
  const title = str(o.title, LIMITS.title);
  if (!title) errors.push('곡 제목이 필요해요');
  const author = str(o.author, 40);
  if (!author) errors.push('채보 제작자 표시명이 필요해요');
  const durationSec = num(o.durationSec);
  if (!(durationSec > 0 && durationSec < 3600)) errors.push('노래 길이(초)가 필요해요');
  const difficulty = Math.round(num(o.difficulty));
  if (!(difficulty >= 1 && difficulty <= 5)) errors.push('난이도는 1~5');
  const difficultyLabel = str(o.difficultyLabel, 20) || difficultyLabelOf(difficulty);
  const year = num(o.year);
  const bpm = num(o.bpm);

  const videos: FanchantVideo[] = [];
  for (const raw of Array.isArray(o.videos) ? o.videos : []) {
    const v = raw as Record<string, unknown>;
    const mode = v.mode === 'guide' || v.mode === 'mv' ? v.mode : null;
    const youtubeId = youtubeIdFrom(String(v.youtubeId ?? ''));
    const offset = num(v.offset);
    if (!mode) { errors.push('영상 종류는 guide 또는 mv'); continue; }
    if (!youtubeId) { if (String(v.youtubeId ?? '').trim()) errors.push(`${mode === 'guide' ? '가이드' : '뮤비'} 유튜브 주소를 알아보지 못했어요`); continue; }
    if (!Number.isFinite(offset) || offset < 0 || offset > 600) { errors.push(`${mode === 'guide' ? '가이드' : '뮤비'} 노래 시작 오프셋(초)이 필요해요`); continue; }
    if (videos.some((x) => x.mode === mode)) { errors.push(`${mode} 영상이 두 개예요`); continue; }
    const segments: FanchantSegment[] = [];
    for (const sr of Array.isArray(v.segments) ? v.segments : []) {
      const s = sr as Record<string, unknown>;
      const from = num(s.from), to = num(s.to), off = num(s.offset);
      if (![from, to, off].every(Number.isFinite) || from < 0 || to <= from) { errors.push(`${mode} 구간 오프셋은 시작 < 끝, 숫자로`); continue; }
      segments.push({ from: r3(from), to: r3(to), offset: r3(off) });
    }
    segments.sort((a, b) => a.from - b.from);
    if (segments.some((s, i) => i > 0 && s.from < segments[i - 1].to)) errors.push(`${mode} 구간 오프셋이 서로 겹쳐요`);
    videos.push({ mode, youtubeId, offset: r3(offset), ...(segments.length ? { segments } : {}) });
  }
  if (!videos.some((v) => v.mode === 'guide')) errors.push('연습용 가이드 영상(guide)이 필요해요');
  if (!videos.some((v) => v.mode === 'mv')) warnings.push('뮤비(mv)가 없어서 실전 모드는 꺼져요');

  const slugs = opts.memberSlugs?.length ? new Set(opts.memberSlugs) : null;
  const cues: FanchantCue[] = [];
  const rawCues = Array.isArray(o.cues) ? o.cues : [];
  if (rawCues.length > LIMITS.cues) errors.push(`큐가 너무 많아요 (${LIMITS.cues}개까지)`);
  for (const rc of rawCues.slice(0, LIMITS.cues)) {
    const c = rc as Record<string, unknown>;
    const t = num(c.t);
    if (!Number.isFinite(t) || t < 0) { errors.push('큐 시각은 0 이상의 숫자(초)'); continue; }
    const cue: FanchantCue = { t: r3(t), text: str(c.text, LIMITS.text) };
    const member = str(c.member, 20);
    const section = str(c.section, LIMITS.section);
    if (member) cue.member = member;
    if (section) cue.section = section;
    const hold = num(c.hold);
    if (Number.isFinite(hold) && hold > 0) {
      if (hold > 60) errors.push('길게 누르기는 60초까지');
      else cue.hold = r3(hold);
    }
    cues.push(cue);
  }
  cues.sort((a, b) => a.t - b.t);
  if (!cues.length) warnings.push('큐가 아직 없어요');
  const empty = cues.filter((c) => !c.text).length;
  if (empty) warnings.push(`문구가 빈 큐 ${empty}개`);
  const gap = (opts.minCueGapMs ?? FANCHANT_DEFAULTS.minCueGapMs) / 1000;
  const close = cues.filter((c, i) => i > 0 && c.t - cues[i - 1].t < gap).length;
  if (close) warnings.push(`${Math.round(gap * 1000)}ms보다 가까운 큐 ${close}개 (입력이 하나라 앞 큐만 판정돼요)`);
  const overlap = cues.filter((c, i) => c.hold && i + 1 < cues.length && c.t + c.hold > cues[i + 1].t).length;
  if (overlap) warnings.push(`길게 누르는 동안 다음 큐가 시작되는 곳 ${overlap}개`);
  if (Number.isFinite(durationSec) && cues.some((c) => c.t > durationSec)) warnings.push('노래 길이보다 뒤에 있는 큐가 있어요');
  if (slugs) {
    const bad = [...new Set(cues.map((c) => c.member).filter((m): m is string => Boolean(m) && !slugs.has(m!)))];
    if (bad.length) warnings.push(`멤버 이름을 확인해 주세요: ${bad.join(', ')}`);
  }

  const verified = o.verified === true;
  if (verified && (cues.length === 0 || empty)) errors.push('공개하려면 큐가 있고 모든 큐에 문구가 있어야 해요');

  const coverId = youtubeIdFrom(String((o.cover as Record<string, unknown> | undefined)?.youtubeId ?? '')) ?? videos.find((v) => v.mode === 'guide')?.youtubeId;
  const credit = str((o.cover as Record<string, unknown> | undefined)?.credit, 60);
  if (errors.length) return { chart: null, errors, warnings };
  const chart: FanchantChart = {
    songId, title,
    ...(str(o.album, 60) ? { album: str(o.album, 60) } : {}),
    ...(year >= 2016 && year <= 2100 ? { year: Math.round(year) } : {}),
    durationSec: r3(durationSec),
    ...(bpm > 0 && bpm < 400 ? { bpm: Math.round(bpm * 10) / 10 } : {}),
    difficulty: difficulty as FanchantChart['difficulty'], difficultyLabel, author, verified,
    ...(coverId ? { cover: { youtubeId: coverId, ...(credit ? { credit } : {}) } } : {}),
    cues, videos,
  };
  return { chart, errors, warnings };
}

/** 공개용 파일: 어드민 저장 정보는 뺀다 */
export function publicChart(c: FanchantChart): FanchantChart {
  const { updatedAt: _a, updatedBy: _b, ...rest } = c;
  return rest;
}

export function indexEntry(c: FanchantChart): FanchantIndexSong {
  return {
    songId: c.songId, title: c.title, album: c.album, year: c.year, difficulty: c.difficulty, difficultyLabel: c.difficultyLabel,
    noteCount: c.cues.length, durationSec: c.durationSec, author: c.author, verified: c.verified, coverYoutubeId: c.cover?.youtubeId,
    hasGuide: c.videos.some((v) => v.mode === 'guide'), hasMv: c.videos.some((v) => v.mode === 'mv'),
  };
}

/** 초 → "1:05.320" */
export function fmtTime(sec: number, digits = 2): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}`;
}
