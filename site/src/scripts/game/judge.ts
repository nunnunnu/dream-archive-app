/**
 * 판정·콤보·점수·등급 (FANCHANT_GAME_SPEC.md §5·§6, 순수 함수)
 *  - delta = 탭 노래 시각 − 큐 시각 (ms, 입력 보정 뺀 값). 음수 = 빠름(EARLY), 양수 = 늦음(LATE)
 *  - 창 밖 탭은 무시(허공 탭으로 콤보가 깨지지 않게), 큐가 +goodMs 지나도록 입력이 없으면 자동 MISS
 *  - 건너뛴(시크·구간 밖) 큐는 점수 분모에서 뺀다
 *  - 길게(hold) 큐: 누를 때 판정은 같고, 끝 − goodMs 전에 떼면 PERFECT → GOOD. 끝까지 누르고 있으면 성공(정확히 뗄 필요 없음)
 */
export type Judge = 'perfect' | 'good' | 'miss';
export type Grade = 'SS' | 'S' | 'A' | 'B' | 'C' | 'D';
export interface JudgeConfig { perfectMs: number; goodMs: number; clearAccuracy: number }
/** early: 길게 누르는 큐를 일찍 뗌 (PERFECT → GOOD) */
export interface CueResult { judge: Judge | 'skip'; deltaMs?: number; points?: number; early?: boolean }
export interface TapResult { index: number; judge: Judge; deltaMs: number; points: number; combo: number; hold: number }

export function judgeOf(deltaMs: number, cfg: Pick<JudgeConfig, 'perfectMs' | 'goodMs'>): Judge | null {
  const a = Math.abs(deltaMs);
  if (a <= cfg.perfectMs) return 'perfect';
  if (a <= cfg.goodMs) return 'good';
  return null;
}

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
  readonly results: (CueResult | null)[];
  combo = 0;
  maxCombo = 0;
  score = 0;
  private first = 0; // 이 앞은 모두 처리됨

  /** 지금 누르고 있는 길게 큐 */
  holding: { index: number; endT: number } | null = null;
  holdOk = 0;
  holdEarly = 0;

  constructor(private cues: readonly { t: number; hold?: number }[], private cfg: JudgeConfig) {
    this.results = cues.map(() => null);
  }

  /** 구간 밖·건너뛴 큐 (점수 분모에서 뺌) */
  skip(pred: (t: number, i: number) => boolean): number {
    let n = 0;
    this.cues.forEach((c, i) => { if (!this.results[i] && pred(c.t, i)) { this.results[i] = { judge: 'skip' }; n++; } });
    this.moveFirst();
    return n;
  }

  /** 탭: 창 안의 가장 가까운 미처리 큐 하나에만 붙인다. 없으면 null(무시) */
  tap(songT: number): TapResult | null {
    const win = this.cfg.goodMs / 1000;
    let best = -1;
    let bestAbs = Infinity;
    for (let i = this.first; i < this.cues.length; i++) {
      const d = songT - this.cues[i].t;
      if (d < -win) break;
      if (this.results[i] || d > win) continue;
      if (Math.abs(d) < bestAbs) { bestAbs = Math.abs(d); best = i; }
    }
    if (best < 0) return null;
    const deltaMs = Math.round((songT - this.cues[best].t) * 1000);
    const judge = judgeOf(deltaMs, this.cfg) ?? 'good';
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const points = judge === 'perfect' ? 1000 + this.combo * 10 : 500 + this.combo * 5;
    this.score += points;
    this.results[best] = { judge, deltaMs, points };
    const hold = this.cues[best].hold ?? 0;
    this.holding = hold > 0 ? { index: best, endT: this.cues[best].t + hold } : null;
    this.moveFirst();
    return { index: best, judge, deltaMs, points, combo: this.combo, hold };
  }

  /** 손을 뗐을 때: 길게 큐를 일찍 뗐으면 PERFECT → GOOD. 일찍 뗀 큐 번호 */
  release(songT: number): number | null {
    const h = this.holding;
    if (!h) return null;
    this.holding = null;
    if (songT >= h.endT - this.cfg.goodMs / 1000) { this.holdOk++; return null; }
    this.holdEarly++;
    const r = this.results[h.index]!;
    r.early = true;
    if (r.judge === 'perfect') {
      const combo = Math.round(((r.points ?? 1000) - 1000) / 10);
      const lower = 500 + combo * 5;
      this.score -= (r.points ?? 0) - lower;
      r.points = lower;
      r.judge = 'good';
    }
    return h.index;
  }

  /** 시계 진행: +goodMs 지난 미처리 큐는 MISS. 새로 MISS 된 번호들. 길게 큐는 끝이 지나면 성공 */
  advance(songT: number): number[] {
    if (this.holding && songT >= this.holding.endT) { this.holding = null; this.holdOk++; }
    const win = this.cfg.goodMs / 1000;
    const missed: number[] = [];
    for (let i = this.first; i < this.cues.length && songT - this.cues[i].t > win; i++) {
      if (this.results[i]) continue;
      this.results[i] = { judge: 'miss' };
      this.combo = 0;
      missed.push(i);
    }
    this.moveFirst();
    return missed;
  }

  /** 영상이 끝났을 때: 남은 큐 모두 MISS */
  finish(): number[] { this.holding = null; return this.advance(Infinity); }

  get done() { return this.first >= this.cues.length; }
  get nextIndex() { return this.first; }

  summary() {
    const counted = this.results.filter((r) => r && r.judge !== 'skip') as CueResult[];
    const n = this.results.filter((r) => r?.judge !== 'skip').length;
    const perfect = counted.filter((r) => r.judge === 'perfect').length;
    const good = counted.filter((r) => r.judge === 'good').length;
    const miss = n - perfect - good;
    const accuracy = n ? (perfect + good * 0.5) / n : 0;
    const deltas = counted.filter((r) => r.deltaMs !== undefined).map((r) => r.deltaMs!);
    const avgDeltaMs = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
    return {
      total: n, perfect, good, miss, skipped: this.results.length - n,
      score: this.score, maxScore: maxScoreFor(n), maxCombo: this.maxCombo,
      holds: this.cues.filter((c, i) => (c.hold ?? 0) > 0 && this.results[i]?.judge !== 'skip').length, holdOk: this.holdOk, holdEarly: this.holdEarly,
      accuracy, grade: gradeOf(accuracy), cleared: n > 0 && accuracy >= this.cfg.clearAccuracy, avgDeltaMs, deltas,
    };
  }

  private moveFirst() {
    while (this.first < this.cues.length && this.results[this.first]) this.first++;
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

/** 놓친 구간: MISS 큐 시각을 groupSec 안끼리 묶어 많은 순으로 */
export function missSections(cues: readonly { t: number; text: string; section?: string }[], results: readonly (CueResult | null)[], groupSec: number, max: number) {
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
