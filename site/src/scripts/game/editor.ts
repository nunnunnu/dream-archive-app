/**
 * 어드민 응원법 채보 도구 (FANCHANT_GAME_SPEC.md §7)
 *  - 공식 가이드를 재생하며 녹음 ON + 스페이스/TAP으로 큐를 찍는다. 저장은 노래 시각(영상 시각 − 오프셋)
 *  - 길게 누르면(holdMinMs 이상) 그 길이를 hold 로 함께 기록
 *  - 목록에서 문구·멤버·구간 이름 편집, ±10ms, 지우기, 그 시각으로 이동
 *  - 저장은 /api/admin/charts (KV chart:<곡ID>), 공개는 verified. 저장 안 한 작업은 이 브라우저에 임시로 남긴다
 */
import { checkChart, difficultyLabelOf, FANCHANT_DEFAULTS, fmtTime, songTimeAt, suggestSongId, videoTimeAt, youtubeIdFrom, youtubeStartFrom, type FanchantChart, type FanchantConfig, type FanchantMode } from '../../lib/fanchant';
import { VideoClock } from './clock';
import { createPlayer, YTState, ytErrorText, type YTPlayer } from './youtube';

interface Cue { t: number; text: string; member: string; section: string; hold: number }
interface Seg { from: string; to: string; offset: string }
interface VideoDraft { youtubeId: string; offset: string; segments: Seg[] }
interface Draft {
  songId: string; title: string; album: string; year: string; durationSec: string; bpm: string; difficulty: string; author: string; verified: boolean;
  cover: { youtubeId?: string; credit?: string } | null;
  videos: Record<FanchantMode, VideoDraft>;
  cues: Cue[];
}
interface ListItem { songId: string; title: string; noteCount: number; verified: boolean; hasGuide: boolean; hasMv: boolean; updatedAt: string; updatedBy: string; emptyText: number; difficultyLabel: string }

const panel = document.getElementById('panel-charts');
if (panel) setup(panel);

function setup(panel: HTMLElement) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const members: { slug: string; name: string }[] = JSON.parse(panel.dataset.members || '[]');
  const cfg: FanchantConfig = { ...FANCHANT_DEFAULTS, ...(JSON.parse(panel.dataset.config || '{}') as Partial<FanchantConfig>) };
  const DRAFT_KEY = 'admin.chartDraft';
  const AUTHOR_KEY = 'admin.chartAuthor';
  const store = {
    get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 저장 안 돼도 괜찮음 */ } },
    del: (k: string) => { try { localStorage.removeItem(k); } catch { /* 없음 */ } },
  };
  const kst = (iso: string) => {
    if (!iso) return '';
    const d = new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString();
    return `${d.slice(5, 7)}.${d.slice(8, 10)} ${d.slice(11, 16)}`;
  };
  async function api<T>(path: string, body?: unknown): Promise<T & { ok?: boolean; error?: string; conflict?: boolean; status: number }> {
    const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({ ok: false, error: `요청 실패 (${res.status})` }))) as T & { ok?: boolean; error?: string; conflict?: boolean };
    return { ...data, status: res.status };
  }

  // ── 상태 ──
  const blank = (): Draft => ({
    songId: '', title: '', album: '', year: '', durationSec: '', bpm: '', difficulty: '2', author: store.get(AUTHOR_KEY) ?? '', verified: false, cover: null,
    videos: { guide: { youtubeId: '', offset: '0', segments: [] }, mv: { youtubeId: '', offset: '0', segments: [] } },
    cues: [],
  });
  let draft = blank();
  let savedId: string | null = null; // KV에 이미 있는 곡 ID (있으면 곡 ID를 못 바꿈)
  let baseUpdatedAt = '';
  let dirty = false;
  let mode: FanchantMode = 'guide';
  let selected: Cue | null = null;
  let recording = false;
  const undo: Cue[] = [];
  let player: YTPlayer | null = null;
  let playerVideo = '';
  let clock: VideoClock | null = null;
  let videoDuration = 0;
  let started = false;
  let raf = 0;
  let lastCrossIdx = -1;
  let lastSongT = 0;
  let pressing: { cue: Cue; vt: number } | null = null;

  const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
  const curVideo = () => {
    const v = draft.videos[mode];
    const segments = v.segments.map((s) => ({ from: num(s.from), to: num(s.to), offset: num(s.offset) })).filter((s) => [s.from, s.to, s.offset].every(Number.isFinite) && s.to > s.from);
    return { offset: Number.isFinite(num(v.offset)) ? num(v.offset) : 0, segments };
  };
  const curYoutube = () => youtubeIdFrom(draft.videos[mode].youtubeId) ?? '';

  function toRaw(d: Draft): unknown {
    return {
      songId: d.songId.trim(), title: d.title, album: d.album, year: num(d.year), durationSec: num(d.durationSec), bpm: num(d.bpm),
      difficulty: Number(d.difficulty), difficultyLabel: difficultyLabelOf(Number(d.difficulty)), author: d.author, verified: d.verified,
      ...(d.cover ? { cover: d.cover } : {}),
      cues: d.cues.map((c) => ({ t: c.t, text: c.text, ...(c.member ? { member: c.member } : {}), ...(c.section ? { section: c.section } : {}), ...(c.hold ? { type: 'hold', duration: c.hold } : {}) })),
      videos: (['guide', 'mv'] as const).filter((m) => d.videos[m].youtubeId.trim()).map((m) => ({
        mode: m, youtubeId: d.videos[m].youtubeId.trim(), offset: num(d.videos[m].offset),
        ...(d.videos[m].segments.length ? { segments: d.videos[m].segments.map((s) => ({ from: num(s.from), to: num(s.to), offset: num(s.offset) })) } : {}),
      })),
    };
  }
  function fromChart(c: Partial<FanchantChart>): Draft {
    const d = blank();
    Object.assign(d, {
      songId: c.songId ?? '', title: c.title ?? '', album: c.album ?? '', year: c.year ? String(c.year) : '', durationSec: c.durationSec ? String(c.durationSec) : '',
      bpm: c.bpm ? String(c.bpm) : '', difficulty: String(c.difficulty ?? 2), author: c.author ?? d.author, verified: c.verified === true, cover: c.cover ?? null,
    });
    for (const v of c.videos ?? []) {
      if (v.mode !== 'guide' && v.mode !== 'mv') continue;
      d.videos[v.mode] = { youtubeId: v.youtubeId ?? '', offset: String(v.offset ?? 0), segments: (v.segments ?? []).map((s) => ({ from: String(s.from), to: String(s.to), offset: String(s.offset) })) };
    }
    d.cues = (c.cues ?? []).map((q) => ({ t: Number(q.t) || 0, text: q.text ?? '', member: q.member ?? '', section: q.section ?? '', hold: Number(q.type === 'hold' ? q.duration : (q as { hold?: number }).hold) || 0 })).sort((a, b) => a.t - b.t);
    return d;
  }

  // ── 목록 ──
  async function loadList() {
    const box = $('charts-list');
    const d = await api<{ charts: ListItem[] }>('/api/admin/charts');
    if (!d.ok) { box.innerHTML = `<div class="card admin-empty">${esc(d.error ?? '목록을 못 읽었어요')}</div>`; return; }
    box.innerHTML = d.charts.length ? d.charts.map((c) => `
      <div class="card admin-item">
        <div class="admin-item-top">
          <span class="admin-tag ${c.verified ? 's-approved' : ''}">${c.verified ? '공개' : '초안'}</span>
          <span>${esc(c.songId)}</span><span>큐 ${c.noteCount}개${c.emptyText ? ` · 문구 빈 큐 ${c.emptyText}` : ''}</span>
          <span>${c.hasGuide ? '가이드' : ''}${c.hasMv ? ' · 뮤비' : ' · 뮤비 없음'}</span>
          <span>${esc(kst(c.updatedAt))}${c.updatedBy ? ` · ${esc(c.updatedBy.split('@')[0])}` : ''}</span>
        </div>
        <div class="admin-actions"><h3 style="margin:0;flex:1">${esc(c.title)}</h3><a class="admin-btn" href="/admin/play?song=${encodeURIComponent(c.songId)}&mode=step1" target="_blank" rel="noopener">시험 플레이</a>${c.verified ? `<a class="admin-btn" href="/game/play?song=${encodeURIComponent(c.songId)}" target="_blank" rel="noopener">게임에서 보기</a>` : ''}<button type="button" class="admin-btn" data-open="${esc(c.songId)}">열기</button></div>
      </div>`).join('') : '<div class="card admin-empty">아직 채보가 없어요. "새 채보"로 시작해 보세요.</div>';
    box.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => b.addEventListener('click', () => openChart(b.dataset.open!)));
    showDraftNote();
  }
  function showDraftNote() {
    const raw = store.get(DRAFT_KEY);
    const box = $('chart-draft-note');
    box.innerHTML = '';
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { draft: Draft; savedId: string | null; baseUpdatedAt: string; at: string };
      box.innerHTML = `<div class="card admin-item"><div class="admin-actions"><span style="flex:1">저장 안 한 작업이 있어요: <strong>${esc(saved.draft.title || saved.draft.songId || '제목 없음')}</strong> (큐 ${saved.draft.cues.length}개 · ${esc(kst(saved.at))})</span><button type="button" class="admin-btn is-accent" id="draft-resume">이어서 하기</button><button type="button" class="admin-btn" id="draft-drop">버리기</button></div></div>`;
      $('draft-resume').onclick = () => { draft = saved.draft; savedId = saved.savedId; baseUpdatedAt = saved.baseUpdatedAt; enterEditor(true); };
      $('draft-drop').onclick = () => { store.del(DRAFT_KEY); box.innerHTML = ''; };
    } catch { store.del(DRAFT_KEY); }
  }
  async function openChart(id: string) {
    const d = await api<{ chart: FanchantChart }>(`/api/admin/charts?id=${encodeURIComponent(id)}`);
    if (!d.ok) { $('charts-list').insertAdjacentHTML('afterbegin', `<div class="card admin-empty">${esc(d.error ?? '못 읽었어요')}</div>`); return; }
    draft = fromChart(d.chart);
    savedId = d.chart.songId;
    baseUpdatedAt = d.chart.updatedAt ?? '';
    enterEditor(false);
  }
  $('chart-new').addEventListener('click', () => { draft = blank(); savedId = null; baseUpdatedAt = ''; enterEditor(false); });
  $<HTMLInputElement>('chart-import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const c = JSON.parse(await file.text()) as FanchantChart;
      draft = fromChart(c);
      savedId = null;
      baseUpdatedAt = '';
      enterEditor(true);
      setStatus('불러왔어요. 저장해야 KV에 들어가요');
    } catch {
      $('chart-draft-note').innerHTML = '<div class="card admin-empty">JSON을 읽지 못했어요</div>';
    }
  });

  // ── 편집 화면 ──
  function enterEditor(isDirty: boolean) {
    $('charts-home').hidden = true;
    $('chart-editor').hidden = false;
    dirty = isDirty;
    selected = null;
    undo.length = 0;
    setRecording(false);
    fillForm();
    renderCues();
    validate();
    setStatus(savedId ? `저장된 채보${baseUpdatedAt ? ` · ${kst(baseUpdatedAt)}` : ''}` : '새 채보 (아직 저장 안 함)');
    syncPlayer();
    loop();
  }
  $('ed-back').addEventListener('click', () => {
    if (dirty) persistDraft();
    player?.pauseVideo();
    cancelAnimationFrame(raf);
    $('chart-editor').hidden = true;
    $('charts-home').hidden = false;
    loadList();
  });

  function fillForm() {
    for (const el of panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]')) {
      const k = el.dataset.f as keyof Draft;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(draft[k]);
      else el.value = String(draft[k] ?? '');
    }
    const idInput = panel.querySelector<HTMLInputElement>('[data-f="songId"]')!;
    idInput.readOnly = Boolean(savedId);
    idInput.title = savedId ? '저장된 채보는 곡 ID를 바꿀 수 없어요 (JSON 내려받기 → 불러오기로 새로 만들기)' : '';
    for (const box of panel.querySelectorAll<HTMLElement>('.ed-video')) {
      const m = box.dataset.mode as FanchantMode;
      for (const el of box.querySelectorAll<HTMLInputElement>('[data-v]')) el.value = draft.videos[m][el.dataset.v as 'youtubeId' | 'offset'];
      renderSegs(box, m);
    }
    $('ed-title').textContent = draft.title || '새 채보';
    $('ed-delete').hidden = !savedId;
    const tryLink = $<HTMLAnchorElement>('ed-try');
    tryLink.hidden = !savedId;
    if (savedId) tryLink.href = `/admin/play?song=${encodeURIComponent(savedId)}&mode=step1`;
    tryLink.title = '저장한 내용으로 해 봐요 (기록은 안 남아요)';
  }
  function renderSegs(box: HTMLElement, m: FanchantMode) {
    const wrap = box.querySelector<HTMLElement>('.ed-segs')!;
    wrap.innerHTML = draft.videos[m].segments.map((s, i) => `
      <div class="ed-seg" data-i="${i}">
        <label>영상 시작(초)<input data-s="from" value="${esc(s.from)}" inputmode="decimal" /></label>
        <label>영상 끝(초)<input data-s="to" value="${esc(s.to)}" inputmode="decimal" /></label>
        <label>오프셋(초)<input data-s="offset" value="${esc(s.offset)}" inputmode="decimal" /></label>
        <button type="button" class="admin-btn ed-mini" data-act="seg-del" aria-label="이 구간 지우기">×</button>
      </div>`).join('');
  }

  function changed() {
    dirty = true;
    setStatus('저장 안 함');
    persistDraftSoon();
    validate();
  }
  let draftTimer = 0;
  const persistDraftSoon = () => { clearTimeout(draftTimer); draftTimer = window.setTimeout(persistDraft, 800); };
  function persistDraft() {
    if (!dirty) return;
    store.set(DRAFT_KEY, JSON.stringify({ draft, savedId, baseUpdatedAt, at: new Date().toISOString() }));
  }
  window.addEventListener('beforeunload', (e) => { if (dirty && !$('chart-editor').hidden) { persistDraft(); e.preventDefault(); } });

  panel.querySelector('.ed-meta')!.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.dataset.f) {
      const k = el.dataset.f as keyof Draft;
      (draft as unknown as Record<string, unknown>)[k] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'title') {
        $('ed-title').textContent = draft.title || '새 채보';
        const idInput = panel.querySelector<HTMLInputElement>('[data-f="songId"]')!;
        if (!savedId && !idInput.dataset.touched) { draft.songId = suggestSongId(draft.title); idInput.value = draft.songId; }
      }
      if (k === 'songId') (el as HTMLInputElement).dataset.touched = '1';
      if (k === 'author') store.set(AUTHOR_KEY, draft.author);
    }
    const box = el.closest<HTMLElement>('.ed-video');
    if (box) {
      const m = box.dataset.mode as FanchantMode;
      if (el.dataset.v) {
        draft.videos[m][el.dataset.v as 'youtubeId' | 'offset'] = el.value;
        if (el.dataset.v === 'youtubeId') {
          // 링크에 시작 위치(t=)가 있고 오프셋이 비었으면 그걸 오프셋으로
          const start = youtubeStartFrom(el.value);
          const off = draft.videos[m].offset.trim();
          if (start != null && (off === '' || Number(off) === 0)) {
            draft.videos[m].offset = String(start);
            box.querySelector<HTMLInputElement>('[data-v="offset"]')!.value = draft.videos[m].offset;
            setTimeout(() => setStatus(`링크의 시작 위치 ${start}초를 오프셋으로 넣었어요. 정확히는 재생하다 "지금 위치로"로 다듬어 주세요`), 0);
            renderCues();
            renderTimeline();
          }
          if (m === mode) syncPlayerSoon();
        }
        if (el.dataset.v === 'offset') { renderCues(); renderTimeline(); }
      }
      if (el.dataset.s) {
        const i = Number(el.closest<HTMLElement>('.ed-seg')!.dataset.i);
        draft.videos[m].segments[i][el.dataset.s as keyof Seg] = el.value;
        renderCues();
        renderTimeline();
      }
    }
    changed();
  });
  panel.querySelector('.ed-meta')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!btn) return;
    const box = btn.closest<HTMLElement>('.ed-video')!;
    const m = box.dataset.mode as FanchantMode;
    const vt = m === mode && clock ? clock.now() : 0;
    if (btn.dataset.act === 'offset-now') {
      if (m !== mode || !player) { setStatus('그 영상을 재생 중일 때 누르세요'); return; }
      draft.videos[m].offset = vt.toFixed(2);
      box.querySelector<HTMLInputElement>('[data-v="offset"]')!.value = draft.videos[m].offset;
      renderCues();
      renderTimeline();
    } else if (btn.dataset.act === 'off') {
      // 이 영상만: 오프셋(구간 오프셋 포함)을 옮긴다. 큐(노래 시각)와 다른 영상은 그대로
      const d = Number(btn.dataset.d);
      const v = draft.videos[m];
      const r = (x: string) => String(Math.max(0, Math.round(((Number(x) || 0) + d) * 1000) / 1000));
      v.offset = r(v.offset);
      for (const sg of v.segments) sg.offset = r(sg.offset);
      box.querySelector<HTMLInputElement>('[data-v="offset"]')!.value = v.offset;
      renderSegs(box, m);
      renderCues();
      renderTimeline();
      setTimeout(() => setStatus(`${m === 'mv' ? '뮤비' : '가이드'} 큐를 ${d < 0 ? '앞으로' : '뒤로'} ${Math.abs(d)}초 옮겼어요 (오프셋 ${v.offset}초)`), 0);
    } else if (btn.dataset.act === 'seg-add') {
      const v = draft.videos[m];
      v.segments.push({ from: vt ? vt.toFixed(2) : '', to: '', offset: v.offset });
      renderSegs(box, m);
    } else if (btn.dataset.act === 'seg-del') {
      draft.videos[m].segments.splice(Number(btn.closest<HTMLElement>('.ed-seg')!.dataset.i), 1);
      renderSegs(box, m);
      renderCues();
      renderTimeline();
    }
    changed();
  });
  $('ed-dur').addEventListener('click', () => {
    if (!player || !videoDuration) { setStatus('영상을 먼저 불러와 주세요'); return; }
    draft.durationSec = Math.max(1, videoDuration - curVideo().offset).toFixed(1);
    panel.querySelector<HTMLInputElement>('[data-f="durationSec"]')!.value = draft.durationSec;
    changed();
  });

  // ── 검사·저장 ──
  function validate() {
    const r = checkChart(toRaw(draft), { memberSlugs: members.map((m) => m.slug), minCueGapMs: cfg.minCueGapMs });
    $('ed-issues').innerHTML = [...r.errors.map((t) => `<li class="is-err">저장 전에 고칠 것 · ${esc(t)}</li>`), ...r.warnings.map((t) => `<li class="is-warn">확인 · ${esc(t)}</li>`)].join('');
    return r;
  }
  const setStatus = (t: string) => { $('ed-status').textContent = t; };
  async function save(force = false) {
    const r = validate();
    if (!r.chart) { setStatus('고칠 것이 있어요 (아래 목록)'); return; }
    const btn = $<HTMLButtonElement>('ed-save');
    btn.disabled = true;
    setStatus('저장 중…');
    try {
      const d = await api<{ chart: FanchantChart; warnings: string[]; updatedAt?: string; updatedBy?: string }>('/api/admin/charts', { chart: toRaw(draft), baseUpdatedAt, force });
      if (d.conflict) {
        const box = $('ed-conflict');
        box.hidden = false;
        box.innerHTML = `${esc(d.error ?? '')}${d.updatedAt ? ` (${esc(kst(d.updatedAt))}${d.updatedBy ? ` · ${esc(d.updatedBy.split('@')[0])}` : ''})` : ''}. <button type="button" class="admin-btn ed-mini" id="ed-force">내 것으로 덮어쓰기</button>`;
        $('ed-force').onclick = () => { box.hidden = true; save(true); };
        setStatus('저장 안 됨');
        return;
      }
      if (!d.ok) { setStatus(d.error ?? '저장 실패'); return; }
      $('ed-conflict').hidden = true;
      savedId = d.chart.songId;
      baseUpdatedAt = d.chart.updatedAt ?? '';
      dirty = false;
      store.del(DRAFT_KEY);
      fillForm();
      setStatus(`저장했어요 · ${kst(baseUpdatedAt)}${d.chart.verified ? ' · 다음 수집 때 게임에 반영' : ' · 초안'}`);
    } catch (err) {
      setStatus(`저장 실패: ${(err as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  }
  $('ed-save').addEventListener('click', () => save());
  $('ed-try').addEventListener('click', () => { if (dirty) setStatus('저장 안 한 변경은 시험 플레이에 안 들어가요. 먼저 저장해 주세요'); });
  $('ed-download').addEventListener('click', () => {
    const r = checkChart(toRaw(draft), { minCueGapMs: cfg.minCueGapMs });
    const body = JSON.stringify(r.chart ?? toRaw(draft), null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = `${draft.songId || 'fanchant'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  let deleteArmed = 0;
  $('ed-delete').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('ed-delete');
    if (!savedId) return;
    if (Date.now() - deleteArmed > 4000) { deleteArmed = Date.now(); btn.textContent = '한 번 더 누르면 지워요'; setTimeout(() => (btn.textContent = '지우기'), 4000); return; }
    const d = await api('/api/admin/charts', { action: 'delete', songId: savedId });
    if (!d.ok) { setStatus(d.error ?? '지우기 실패'); return; }
    dirty = false;
    store.del(DRAFT_KEY);
    $('ed-back').click();
  });

  // ── 큐 목록 ──
  const memberOptions = (cur: string) => `<option value="">멤버</option>${members.map((m) => `<option value="${esc(m.slug)}"${m.slug === cur ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}`;
  const rowOf = new Map<Cue, HTMLLIElement>();
  function renderCues() {
    const list = $('ed-cues');
    rowOf.clear();
    const v = curVideo();
    const gap = cfg.minCueGapMs / 1000;
    $('ed-cue-count').textContent = `큐 ${draft.cues.length}개${draft.cues.some((c) => c.hold) ? ` · 홀드 ${draft.cues.filter((c) => c.hold).length}` : ''}`;
    if (!draft.cues.length) { list.innerHTML = '<li class="ed-cue-empty">녹음을 켜고 재생하면서 스페이스를 눌러 보세요.</li>'; renderTimeline(); return; }
    list.innerHTML = '';
    draft.cues.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'ed-cue';
      if (c === selected) li.classList.add('is-sel');
      if (i > 0 && c.t - draft.cues[i - 1].t < gap) li.classList.add('is-close');
      li.innerHTML = `
        <button type="button" class="ed-t" data-a="seek" title="이 시각으로 이동">${fmtTime(c.t, 3)}${c.hold ? ` <b>홀드 ${c.hold.toFixed(2)}s</b>` : ''}<small>영상 ${fmtTime(videoTimeAt(v, c.t))}</small></button>
        <input data-k="text" value="${esc(c.text)}" placeholder="문구" aria-label="응원 문구" maxlength="40" />
        <select data-k="member" aria-label="멤버">${memberOptions(c.member)}</select>
        <span class="ed-cue-btns">
          <button type="button" data-a="nudge" data-d="-1" aria-label="${cfg.nudgeMs}ms 앞으로">−${cfg.nudgeMs}</button>
          <button type="button" data-a="nudge" data-d="1" aria-label="${cfg.nudgeMs}ms 뒤로">+${cfg.nudgeMs}</button>
          <button type="button" data-a="hold" aria-label="홀드 길이" title="홀드 길이 (초, 0이면 탭)">⟷</button>
          <button type="button" data-a="del" aria-label="이 큐 지우기">×</button>
        </span>
        <input class="ed-sec" data-k="section" value="${esc(c.section)}" placeholder="구간 이름 (선택, 예: 후렴 첫 콜)" aria-label="구간 이름" maxlength="40" />`;
      rowOf.set(c, li);
      list.append(li);
    });
    renderTimeline();
  }
  const cueOfRow = (el: Element) => {
    const li = el.closest('li');
    for (const [c, row] of rowOf) if (row === li) return c;
    return null;
  };
  function select(c: Cue | null) {
    if (selected) rowOf.get(selected)?.classList.remove('is-sel');
    selected = c;
    if (c) rowOf.get(c)?.classList.add('is-sel');
    renderTimeline();
  }
  $('ed-cues').addEventListener('focusin', (e) => { const c = cueOfRow(e.target as Element); if (c && c !== selected) select(c); });
  $('ed-cues').addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const c = cueOfRow(el);
    if (!c || !el.dataset.k) return;
    const k = el.dataset.k as 'text' | 'member' | 'section';
    c[k] = el.value;
    // 문구에 멤버 이름이 있으면 멤버 자동으로
    if (k === 'text' && !c.member) {
      const m = members.find((x) => el.value.includes(x.name));
      if (m) { c.member = m.slug; rowOf.get(c)!.querySelector<HTMLSelectElement>('[data-k="member"]')!.value = m.slug; }
    }
    renderTimeline();
    changed();
  });
  $('ed-cues').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-a]');
    if (!btn) return;
    const c = cueOfRow(btn);
    if (!c) return;
    select(c);
    if (btn.dataset.a === 'seek') seekVideo(videoTimeAt(curVideo(), c.t) - 1.5);
    else if (btn.dataset.a === 'nudge') nudge(c, Number(btn.dataset.d));
    else if (btn.dataset.a === 'del') { draft.cues.splice(draft.cues.indexOf(c), 1); selected = null; renderCues(); changed(); }
    else if (btn.dataset.a === 'hold') {
      const v = prompt('홀드 길이(초). 0이면 탭', c.hold ? String(c.hold) : '0');
      if (v === null) return;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 60) { c.hold = Math.round(n * 1000) / 1000; renderCues(); changed(); }
    }
  });
  function nudge(c: Cue, dir: number) {
    c.t = Math.max(0, Math.round((c.t + (dir * cfg.nudgeMs) / 1000) * 1000) / 1000);
    draft.cues.sort((a, b) => a.t - b.t);
    renderCues();
    changed();
  }
  $('ed-shift-go').addEventListener('click', () => {
    const ms = Number($<HTMLInputElement>('ed-shift').value);
    if (!Number.isFinite(ms) || !ms || !draft.cues.length) return;
    for (const c of draft.cues) c.t = Math.max(0, Math.round((c.t + ms / 1000) * 1000) / 1000);
    $<HTMLInputElement>('ed-shift').value = '';
    renderCues();
    changed();
    setStatus(`전체 큐를 ${ms > 0 ? '+' : ''}${ms}ms 옮겼어요`);
  });
  $('ed-bulk-go').addEventListener('click', () => {
    const lines = $<HTMLTextAreaElement>('ed-bulk').value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length || !draft.cues.length) return;
    const start = selected ? draft.cues.indexOf(selected) : draft.cues.findIndex((c) => !c.text);
    let i = Math.max(0, start);
    for (const line of lines) {
      if (i >= draft.cues.length) break;
      const c = draft.cues[i++];
      c.text = line.slice(0, 40);
      if (!c.member) c.member = members.find((m) => line.includes(m.name))?.slug ?? '';
    }
    renderCues();
    changed();
    setStatus(`${Math.min(lines.length, draft.cues.length - Math.max(0, start))}개 채웠어요`);
  });

  // ── 타임라인 ──
  const tlSpan = () => videoDuration || (num(draft.durationSec) || 0) + curVideo().offset || Math.max(60, (draft.cues.at(-1)?.t ?? 0) + 10);
  function renderTimeline() {
    const span = tlSpan();
    const v = curVideo();
    const pct = (vt: number) => `${Math.min(100, Math.max(0, (vt / span) * 100))}%`;
    $('ed-tl-marks').innerHTML =
      v.segments.map((s) => `<div class="ed-tl-seg" style="left:${pct(s.from)};width:calc(${pct(s.to)} - ${pct(s.from)})"></div>`).join('') +
      `<div class="ed-tl-start" style="left:${pct(v.offset)}" title="노래 시작"></div>` +
      draft.cues.map((c) => `<div class="ed-tl-mark${c.text ? ' has-text' : ''}${c === selected ? ' is-sel' : ''}" style="left:${pct(videoTimeAt(v, c.t))}${c.hold ? `;width:calc(${pct(videoTimeAt(v, c.t + c.hold))} - ${pct(videoTimeAt(v, c.t))});opacity:.7` : ''}"></div>`).join('');
    $('ed-tl-end').textContent = fmtTime(span, 0);
    $('ed-tl').setAttribute('aria-valuemax', String(Math.round(span)));
  }
  const tl = $('ed-tl');
  const tlSeek = (e: PointerEvent) => {
    const r = tl.getBoundingClientRect();
    seekVideo(((e.clientX - r.left) / r.width) * tlSpan());
  };
  tl.addEventListener('pointerdown', (e) => { tl.setPointerCapture(e.pointerId); tlSeek(e); });
  tl.addEventListener('pointermove', (e) => { if (tl.hasPointerCapture(e.pointerId)) tlSeek(e); });

  // ── 플레이어 ──
  let syncTimer = 0;
  const syncPlayerSoon = () => { clearTimeout(syncTimer); syncTimer = window.setTimeout(syncPlayer, 600); };
  async function syncPlayer() {
    const id = curYoutube();
    const box = $('ed-player');
    if (!id) {
      if (!player) box.innerHTML = '<div class="ed-yt-empty">위 "곡 정보 · 영상"에 유튜브 주소를 넣으면 여기서 재생돼요</div>';
      $('ed-state').textContent = mode === 'mv' ? '뮤비 주소가 없어요' : '가이드 주소가 없어요';
      return;
    }
    if (id === playerVideo && player) return;
    playerVideo = id;
    videoDuration = 0;
    if (player) { player.cueVideoById(id); clock?.sample(); return; }
    box.innerHTML = '<div></div>';
    $('ed-state').textContent = '플레이어 불러오는 중…';
    try {
      player = await createPlayer(box.firstElementChild as HTMLElement, id, {
        ready: () => { $('ed-state').textContent = ''; },
        state: (s) => onState(s),
        error: (code) => { $('ed-state').textContent = ytErrorText(code); },
        rate: () => clock?.sample(),
      });
      clock = new VideoClock(player, cfg.clockSampleMs);
      clock.start();
      player.setPlaybackRate(Number($<HTMLSelectElement>('ed-rate').value));
    } catch (err) {
      $('ed-state').textContent = (err as Error).message;
    }
  }
  const STATE_TEXT: Record<number, string> = { [-1]: '', 0: '끝', 1: '재생 중', 2: '일시정지', 3: '버퍼링', 5: '' };
  function onState(s: number) {
    clock?.sample(s);
    $('ed-state').textContent = STATE_TEXT[s] ?? '';
    $('ed-play').textContent = s === YTState.PLAYING ? '❚❚ 일시정지' : '▶ 재생';
    if (s === YTState.PLAYING || s === YTState.CUED || s === YTState.PAUSED) {
      const d = player?.getDuration() ?? 0;
      if (d && d !== videoDuration) { videoDuration = d; renderTimeline(); }
    }
    if (s === YTState.PLAYING) returnFocus();
    if (s !== YTState.PLAYING) endPress();
  }
  function togglePlay() {
    if (!player || !clock) return;
    if (clock.playing) player.pauseVideo(); else player.playVideo();
  }
  function seekVideo(vt: number) {
    if (!player || !clock) return;
    const t = Math.max(0, Math.min(vt, (videoDuration || Infinity) - 0.2));
    player.seekTo(t, true);
    clock.jumpTo(t);
    lastCrossIdx = -2; // 다시 계산
  }
  $('ed-play').addEventListener('click', () => { togglePlay(); returnFocus(); });
  panel.querySelectorAll<HTMLButtonElement>('[data-seek]').forEach((b) => b.addEventListener('click', () => { if (clock) seekVideo(clock.now() + Number(b.dataset.seek)); returnFocus(); }));
  $<HTMLSelectElement>('ed-rate').addEventListener('change', (e) => { player?.setPlaybackRate(Number((e.target as HTMLSelectElement).value)); clock?.sample(); });
  panel.querySelectorAll<HTMLButtonElement>('.ed-modes [data-mode]').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode as FanchantMode;
    panel.querySelectorAll('.ed-modes [data-mode]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    player?.pauseVideo();
    syncPlayer();
    renderCues();
  }));
  // 포커스가 유튜브 iframe으로 가면 스페이스를 못 받는다
  const returnFocus = () => { if (document.activeElement instanceof HTMLIFrameElement || document.activeElement === document.body) $('ed-tap').focus({ preventScroll: true }); };
  window.addEventListener('blur', () => { setTimeout(() => { if (!$('chart-editor').hidden && document.activeElement instanceof HTMLIFrameElement) $('ed-focus').hidden = false; }, 0); });
  window.addEventListener('focus', () => { $('ed-focus').hidden = true; });

  // ── 녹음 ──
  function setRecording(on: boolean) {
    recording = on;
    const b = $('ed-rec');
    b.setAttribute('aria-pressed', String(on));
    b.lastChild!.textContent = on ? ' 녹음 중 (누르면 멈춤)' : ' 녹음 시작';
    if (!on) endPress();
  }
  $('ed-rec').addEventListener('click', () => { setRecording(!recording); returnFocus(); });
  /** 누른 순간(이벤트 시각 기준)의 노래 시각으로 큐 추가. 녹음 중 + 재생 중일 때만 */
  function press(eventTime: number) {
    if (!recording || !clock?.playing || pressing) return false;
    const vt = clock.now(Math.min(eventTime, performance.now()));
    const t = Math.max(0, Math.round(songTimeAt(curVideo(), vt) * 1000) / 1000);
    const cue: Cue = { t, text: '', member: '', section: '', hold: 0 };
    draft.cues.push(cue);
    draft.cues.sort((a, b) => a.t - b.t);
    undo.push(cue);
    $<HTMLButtonElement>('ed-undo').disabled = false;
    pressing = { cue, vt };
    selected = cue;
    renderCues();
    rowOf.get(cue)?.scrollIntoView({ block: 'nearest' });
    changed();
    $('ed-tap').classList.add('is-hit');
    return true;
  }
  /** 뗀 순간: holdMinMs 넘게 눌렀으면 길게 누르기로 */
  function release(eventTime: number) {
    $('ed-tap').classList.remove('is-hit');
    if (!pressing || !clock) { pressing = null; return; }
    const { cue, vt } = pressing;
    pressing = null;
    const held = clock.now(Math.min(eventTime, performance.now())) - vt; // 영상 시각 차 = 노래 시각 차 (재생 속도 반영됨)
    if (held * 1000 >= cfg.holdMinMs) {
      cue.hold = Math.round(held * 1000) / 1000;
      renderCues();
      changed();
    }
  }
  const endPress = () => { if (pressing) release(performance.now()); };
  $('ed-undo').addEventListener('click', () => {
    const c = undo.pop();
    if (c) { const i = draft.cues.indexOf(c); if (i >= 0) draft.cues.splice(i, 1); if (selected === c) selected = null; renderCues(); changed(); }
    $<HTMLButtonElement>('ed-undo').disabled = !undo.length;
    returnFocus();
  });
  const tap = $('ed-tap');
  tap.addEventListener('pointerdown', (e) => { e.preventDefault(); tap.setPointerCapture(e.pointerId); if (!press(e.timeStamp)) togglePlayIfIdle(); });
  tap.addEventListener('pointerup', (e) => release(e.timeStamp));
  tap.addEventListener('pointercancel', (e) => release(e.timeStamp));
  // 녹음이 꺼져 있을 때 TAP은 재생/정지
  const togglePlayIfIdle = () => { if (!recording) togglePlay(); };

  // ── 키보드 ──
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(t instanceof HTMLInputElement && t.type === 'checkbox'));
  const editorOn = () => !panel.hidden && !$('chart-editor').hidden;
  document.addEventListener('keydown', (e) => {
    if (!editorOn() || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      if (!press(e.timeStamp)) togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!clock) return;
      e.preventDefault();
      seekVideo(clock.now() + (e.key === 'ArrowLeft' ? -2 : 2));
    } else if (e.key === 'z' || e.key === 'Z') {
      $('ed-undo').click();
    } else if ((e.key === ',' || e.key === '.') && selected) {
      nudge(selected, e.key === ',' ? -1 : 1);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (!editorOn() || typing(e.target)) return;
    if (e.code === 'Space') { e.preventDefault(); release(e.timeStamp); }
  });

  // ── 화면 갱신 (재생 헤드·현재 큐·틱 소리) ──
  let audio: AudioContext | null = null;
  function tick() {
    if (!$<HTMLInputElement>('ed-tick').checked) return;
    try {
      audio ??= new AudioContext();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = 1760;
      g.gain.setValueAtTime(0.25, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.05);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.06);
    } catch { /* 소리 못 내도 괜찮음 */ }
  }
  let flashTimer = 0;
  function flash(c: Cue) {
    const f = $('ed-flash');
    f.textContent = c.text || '•';
    f.classList.add('is-on');
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => f.classList.remove('is-on'), Math.max(120, (c.hold || 0) * 1000));
    tick();
  }
  let nowRow: HTMLLIElement | null = null;
  function loop() {
    cancelAnimationFrame(raf);
    const frame = () => {
      if (!editorOn()) return;
      raf = requestAnimationFrame(frame);
      if (!clock) return;
      const vt = clock.now();
      const st = songTimeAt(curVideo(), vt);
      $('ed-clock').textContent = `영상 ${fmtTime(vt)} · 노래 ${fmtTime(st)}`;
      $('ed-tl-head').style.left = `${Math.min(100, Math.max(0, (vt / tlSpan()) * 100))}%`;
      // 지나간 큐 (점프하면 다시 계산, 재생 중 앞으로 흐를 때만 반짝)
      let idx = -1;
      for (let i = 0; i < draft.cues.length && draft.cues[i].t <= st; i++) idx = i;
      if (lastCrossIdx === -2 || st < lastSongT - 0.05 || st - lastSongT > 0.6) lastCrossIdx = idx;
      else if (clock.playing && idx > lastCrossIdx) { if (draft.cues[idx] !== pressing?.cue) flash(draft.cues[idx]); lastCrossIdx = idx; }
      lastSongT = st;
      const near = idx >= 0 ? draft.cues[idx] : null;
      const row = near ? rowOf.get(near) ?? null : null;
      if (row !== nowRow) {
        nowRow?.classList.remove('is-now');
        row?.classList.add('is-now');
        if (row && clock.playing && !recording) row.scrollIntoView({ block: 'nearest' });
        nowRow = row;
      }
    };
    raf = requestAnimationFrame(frame);
  }

  // ── 시작: 탭을 처음 열 때 ──
  function start() {
    if (started) return;
    started = true;
    loadList();
  }
  document.addEventListener('admin:tab', (e) => { if ((e as CustomEvent).detail === 'charts') { start(); if (editorOn()) loop(); } });
  if (!panel.hidden) start();
}
