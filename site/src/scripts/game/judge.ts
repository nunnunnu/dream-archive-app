/**
 * 판정·콤보·점수·등급 (FANCHANT_GAME_SPEC.md §5·§6, 순수 함수)
 *  - delta = 탭 노래 시각 − 큐 시각 (ms, 입력 보정 뺀 값). 음수 = 빠름(EARLY), 양수 = 늦음(LATE)
 *  - 창 밖 탭은 무시(허공 탭으로 콤보가 깨지지 않게), 큐가 +goodMs 지나도록 입력이 없으면 자동 MISS
 *  - 건너뛴(시크·구간 밖) 큐는 점수 분모에서 뺀다
 */
export type Judge = 'perfect' | 'good' | 'miss';
export type Grade = 'SS' | 'S' | 'A' | 'B' | 'C' | 'D';
export interface JudgeConfig { perfectMs: number; goodMs: number; clearAccuracy: number }
export interface CueResult { judge: Judge | 'skip'; deltaMs?: number }
export interface TapResult { index: number; judge: Judge; deltaMs: number; points: number; combo: number }

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

  constructor(private cues: readonly { t: number }[], private cfg: JudgeConfig) {
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
    this.results[best] = { judge, deltaMs };
    this.moveFirst();
    return { index: best, judge, deltaMs, points, combo: this.combo };
  }

  /** 시계 진행: +goodMs 지난 미처리 큐는 MISS. 새로 MISS 된 번호들 */
  advance(songT: number): number[] {
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
  finish(): number[] { return this.advance(Infinity); }

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
