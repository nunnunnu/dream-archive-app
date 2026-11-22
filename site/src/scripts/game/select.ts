// 응원법 게임 곡 선택: 모드 토글(기억), 모드별 최고 기록, 입력 보정
import { getBest, getInputOffset, getMode, setInputOffset, setMode, type GameMode } from './storage';

const HINT: Record<GameMode, string> = {
  step1: '1단계 · 노트와 응원 문구가 모두 보여요 · 판정 ±150ms',
  step2: '2단계 · 노트는 판정선 바로 앞에서만, 문구는 누른 뒤에 보여요',
  step3: '3단계 · 공식 뮤비로 바꾸고, 노트는 직전에만 보여요 (실전 연습)',
  live: '실전 · 공식 뮤비만 보고 외운 대로 눌러요 · 힌트 없음 · 판정 ±200ms (조금 넉넉하게)',
};
const nf = (n: number) => n.toLocaleString('ko-KR');
function apply(mode: GameMode) {
  document.querySelectorAll<HTMLButtonElement>('.game-mode').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  const hint = document.getElementById('mode-hint');
  if (hint) hint.textContent = HINT[mode];
  document.querySelectorAll<HTMLElement>('.game-card').forEach((card) => {
    const id = card.dataset.song!;
    const best = getBest(id, mode);
    card.querySelector('.game-best-slot')!.innerHTML = best ? `<span class="game-best">최고 ${nf(best.score)} · ${best.grade}</span>` : '<span class="game-best-empty">최고 기록 없음</span>';
    card.querySelectorAll<HTMLAnchorElement>('[data-play]').forEach((a) => a.classList.toggle('is-accent', a.dataset.play === mode));
  });
}
document.querySelectorAll<HTMLButtonElement>('.game-mode').forEach((b) => b.addEventListener('click', () => { const m = b.dataset.mode as GameMode; setMode(m); apply(m); }));
apply(getMode());
const show = () => { const v = getInputOffset(); document.getElementById('g-calib')!.textContent = `${v > 0 ? '+' : ''}${v}ms`; };
document.querySelectorAll<HTMLButtonElement>('[data-calib]').forEach((b) => b.addEventListener('click', () => { setInputOffset(b.dataset.calib === 'reset' ? 0 : getInputOffset() + Number(b.dataset.calib)); show(); }));
show();
