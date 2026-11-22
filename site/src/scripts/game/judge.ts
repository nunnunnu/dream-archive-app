/**
 * 판정·콤보·점수·등급 (FANCHANT_GAME_SPEC.md §5·§6·§11.3, 순수 함수)
 *  - delta = 입력 노래 시각 − 기준 시각 (ms, 입력 보정 뺀 값). 음수 = 빠름(EARLY), 양수 = 늦음(LATE)
 *  - 창 밖 탭은 무시(허공 탭으로 콤보가 깨지지 않게), 큐가 +goodMs 지나도록 입력이 없으면 자동 MISS
 *  - 홀드 큐는 판정이 두 번: 누름(cue.t, ±goodMs) + 뗌(cue.t + duration, ±goodReleaseMs).
 *    너무 일찍 떼거나 끝+goodReleaseMs 까지 안 떼면 뗌 MISS, 누름을 놓치면 뗌도 MISS
 *  - 건너뛴(시크·구간 밖) 큐는 점수 분모에서 뺀다
 */
export type Judge = 'perfect' | 'good' | 'miss';
export type Grade = 'SS' | 'S' | 'A' | 'B' | 'C' | 'D';
export interface JudgeConfig { perfectMs: number; goodMs: number; goodReleaseMs: number; clearAccuracy: number }
export interface NoteResult { judge: Judge | 'skip'; deltaMs?: number; points?: number }
export interface JudgeCue { t: number; type?: 'tap' | 'hold'; duration?: number }
export interface TapResult { index: number; kind: 'press' | 'release'; judge: Judge; deltaMs: number; points: number; combo: number; hold: number }
interface Note { cue: number; t: number; kind: 'press' | 'release' }

/** 홀드 길이(초). 홀드가 아니면 0 */
export const holdOf = (c: JudgeCue & { hold?: number }) => (c.type === 'hold' ? c.duration ?? 0 : c.hold ?? 0);

export function judgeOf(deltaMs: number, w: { perfectMs: number; goodMs: number }): Judge | null {
  const a = Math.abs(deltaMs);
  if (a <= w.perfectMs) return 'perfect';
  if (a <= w.goodMs) return 'good';
  return null;
}

/** 만점: 판정 n번을 모두 PERFECT·풀콤보 */
export const maxScoreFor = (n: number) => n * 1000 + (10 * n * (n + 1)) / 2;

export function gradeOf(accuracy: number): Grade {
  if (accuracy >= 0.95) return 'SS';
  if (accuracy >= 0.9) return 'S';
  if (accuracy >= 0.8) return 'A';
  if (accuracy >= 0.7) return 'B';
  if (accuracy >= 0.6) return 'C';
  return 'D';
}

export class Judger {
  /** 판정 단위 (탭 큐 1개, 홀드 큐 2개: 누름·뗌) */
  readonly notes: Note[] = [];
  readonly results: (NoteResult | null)[];
  private pressNote: number[] = []; // 큐 번호 → 누름 노트 번호
  private releaseNote: number[] = []; // 큐 번호 → 뗌 노트 번호 (없으면 -1)
  combo = 0;
  maxCombo = 0;
  score = 0;
  /** 지금 누르고 있는 홀드 큐 */
  holding: { index: number; endT: number } | null = null;
  private firstPress = 0; // 이 앞의 누름 노트는 모두 처리됨 (큐 번호)

  constructor(private cues: readonly JudgeCue[], private cfg: JudgeConfig) {
    cues.forEach((c, i) => {
      this.pressNote[i] = this.notes.push({ cue: i, t: c.t, kind: 'press' }) - 1;
      const d = holdOf(c);
      this.releaseNote[i] = d > 0 ? this.notes.push({ cue: i, t: c.t + d, kind: 'release' }) - 1 : -1;
    });
    this.results = this.notes.map(() => null);
  }

  /** 큐의 누름 판정 (레인·문구 표시용) */
  pressResult(i: number) { return this.results[this.pressNote[i]]; }
  /** 큐의 판정 중 가장 나쁜 것 (놓친 구간용) */
  cueResult(i: number): NoteResult | null {
    const a = this.results[this.pressNote[i]];
    const b = this.releaseNote[i] >= 0 ? this.results[this.releaseNote[i]] : null;
    if (!a || a.judge === 'skip') return a;
    const rank = { miss: 0, good: 1, perfect: 2, skip: 3 };
    return b && rank[b.judge] < rank[a.judge] ? b : a;
  }

  /** 구간 밖·건너뛴 큐 (점수 분모에서 뺌, 홀드면 누름·뗌 모두) */
  skip(pred: (t: number, i: number) => boolean): number {
    let n = 0;
    this.cues.forEach((c, i) => {
      if (this.results[this.pressNote[i]] || !pred(c.t, i)) return;
      this.results[this.pressNote[i]] = { judge: 'skip' };
      if (this.releaseNote[i] >= 0) this.results[this.releaseNote[i]] = { judge: 'skip' };
      n++;
    });
    this.moveFirst();
    return n;
  }

  private hit(note: number, judge: Judge, deltaMs: number): number {
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const points = judge === 'perfect' ? 1000 + this.combo * 10 : 500 + this.combo * 5;
    this.score += points;
    this.results[note] = { judge, deltaMs, points };
    return points;
  }
  private miss(note: number, deltaMs?: number) {
    this.results[note] = { judge: 'miss', ...(deltaMs !== undefined ? { deltaMs } : {}) };
    this.combo = 0;
  }

  /** 누름: 창 안의 가장 가까운 미처리 큐 하나에만 붙인다. 없으면 null(무시) */
  tap(songT: number): TapResult | null {
    const win = this.cfg.goodMs / 1000;
    let best = -1;
    let bestAbs = Infinity;
    for (let i = this.firstPress; i < this.cues.length; i++) {
      const d = songT - this.cues[i].t;
      if (d < -win) break;
      if (this.results[this.pressNote[i]] || d > win) continue;
      if (Math.abs(d) < bestAbs) { bestAbs = Math.abs(d); best = i; }
    }
    if (best < 0) return null;
    const deltaMs = Math.round((songT - this.cues[best].t) * 1000);
    const judge = judgeOf(deltaMs, this.cfg) ?? 'good';
    const points = this.hit(this.pressNote[best], judge, deltaMs);
    const hold = holdOf(this.cues[best]);
    this.holding = hold > 0 ? { index: best, endT: this.cues[best].t + hold } : null;
    this.moveFirst();
    return { index: best, kind: 'press', judge, deltaMs, points, combo: this.combo, hold };
  }

  /** 뗌: 누르고 있던 홀드의 끝과 비교. 홀드 중이 아니면 null */
  release(songT: number): TapResult | null {
    const h = this.holding;
    if (!h) return null;
    this.holding = null;
    const note = this.releaseNote[h.index];
    const deltaMs = Math.round((songT - h.endT) * 1000);
    const judge = judgeOf(deltaMs, { perfectMs: this.cfg.perfectMs, goodMs: this.cfg.goodReleaseMs });
    if (!judge) {
      this.miss(note, deltaMs);
      return { index: h.index, kind: 'release', judge: 'miss', deltaMs, points: 0, combo: 0, hold: 0 };
    }
    const points = this.hit(note, judge, deltaMs);
    return { index: h.index, kind: 'release', judge, deltaMs, points, combo: this.combo, hold: 0 };
  }

  /** 시계 진행: 지난 누름은 MISS(홀드면 뗌도), 끝+창이 지나도록 안 뗀 홀드는 뗌 MISS. 새로 MISS 된 큐 번호들 */
  advance(songT: number): number[] {
    const missed: number[] = [];
    if (this.holding && songT - this.holding.endT > this.cfg.goodReleaseMs / 1000) {
      const i = this.holding.index;
      this.holding = null;
      this.miss(this.releaseNote[i]);
      missed.push(i);
    }
    const win = this.cfg.goodMs / 1000;
    for (let i = this.firstPress; i < this.cues.length && songT - this.cues[i].t > win; i++) {
      if (this.results[this.pressNote[i]]) continue;
      this.miss(this.pressNote[i]);
      if (this.releaseNote[i] >= 0) this.results[this.releaseNote[i]] = { judge: 'miss' };
      missed.push(i);
    }
    this.moveFirst();
    return missed;
  }

  /** 영상이 끝났을 때: 남은 판정 모두 MISS */
  finish(): number[] {
    const missed = this.advance(Infinity);
    this.notes.forEach((_, n) => { if (!this.results[n]) this.miss(n); });
    return missed;
  }

  get done() { return this.firstPress >= this.cues.length && !this.holding; }
  get nextIndex() { return this.firstPress; }

  summary() {
    const counted = this.results.filter((r) => r && r.judge !== 'skip') as NoteResult[];
    const n = this.results.filter((r) => r?.judge !== 'skip').length;
    const perfect = counted.filter((r) => r.judge === 'perfect').length;
    const good = counted.filter((r) => r.judge === 'good').length;
    const miss = n - perfect - good;
    const accuracy = n ? (perfect + good * 0.5) / n : 0;
    const deltas = counted.filter((r) => r.judge !== 'miss' && r.deltaMs !== undefined).map((r) => r.deltaMs!);
    const avgDeltaMs = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
    const rel = this.releaseNote.filter((x) => x >= 0 && this.results[x]?.judge !== 'skip');
    return {
      total: n, perfect, good, miss, skipped: this.results.length - n,
      score: this.score, maxScore: maxScoreFor(n), maxCombo: this.maxCombo,
      holds: rel.length, holdOk: rel.filter((x) => this.results[x] && this.results[x]!.judge !== 'miss').length,
      accuracy, grade: gradeOf(accuracy), cleared: n > 0 && accuracy >= this.cfg.clearAccuracy, avgDeltaMs, deltas,
    };
  }

  private moveFirst() {
    while (this.firstPress < this.cues.length && this.results[this.pressNote[this.firstPress]]) this.firstPress++;
  }
}

/** 타이밍 히스토그램: −goodMs ~ +goodMs 를 bins 칸으로 */
export function histogram(deltas: number[], goodMs: number, bins = 17): number[] {
  const out = new Array(bins).fill(0);
  for (const d of deltas) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((d + goodMs) / (2 * goodMs)) * bins)));
    out[i]++;
  }
  return out;
}

/** 놓친 구간: MISS·GOOD 큐 시각을 groupSec 안끼리 묶어 MISS 많은 순으로 (results 는 큐별, cueResult) */
export function missSections(cues: readonly { t: number; text: string; section?: string }[], results: readonly (NoteResult | null)[], groupSec: number, max: number) {
  const groups: { from: number; to: number; miss: number; good: number; label: string }[] = [];
  cues.forEach((c, i) => {
    const r = results[i];
    if (!r || (r.judge !== 'miss' && r.judge !== 'good')) return;
    const g = groups.at(-1);
    if (g && c.t - g.to <= groupSec) {
      g.to = c.t;
      if (r.judge === 'miss') g.miss++; else g.good++;
    } else {
      groups.push({ from: c.t, to: c.t, miss: r.judge === 'miss' ? 1 : 0, good: r.judge === 'good' ? 1 : 0, label: '' });
    }
  });
  for (const g of groups) {
    const inside = cues.filter((c) => c.t >= g.from && c.t <= g.to);
    const sec = cues.filter((c) => c.t <= g.from && c.section).at(-1)?.section;
    g.label = sec ?? inside.slice(0, 6).map((c) => c.text).join(' ');
  }
  return groups.filter((g) => g.miss > 0).sort((a, b) => b.miss - a.miss || a.from - b.from).slice(0, max);
}
