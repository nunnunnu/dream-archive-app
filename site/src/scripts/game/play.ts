/**
 * 응원법 게임 플레이 (FANCHANT_GAME_SPEC.md §2·§3·§5·§6·§11)
 *  - 유튜브가 PLAYING일 때만 시계·판정이 흐른다 (광고·버퍼·일시정지 = 정지)
 *  - 시크로 건너뛰거나 되감은 판, 구간 연습, 시험 플레이는 최고 기록에 저장하지 않는다
 */
import { fmtTime, judgeWindow, songTimeAt, videoTimeAt, type FanchantChart, type FanchantConfig } from '../../lib/fanchant';
import { VideoClock } from './clock';
import { histogram, holdOf, Judger, missSections, type Judge, type TapResult } from './judge';
import { getBest, getInputOffset, lateNotes, MODE_LABEL, saveBest, setInputOffset, usesMv, type GameMode } from './storage';
import { createPlayer, YTState, ytErrorText, type YTPlayer } from './youtube';

interface Data { chart: FanchantChart; config: FanchantConfig; mode: GameMode; from: number | null; to: number | null; backHref: string; preview: boolean }
const raw = document.getElementById('game-data');
if (raw) run(JSON.parse(raw.textContent || '{}') as Data);

function run({ chart, config, mode, from, to, backHref, preview }: Data) {
  // 실전은 판정 창이 넓다 (config livePerfectMs·liveGoodMs). 아래 cfg.perfectMs·goodMs 는 이 모드 기준
  const cfg = { ...config, ...judgeWindow(config, mode) };
  const $ = (id: string) => document.getElementById(id);
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const nf = (n: number) => n.toLocaleString('ko-KR');
  const video = chart.videos.find((v) => v.mode === (usesMv(mode) ? 'mv' : 'guide'));
  const late = lateNotes(mode);
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
  const LEAD_SEC = 5;

  // ── 보정 ──
  const showCalib = () => { $('g-calib')!.textContent = `${inputOffset > 0 ? '+' : ''}${inputOffset}ms`; };
  showCalib();
  document.querySelectorAll<HTMLButtonElement>('[data-calib]').forEach((b) => b.addEventListener('click', () => {
    inputOffset = b.dataset.calib === 'reset' ? 0 : inputOffset + Number(b.dataset.calib);
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
  }, { controls: 0 }).catch((err: Error) => notice(err.message, true));

  /** 시작 위치로: 구간 연습은 from, 처음 시작이면 영상 인트로를 건너뛰고 첫 큐 몇 초 전부터.
   *  유튜브 화면을 눌러 재생해도 처음 PLAYING 때 이걸 부른다 */
  function seekToStart() {
    if (!player || started) return;
    const at = player.getCurrentTime();
    if (practice) { if (at < from! - 0.5) player.seekTo(from!, true); return; }
    if (!cues.length) return;
    const lead = Math.max(0, videoTimeAt(video!, cues[0].t) - LEAD_SEC);
    if (lead > 1 && at < lead - 0.5) player.seekTo(lead, true);
  }
  startBtn.addEventListener('click', () => {
    if (!player) return;
    if (finished) { location.reload(); return; }
    seekToStart();
    player.playVideo();
    focusTap();
  });

  function onState(s: number) {
    clock?.sample(s);
    if (finished) return;
    if (s === YTState.PLAYING) {
      if (!started) seekToStart();
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
  }
  /** 손 뗌: 길게 큐를 일찍 떼면 GOOD으로 */
  function release(eventTime: number) {
    if (!clock || !judger.holding || finished) return;
    const vt = clock.now(Math.min(eventTime, performance.now()));
    const r = judger.release(songTimeAt(video!, vt) - inputOffset / 1000);
    if (r) showJudge(r.judge, r, r.judge === 'miss' ? (r.deltaMs < 0 ? '너무 일찍 뗐어요' : '너무 늦게 뗐어요') : undefined);
  }
  tapBtn.addEventListener('pointerup', (e) => release(e.timeStamp));
  tapBtn.addEventListener('pointercancel', (e) => release(e.timeStamp));
  window.addEventListener('blur', () => release(performance.now()));
  tapBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); kick(); if (!started && player) { startBtn.click(); return; } tap(e.timeStamp); });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'A' || (t.tagName === 'BUTTON' && t !== tapBtn))) return;
    e.preventDefault();
    if (e.repeat) return;
    kick();
    if (!started && player) { startBtn.click(); return; }
    tap(e.timeStamp);
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    if (e.target === tapBtn) e.preventDefault();
    release(e.timeStamp);
  });

  // ── 판정 표시 ──
  const judgeEl = $('g-judge');
  const WORD: Record<Judge, string> = { perfect: 'PERFECT', good: 'GOOD', miss: 'MISS' };
  function showJudge(j: Judge, r?: TapResult, note?: string) {
    if (judgeEl) {
      judgeEl.className = `${judgeEl.id === 'g-judge' && mode === 'live' ? 'game-live-judge' : 'game-judge'} is-${j}`;
      const tail = note ?? (r?.hold ? '꾹 누르고 있기' : r?.kind === 'release' ? '뗌' : '');
      judgeEl.innerHTML = `${WORD[j]}${r && r.judge !== 'miss' ? `<small>+${nf(r.points)} ${r.deltaMs > 0 ? `+${r.deltaMs}` : r.deltaMs}ms${tail ? ` · ${esc(tail)}` : ''}</small>` : tail ? `<small>${esc(tail)}</small>` : ''}`;
      void judgeEl.offsetWidth;
      judgeEl.classList.add('is-show');
    }
    if (mode === 'live') $('g-live-hint')?.setAttribute('hidden', '');
    const sj = $('g-stick-pop');
    if (sj) { sj.className = `game-stick-pop is-${j}`; sj.textContent = WORD[j]; void sj.offsetWidth; sj.classList.add('is-show'); }
    if (late && r && r.kind === 'press') pushRecent(r.index, true);
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
    const ahead = late ? cfg.step2LookaheadMs / 1000 : approach;
    const behind = late ? cfg.step2LingerMs / 1000 : 0.25;
    const keep = new Set<number>();
    const pxPerSec = (laneW * (1 - HIT_X)) / approach;
    const held = judger.holding?.index ?? -1;
    for (let i = Math.max(0, Math.min(judger.nextIndex, held < 0 ? Infinity : held) - 6); i < cues.length; i++) {
      const d = cues[i].t - st;
      if (d > ahead) break;
      const hold = holdOf(cues[i]);
      const res = judger.pressResult(i);
      const holding = i === held;
      // 맞힌·놓친 노트는 판정선을 지나 흐리게 흘러가다 사라진다 (2·3단계는 짧게)
      const gone = d + hold < -(late ? behind : 0.6);
      if (!holding && (gone || res?.judge === 'skip' || (late && res && res.judge !== 'miss' && d < -behind))) continue;
      keep.add(i);
      let el = noteEls.get(i);
      if (!el) {
        el = document.createElement('div');
        el.className = `game-note${late ? ' is-plain is-ghost' : ''}${hold ? ' is-hold' : ''}`;
        el.innerHTML = `${hold ? '<span class="game-hold-body"></span>' : ''}${mode === 'step1' ? `<span class="game-note-lab">${esc(cues[i].text)}</span>` : ''}`;
        notesEl.append(el);
        noteEls.set(i, el);
      }
      if (res?.judge === 'miss') el.classList.add('is-miss');
      else if (res && !holding) el.classList.add('is-done');
      el.classList.toggle('is-holding', holding);
      // 1단계는 approach 동안 오른쪽 끝에서 판정선까지, 2단계도 같은 속도로 보이는 구간만. 누르고 있는 길게 노트는 판정선에 붙어서 꼬리가 줄어든다
      const x = HIT_X * laneW + (holding ? 0 : d * pxPerSec);
      el.style.transform = `translateX(${x.toFixed(1)}px)`;
      if (hold) (el.firstElementChild as HTMLElement).style.width = `${Math.max(0, (holding ? cues[i].t + hold - st : hold) * pxPerSec).toFixed(1)}px`;
    }
    for (const [i, el] of noteEls) if (!keep.has(i)) { el.remove(); noteEls.delete(i); }
  }
  // ── 응원 문구 한 줄: 지난 것(흐리게) · 지금(크게) · 다음(옆으로). 쉬는 구간은 넓게 띄움 ──
  const chantEl = $('g-chant');
  const BREAK_SEC = 1.5;
  const word = (i: number, cls: string) => `<span class="game-cw ${cls}${holdOf(cues[i]) ? ' has-hold' : ''}">${esc(cues[i].text)}${holdOf(cues[i]) ? '<em>홀드</em>' : ''}</span>`;
  const row = (idx: number[], cls: (i: number) => string) => {
    let broke = false;
    return idx.map((i, k) => {
      const brk = k > 0 && cues[i].t - cues[idx[k - 1]].t > BREAK_SEC;
      const c = cls(i);
      if (brk && c.includes('is-next')) broke = true;
      return `${brk ? '<span class="game-cbreak"></span>' : k ? '<span class="game-cdot">·</span>' : ''}${word(i, broke && c.includes('is-next') ? `${c} is-later` : c)}`;
    }).join('');
  };
  let chantKey = -1;
  function drawChant() {
    if (mode !== 'step1' || !chantEl) return;
    const n = judger.nextIndex;
    if (n === chantKey) return;
    chantKey = n;
    const idx: number[] = [];
    for (let i = Math.max(0, n - 2); i < Math.min(cues.length, n + 6); i++) if (judger.pressResult(i)?.judge !== 'skip') idx.push(i);
    chantEl.innerHTML = row(idx, (i) => (i < n ? 'is-past' : i === n ? 'is-now' : 'is-next'));
  }
  // 2·3단계: 누른(놓친) 뒤에만 정답을 옆으로 쌓아 보여 준다
  const recent: { i: number; ok: boolean }[] = [];
  function pushRecent(i: number, ok: boolean) {
    if (!chantEl) return;
    recent.push({ i, ok });
    recent.sort((x, y) => x.i - y.i);
    while (recent.length > 5) recent.shift();
    const last = recent.at(-1)!.i;
    chantEl.innerHTML = row(recent.map((x) => x.i), (i) => {
      const ok = recent.find((x) => x.i === i)!.ok;
      return `${i === last ? 'is-now' : 'is-past'} ${ok ? 'is-ok' : 'is-miss'}`;
    });
  }

  // ── 응원봉: 누르면 −15° → +12° → 0 (250ms, 지금 각도에서 이어서), 길게 누르는 동안 빛나며 천천히 흔들림 ──
  const stickSvg = tapBtn.querySelector<SVGElement>('.game-stick-svg');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ang = 0;
  let swing: { start: number; from: number } | null = null;
  let swayStart = 0;
  let litTimer = 0;
  function kick() {
    swing = { start: performance.now(), from: ang };
    tapBtn.classList.add('is-lit');
    clearTimeout(litTimer);
    litTimer = window.setTimeout(() => tapBtn.classList.remove('is-lit'), cfg.pressGlowMs ?? 280);
    if (!stickRaf) stickRaf = requestAnimationFrame(stickFrame);
  }
  // 0° → −15° → +12° → −4° → 0° (스펙 §11.1)
  const KEYS: [number, number][] = [[0.3, -15], [0.6, 12], [0.82, -4], [1, 0]];
  const WOBBLE_MS = cfg.pressWobbleMs ?? 250;
  const SWAY_MS = cfg.holdSwayMs ?? 1150;
  let lastStick = performance.now();
  let stickRaf = 0;
  function stickFrame(now: number) {
    stickRaf = 0;
    const dt = Math.min(0.05, (now - lastStick) / 1000);
    lastStick = now;
    const holding = Boolean(judger.holding) && !finished;
    tapBtn.classList.toggle('is-holding', holding);
    if (swing) {
      const p = (now - swing.start) / WOBBLE_MS;
      if (p >= 1) { swing = null; ang = 0; swayStart = now; }
      else {
        let t0 = 0, a0 = swing.from;
        for (const [t1, a1] of KEYS) {
          if (p <= t1) { const x = (p - t0) / (t1 - t0); ang = a0 + (a1 - a0) * (0.5 - 0.5 * Math.cos(Math.PI * x)); break; }
          t0 = t1; a0 = a1;
        }
      }
    } else if (holding) {
      ang = Math.sin(((now - swayStart) / SWAY_MS) * 2 * Math.PI) * 6;
    } else {
      ang += (0 - ang) * Math.min(1, dt * 12);
      if (Math.abs(ang) < 0.05) ang = 0;
    }
    if (stickSvg && !reduceMotion) stickSvg.style.transform = `rotate(${ang.toFixed(2)}deg)`;
    if (swing || holding || ang !== 0) stickRaf = requestAnimationFrame(stickFrame);
  }
  // 길게 누르기가 시작되면 흔들기 루프를 계속 돌린다
  const keepStick = () => { if (judger.holding && !stickRaf) stickRaf = requestAnimationFrame(stickFrame); };

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
        const was = tainted;
        if (st > lastSt + 0.5 && Number.isFinite(lastSt)) {
          if (judger.skip((t) => t < st - win)) tainted = true;
        } else if (st < lastSt - 0.5 && cues.some((c, i) => c.t > st && judger.pressResult(i) && judger.pressResult(i)!.judge !== 'skip')) {
          tainted = true;
        }
        if (tainted && !was && !practice) notice('영상 위치가 바뀌어서 이번 판은 기록에 남지 않아요. 처음부터 하려면 다시 하기', true);
      }
      if (clock.playing && performance.now() - clock.jumpedAt > 300) {
        const missed = judger.advance(st - inputOffset / 1000);
        if (missed.length) {
          showJudge('miss');
          if (late) for (const i of missed) pushRecent(i, false);
        }
        lastSt = st;
      }
      drawNotes(st);
      drawChant();
      keepStick();
      const total = duration || player?.getDuration() || 0;
      $('g-time')!.textContent = fmtTime(vt, 0);
      $('g-dur')!.textContent = fmtTime(total, 0);
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
    const sections = missSections(cues, cues.map((_, i) => judger.cueResult(i)), cfg.missGroupSec, cfg.maxMissSections);
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
          <p class="game-result-sub">정확도 ${(s.accuracy * 100).toFixed(1)}% · 최대 콤보 ${s.maxCombo}${s.holds ? ` · 홀드 뗌 ${s.holdOk}/${s.holds}` : ''}${record ? (prev ? ` · 이전 최고 ${nf(prev.score)}에서 ${diff >= 0 ? '+' : ''}${nf(diff)}` : ' · 첫 기록') : ''}</p>
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
        ${mode === 'step2' && hasMv ? `<a class="game-btn" href="${q('step3')}">3단계로 (뮤비)</a>` : ''}
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
