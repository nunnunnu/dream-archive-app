/**
 * 응원법 게임 플레이 (FANCHANT_GAME_SPEC.md §2·§3·§5·§6·§11)
 *  - 유튜브가 PLAYING일 때만 시계·판정이 흐른다 (광고·버퍼·일시정지 = 정지)
 *  - 시크로 건너뛰거나 되감은 판, 구간 연습, 시험 플레이는 최고 기록에 저장하지 않는다
 */
import { fmtTime, songTimeAt, videoTimeAt, type FanchantChart, type FanchantConfig } from '../../lib/fanchant';
import { VideoClock } from './clock';
import { histogram, Judger, missSections, type Judge, type TapResult } from './judge';
import { getBest, getInputOffset, MODE_LABEL, saveBest, setInputOffset, type GameMode } from './storage';
import { createPlayer, YTState, ytErrorText, type YTPlayer } from './youtube';

interface Data { chart: FanchantChart; config: FanchantConfig; mode: GameMode; from: number | null; to: number | null; backHref: string; preview: boolean }
const raw = document.getElementById('game-data');
if (raw) run(JSON.parse(raw.textContent || '{}') as Data);

function run({ chart, config: cfg, mode, from, to, backHref, preview }: Data) {
  const $ = (id: string) => document.getElementById(id);
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const nf = (n: number) => n.toLocaleString('ko-KR');
  const video = chart.videos.find((v) => v.mode === (mode === 'live' ? 'mv' : 'guide'));
  if (!video) return;
  const cues = chart.cues;
  const judger = new Judger(cues, cfg);
  const practice = from != null && to != null;
  if (practice) judger.skip((t) => { const vt = videoTimeAt(video, t); return vt < from! || vt > to!; });
  let tainted = false; // 건너뛴 구간이 있으면 기록 안 남김
  let inputOffset = getInputOffset();
  let player: YTPlayer | null = null;
  let clock: VideoClock | null = null;
  let started = false;
  let finished = false;
  let lastJump = 0;
  let lastSt = practice ? songTimeAt(video, from!) : -Infinity;
  let duration = 0;
  const lastCueT = cues.length ? cues.at(-1)!.t : 0;

  // ── 보정 ──
  const showCalib = () => { $('g-calib')!.textContent = `${inputOffset > 0 ? '+' : ''}${inputOffset}ms`; };
  showCalib();
  document.querySelectorAll<HTMLButtonElement>('[data-calib]').forEach((b) => b.addEventListener('click', () => {
    inputOffset += Number(b.dataset.calib);
    setInputOffset(inputOffset);
    inputOffset = getInputOffset();
    showCalib();
    focusTap();
  }));

  // ── 플레이어 ──
  const notice = (text: string, warn = false) => { $('g-notice-text')!.textContent = text; $('g-notice')!.classList.toggle('is-warn', warn); };
  const startBtn = $('g-start') as HTMLButtonElement;
  createPlayer($('game-yt-player')!, video.youtubeId, {
    ready: (p) => {
      player = p;
      clock = new VideoClock(p, cfg.clockSampleMs);
      clock.start();
      if (practice) p.cueVideoById(video.youtubeId, from!);
      startBtn.disabled = false;
      startBtn.textContent = practice ? '구간 연습 시작' : '시작';
      loop();
    },
    state: (s) => onState(s),
    error: (code) => {
      notice(`${ytErrorText(code)}. 이 모드는 지금 할 수 없어요.`, true);
      startBtn.hidden = true;
      try { sessionStorage.setItem(`fanchant.blocked.${chart.songId}.${mode}`, String(code)); } catch { /* 없음 */ }
    },
  }).catch((err: Error) => notice(err.message, true));

  startBtn.addEventListener('click', () => {
    if (!player) return;
    if (finished) { location.reload(); return; }
    if (practice && player.getCurrentTime() < from! - 0.5) player.seekTo(from!, true);
    player.playVideo();
    focusTap();
  });

  function onState(s: number) {
    clock?.sample(s);
    if (finished) return;
    if (s === YTState.PLAYING) {
      started = true;
      startBtn.hidden = true;
      notice(mode === 'live' ? '실전 · 외운 대로 눌러보세요' : '재생 중 · 스페이스 또는 TAP');
      duration = player?.getDuration() || duration;
      focusTap();
    } else if (s === YTState.ENDED) {
      end();
    } else if (started && (s === YTState.PAUSED || s === YTState.BUFFERING)) {
      notice(s === YTState.BUFFERING ? '불러오는 중이에요. 재생되면 이어서 시작해요' : '일시정지 · 광고나 일시정지가 끝나면 이어서 시작해요');
      startBtn.hidden = false;
      startBtn.textContent = '이어서';
    }
  }

  // ── 포커스: 영상(iframe)을 누르면 스페이스가 영상으로 간다 ──
  const tapBtn = $('g-tap') as HTMLButtonElement;
  const focusTap = () => tapBtn.focus({ preventScroll: true });
  window.addEventListener('blur', () => setTimeout(() => { if (!finished && document.activeElement instanceof HTMLIFrameElement) $('g-focus')!.hidden = false; }, 0));
  window.addEventListener('focus', () => { $('g-focus')!.hidden = true; });

  // ── 입력 ──
  function tap(eventTime: number) {
    $('g-focus')!.hidden = true;
    if (!clock || !clock.playing || finished) return;
    const now = performance.now();
    if (now - clock.jumpedAt < 300) return; // 점프 직후는 쉼
    const vt = clock.now(Math.min(eventTime, now));
    const st = songTimeAt(video!, vt) - inputOffset / 1000;
    const r = judger.tap(st);
    if (r) showJudge(r.judge, r);
    tapBtn.classList.remove('is-hit');
    void tapBtn.offsetWidth;
    tapBtn.classList.add('is-hit');
  }
  tapBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); if (!started && player) { startBtn.click(); return; } tap(e.timeStamp); });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'A' || (t.tagName === 'BUTTON' && t !== tapBtn))) return;
    e.preventDefault();
    if (e.repeat) return;
    if (!started && player) { startBtn.click(); return; }
    tap(e.timeStamp);
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && e.target === tapBtn) e.preventDefault(); });

  // ── 판정 표시 ──
  const judgeEl = $('g-judge');
  const WORD: Record<Judge, string> = { perfect: 'PERFECT', good: 'GOOD', miss: 'MISS' };
  function showJudge(j: Judge, r?: TapResult) {
    if (judgeEl) {
      judgeEl.className = `${judgeEl.id === 'g-judge' && mode === 'live' ? 'game-live-judge' : 'game-judge'} is-${j}`;
      judgeEl.innerHTML = `${WORD[j]}${r ? `<small>${r.points ? `+${nf(r.points)}` : ''} ${r.deltaMs > 0 ? `+${r.deltaMs}` : r.deltaMs}ms</small>` : ''}`;
      void judgeEl.offsetWidth;
      judgeEl.classList.add('is-show');
    }
    if (mode === 'live') $('g-live-hint')?.setAttribute('hidden', '');
    if (mode === 'step2') {
      const idx = r ? r.index : -1;
      if (idx >= 0) {
        $('g-chant-now')!.innerHTML = `<span class="game-chant-ok">${esc(cues[idx].text)}</span> <span class="game-ok">✓</span>`;
      }
    }
    $('g-combo')!.textContent = String(judger.combo);
    $('g-score')!.textContent = nf(judger.score);
  }

  // ── 레인 (1·2단계) ──
  const notesEl = $('g-notes');
  const laneEl = $('g-lane');
  const noteEls = new Map<number, HTMLElement>();
  let laneW = 0;
  const measure = () => { laneW = laneEl?.clientWidth ?? 0; };
  measure();
  window.addEventListener('resize', measure);
  const HIT_X = 0.14;
  function drawNotes(st: number) {
    if (!notesEl || !laneW) return;
    const approach = cfg.approachMs / 1000;
    const ahead = mode === 'step2' ? cfg.step2LookaheadMs / 1000 : approach;
    const behind = mode === 'step2' ? cfg.step2LingerMs / 1000 : 0.25;
    const keep = new Set<number>();
    for (let i = judger.nextIndex > 3 ? judger.nextIndex - 3 : 0; i < cues.length; i++) {
      const d = cues[i].t - st;
      if (d > ahead) break;
      const res = judger.results[i];
      if (d < -behind || res?.judge === 'skip' || (res && res.judge !== 'miss')) continue;
      keep.add(i);
      let el = noteEls.get(i);
      if (!el) {
        el = document.createElement('div');
        el.className = `game-note${mode === 'step2' ? ' is-plain is-ghost' : ''}`;
        if (mode === 'step1') el.innerHTML = `<span class="game-note-lab">${esc(cues[i].text)}</span>`;
        notesEl.append(el);
        noteEls.set(i, el);
      }
      if (res?.judge === 'miss') el.classList.add('is-miss');
      // 1단계는 approach 동안 오른쪽 끝에서 판정선까지, 2단계도 같은 속도로 보이는 구간만
      const x = HIT_X * laneW + (d / approach) * (laneW * (1 - HIT_X));
      el.style.transform = `translateX(${x.toFixed(1)}px)`;
    }
    for (const [i, el] of noteEls) if (!keep.has(i)) { el.remove(); noteEls.delete(i); }
  }
  function drawChant() {
    if (mode !== 'step1') return;
    const n = judger.nextIndex;
    const now = cues[n]?.text ?? '';
    const next = cues.slice(n + 1, n + 5).map((c) => c.text).join(' ');
    const nowEl = $('g-chant-now')!;
    if (nowEl.textContent !== now) nowEl.textContent = now;
    const nx = next ? `다음 · ${next}` : '';
    const nextEl = $('g-chant-next')!;
    if (nextEl.textContent !== nx) nextEl.textContent = nx;
  }

  // ── 매 프레임 ──
  function loop() {
    const frame = () => {
      if (finished || !clock) return;
      requestAnimationFrame(frame);
      const vt = clock.now();
      const st = songTimeAt(video!, vt);
      if (clock.jumpedAt !== lastJump) {
        lastJump = clock.jumpedAt;
        const win = cfg.goodMs / 1000;
        if (st > lastSt + 0.5 && Number.isFinite(lastSt)) {
          if (judger.skip((t) => t < st - win)) tainted = true;
        } else if (st < lastSt - 0.5 && judger.results.some((r, i) => r && r.judge !== 'skip' && cues[i].t > st)) {
          tainted = true;
        }
      }
      if (clock.playing && performance.now() - clock.jumpedAt > 300) {
        const missed = judger.advance(st - inputOffset / 1000);
        if (missed.length) {
          showJudge('miss');
          if (mode === 'step2') $('g-chant-now')!.innerHTML = `<span class="game-chant-miss">${esc(cues[missed.at(-1)!].text)}</span> <span class="game-miss-mark">MISS</span>`;
        }
        lastSt = st;
      }
      drawNotes(st);
      drawChant();
      const total = duration || player?.getDuration() || 0;
      $('g-time')!.textContent = `${fmtTime(vt, 0)} / ${fmtTime(total, 0)}`;
      if (total) $('g-progress')!.style.width = `${Math.min(100, (vt / total) * 100)}%`;
      if (practice && vt >= to!) { player?.pauseVideo(); end(); return; }
      if (clock.playing && judger.done && st > lastCueT + 2.5) { end(); return; }
    };
    requestAnimationFrame(frame);
  }

  // ── 결과 ──
  function end() {
    if (finished) return;
    finished = true;
    judger.finish();
    if (!practice) player?.pauseVideo();
    const s = judger.summary();
    const record = !tainted && !practice && !preview && s.total > 0;
    const prev = getBest(chart.songId, mode);
    if (record) saveBest(chart.songId, mode, { score: s.score, grade: s.grade, accuracy: s.accuracy, maxCombo: s.maxCombo, perfect: s.perfect, good: s.good, miss: s.miss, at: new Date().toISOString() });
    const hist = histogram(s.deltas, cfg.goodMs);
    const peak = Math.max(1, ...hist);
    const tendency = Math.abs(s.avgDeltaMs) < 15 ? '거의 딱 맞아요' : s.avgDeltaMs > 0 ? (s.avgDeltaMs > 40 ? '늦은 편' : '약간 늦은 편') : (s.avgDeltaMs < -40 ? '빠른 편' : '약간 빠른 편');
    const guide = chart.videos.find((v) => v.mode === 'guide')!;
    const sections = missSections(cues, judger.results, cfg.missGroupSec, cfg.maxMissSections);
    const q = (m: GameMode, extra = '') => `${location.pathname}?song=${encodeURIComponent(chart.songId)}&mode=${m}${extra}`;
    const practiceHref = (g: { from: number; to: number }) => q('step1', `&from=${Math.max(0, videoTimeAt(guide, g.from) - cfg.practiceLeadInSec).toFixed(1)}&to=${(videoTimeAt(guide, g.to) + cfg.practiceTrailSec).toFixed(1)}`);
    const diff = prev ? s.score - prev.score : 0;
    const hasMv = chart.videos.some((v) => v.mode === 'mv');
    const box = $('game-result')!;
    box.innerHTML = `
      <div class="game-result-hero">
        <div class="game-rank">${s.grade}</div>
        <div>
          <p class="game-result-mode">${MODE_LABEL[mode]}${practice ? ' · 구간 연습' : ''} · ${esc(chart.title)}</p>
          <h2>${practice ? '구간 연습 끝' : s.cleared ? `${MODE_LABEL[mode]} 클리어` : '클리어 실패'}</h2>
          <p class="game-score"><b>${nf(s.score)}</b> / ${nf(s.maxScore)}</p>
          <p class="game-result-sub">정확도 ${(s.accuracy * 100).toFixed(1)}% · 최대 콤보 ${s.maxCombo}${record ? (prev ? ` · 이전 최고 ${nf(prev.score)}에서 ${diff >= 0 ? '+' : ''}${nf(diff)}` : ' · 첫 기록') : ''}</p>
          ${!record ? `<p class="game-result-sub">${preview ? '시험 플레이라 기록은 남기지 않아요' : practice ? '구간 연습은 기록에 남기지 않아요' : tainted ? '건너뛴 구간이 있어서 기록에 남기지 않았어요' : ''}</p>` : ''}
        </div>
      </div>
      <div class="game-counts">
        <div class="game-count is-pf"><span>PERFECT</span><b>${s.perfect}</b></div>
        <div class="game-count is-gd"><span>GOOD</span><b>${s.good}</b></div>
        <div class="game-count is-ms"><span>MISS</span><b>${s.miss}</b></div>
      </div>
      <div class="game-result-grid">
        <div class="card game-panel">
          <h3>타이밍</h3>
          <div class="game-timing" aria-label="타이밍 편차 분포">
            ${hist.map((n, i) => `<span class="game-timing-bar${i === 8 ? ' is-zero' : ''}" style="height:${Math.round((n / peak) * 100)}%" title="${n}"></span>`).join('')}
          </div>
          <div class="game-timing-axis"><span>EARLY −${cfg.goodMs}ms</span><span>0</span><span>LATE +${cfg.goodMs}ms</span></div>
          <p class="game-result-sub">${s.deltas.length ? `평균 ${s.avgDeltaMs > 0 ? '+' : ''}${s.avgDeltaMs}ms · ${tendency}` : '맞힌 노트가 없어요'}</p>
          ${Math.abs(s.avgDeltaMs) >= 40 && s.deltas.length >= 8 ? `<p class="game-result-sub">늘 ${s.avgDeltaMs > 0 ? '늦게' : '빠르게'} 눌린다면 블루투스 이어폰 지연일 수 있어요. <button type="button" class="admin-btn game-mini" id="g-apply-calib">입력 보정 ${s.avgDeltaMs > 0 ? '+' : ''}${s.avgDeltaMs}ms 적용</button></p>` : ''}
        </div>
        <div class="card game-panel">
          <h3>가장 많이 놓친 구간</h3>
          ${sections.length ? sections.map((g) => `
            <div class="game-miss-item">
              <span class="game-miss-time">${fmtTime(videoTimeAt(guide, g.from), 0)}</span>
              <span class="game-miss-label">${esc(g.label)}<small>MISS ${g.miss}${g.good ? ` · GOOD ${g.good}` : ''}</small></span>
              <a class="game-btn game-mini" href="${practiceHref(g)}">이 구간 연습</a>
            </div>`).join('') : '<p class="game-result-sub">놓친 구간이 없어요 👏</p>'}
          ${sections.length ? `<a class="game-btn is-accent btn-wide" href="${practiceHref(sections[0])}">놓친 구간만 1단계로 다시 연습</a>` : ''}
        </div>
      </div>
      <div class="game-result-actions">
        <a class="game-btn is-dark" href="${q(mode)}">다시 하기</a>
        ${mode !== 'live' && hasMv ? `<a class="game-btn" href="${q('live')}">실전 도전</a>` : ''}
        ${mode === 'step1' ? `<a class="game-btn" href="${q('step2')}">2단계로</a>` : ''}
        <a class="game-btn" href="${esc(backHref)}">${preview ? '채보 도구로' : '곡 목록'}</a>
      </div>
      <p class="game-result-meta">채보 ${esc(chart.author)} · 노래 시작 오프셋 ${video!.offset}s · 판정 PERFECT ±${cfg.perfectMs}ms / GOOD ±${cfg.goodMs}ms${inputOffset ? ` · 입력 보정 ${inputOffset}ms` : ''}${s.skipped && !practice ? ` · 건너뛴 큐 ${s.skipped}개 제외` : ''}</p>`;
    box.hidden = false;
    $('game-stage')!.classList.add('is-done');
    $('g-apply-calib')?.addEventListener('click', (e) => {
      setInputOffset(inputOffset + s.avgDeltaMs);
      inputOffset = getInputOffset();
      showCalib();
      (e.target as HTMLButtonElement).replaceWith(document.createTextNode(`입력 보정을 ${inputOffset}ms로 바꿨어요. 다시 해 보세요.`));
    });
    box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
}
