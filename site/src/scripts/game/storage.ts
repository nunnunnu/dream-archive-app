/** 최고 기록·입력 보정 (localStorage, 로그인 없음). 저장이 막혀도 게임은 돈다 */
import type { Grade } from './judge';

export type GameMode = 'step1' | 'step2' | 'step3' | 'live';
export const GAME_MODES: GameMode[] = ['step1', 'step2', 'step3', 'live'];
/** 뮤비로 하는 모드 (3단계·실전) */
export const usesMv = (m: GameMode) => m === 'step3' || m === 'live';
/** 노트가 직전에만 보이는 모드 (2·3단계) */
export const lateNotes = (m: GameMode) => m === 'step2' || m === 'step3';
export interface BestRecord { score: number; grade: Grade; accuracy: number; maxCombo: number; perfect: number; good: number; miss: number; at: string }

const PREFIX = 'fanchant.';
const get = (k: string) => { try { return localStorage.getItem(PREFIX + k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(PREFIX + k, v); } catch { /* 저장 안 돼도 괜찮음 */ } };

export function getBest(songId: string, mode: GameMode): BestRecord | null {
  try { return JSON.parse(get(`best.${songId}.${mode}`) ?? 'null'); } catch { return null; }
}

/** 더 좋을 때만 덮어쓴다 (점수 → 정확도 → 최근). 바꿨으면 이전 기록을 돌려준다 */
export function saveBest(songId: string, mode: GameMode, rec: BestRecord): { saved: boolean; prev: BestRecord | null } {
  const prev = getBest(songId, mode);
  const better = !prev || rec.score > prev.score || (rec.score === prev.score && rec.accuracy >= prev.accuracy);
  if (better) set(`best.${songId}.${mode}`, JSON.stringify(rec));
  return { saved: better, prev };
}

export function getInputOffset(): number {
  try { return Number(JSON.parse(get('calibration') ?? '{}').inputOffsetMs) || 0; } catch { return 0; }
}
export function setInputOffset(ms: number) {
  set('calibration', JSON.stringify({ inputOffsetMs: Math.max(-400, Math.min(400, Math.round(ms))) }));
}

export function getMode(): GameMode {
  const m = get('mode');
  return m === 'step2' || m === 'step3' || m === 'live' ? m : 'step1';
}
export const setMode = (m: GameMode) => set('mode', m);

export const MODE_LABEL: Record<GameMode, string> = { step1: '연습 1단계', step2: '연습 2단계', step3: '연습 3단계', live: '실전' };
