// 어드민 "데이터 고치기": 일정·소식·시리즈·아카이브를 손으로 만들고 고치고 숨긴다.
// 수집기가 올린 원본(/api/admin/raw)에 수정 목록(/api/admin/edits)을 여기서 직접 덧씌워 보여 준다 → 저장하면 바로 보임.
// 공개 사이트는 1분 남짓 안에, 수집기는 다음 수집 때 반영한다.
import {
  applyEraList, applyEraPage, applyEvents, applyFeed, applySeriesList, applySeriesPage, eventTarget, linkKey, normUrl,
  type AddedVideo, type Edit, type EditsDoc,
} from '../lib/edits';

type Ev = { id: string; date: string; time: string | null; endDate?: string | null; endTime?: string | null; title: string; step: string; kind: string; members: string[]; sources?: { url: string }[] };
type Feed = { type: string; title: string; url: string; publishedAt: string; publisher?: string; members: string[]; image?: string };
type View = 'event' | 'feed' | 'series' | 'era' | 'edits';

const panel = document.getElementById('panel-data');
if (panel) start(panel);

function start(root: HTMLElement) {
  const MEMBERS: string[] = JSON.parse(root.dataset.members ?? '[]').map((m: { name: string }) => m.name);
  const body = root.querySelector<HTMLElement>('#dx-body')!;
  const status = root.querySelector<HTMLElement>('#dx-status')!;
  let doc: EditsDoc = { rev: 0, items: [] };
  let meta = { seriesTypes: [] as string[], eventKinds: [] as string[], feedTypes: [] as string[] };
  let view: View = 'event';
  let query = '';
  const rawCache = new Map<string, Promise<any>>();
  let started = false;

  const esc = (t: unknown) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
  const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const kstInput = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 16);
  const kstLabel = (iso: string) => kstInput(iso).replace('T', ' ').slice(5);
  const say = (t: string) => { status.textContent = t; };
  const raw = (path: string) => {
    if (!rawCache.has(path)) rawCache.set(path, fetch(`/api/admin/raw?path=${encodeURIComponent(path)}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null));
    return rawCache.get(path)!;
  };

  async function api<T>(path: string, payload?: unknown): Promise<T> {
    const res = await fetch(path, payload === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const d = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!res.ok || d.ok === false) throw new Error(d.error ?? `요청 실패 (${res.status})`);
    return d;
  }
  async function send(payload: Record<string, unknown>, done: string) {
    say('저장하는 중…');
    try {
      const d = await api<EditsDoc>('/api/admin/edits', { ...payload, rev: doc.rev });
      doc = { rev: d.rev, items: d.items };
      say(`${done} · 사이트에는 1분 안에 보여요`);
      setCount();
      return true;
    } catch (err) {
      say((err as Error).message);
      return false;
    }
  }
  const save = (edit: Partial<Edit> & { base?: unknown }, done = '저장했어요') => send({ action: 'save', edit }, done);
  const revert = (id: string) => send({ action: 'delete', id }, '되돌렸어요');
  const setCount = () => { const c = document.querySelector<HTMLElement>('[data-count="data"]'); if (c) c.textContent = doc.items.length ? String(doc.items.length) : ''; };

  const memberChecks = (picked: string[]) => `<div class="dx-members">${MEMBERS.map((m) => `<label><input type="checkbox" data-member value="${esc(m)}" ${picked.includes(m) ? 'checked' : ''}/> ${esc(m)}</label>`).join('')}</div>`;
  const pickedMembers = (form: HTMLElement) => [...form.querySelectorAll<HTMLInputElement>('[data-member]:checked')].map((x) => x.value);
  const val = (form: HTMLElement, name: string) => form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value.trim() ?? '';
  const options = (list: readonly string[], cur?: string) => list.map((k) => `<option ${k === cur ? 'selected' : ''}>${esc(k)}</option>`).join('');
  const tag = (x?: Edit) => (!x ? '' : `<span class="admin-tag ${x.op === 'add' ? 't-add' : x.op === 'hide' ? 't-delete' : 't-fix'}">${x.op === 'add' ? '직접 만듦' : x.op === 'hide' ? '숨김' : '고침'}</span>`);
  const formBox = () => body.querySelector<HTMLElement>('#dx-form')!;
  const closeForm = () => formBox().replaceChildren();

  function toolbar(placeholder: string, newLabel?: string) {
    const bar = el(`<div class="dx-bar"><input type="search" placeholder="${esc(placeholder)}" value="${esc(query)}" aria-label="찾기" />${newLabel ? `<button type="button" class="admin-btn is-primary" data-new>${esc(newLabel)}</button>` : ''}</div>`);
    const input = bar.querySelector('input')!;
    let timer = 0;
    input.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => { query = input.value.trim(); renderList(); }, 200); });
    return bar;
  }
  let renderList: () => void = () => {};

  // ── 일정 ──
  async function eventView() {
    const data = await raw('events.json');
    const all = () => applyEvents((data?.events ?? []) as Ev[], doc.items);
    const editOf = (e: Ev) => doc.items.find((x) => x.kind === 'event' && (x.data?.id === e.id || x.target.id === e.id));
    const listBox = el('<div class="admin-list"></div>');
    body.replaceChildren(toolbar('제목·단계·날짜(11-23)로 찾기', '새 일정'), el('<div id="dx-form"></div>'), listBox);
    body.querySelector('[data-new]')!.addEventListener('click', () => eventForm());
    renderList = () => {
      const q = query.toLowerCase();
      const t = today();
      const list = all().filter((e) => (q ? `${e.date} ${e.date.slice(5)} ${e.title} ${e.step} ${e.members.join(' ')}`.toLowerCase().includes(q) : e.date >= addDays(t, -3) && e.date <= addDays(t, 21))).slice(0, 80);
      listBox.replaceChildren(...(list.length ? list.map((e) => {
        const row = el(`<button type="button" class="card dx-row"><span class="dx-when">${esc(e.date.slice(5).replace('-', '.'))} ${esc(e.time ?? '')}</span><span class="dx-what"><strong>${esc(e.title)}</strong> ${esc(e.step)}</span><span class="dx-meta">${esc(e.members.join('·'))} ${tag(editOf(e))}</span></button>`);
        row.addEventListener('click', () => eventForm(e));
        return row;
      }) : [el(`<div class="card admin-empty">${q ? '찾는 일정이 없어요.' : '최근 일정이 없어요.'}</div>`)]));
    };
    renderList();

    function eventForm(e?: Ev) {
      const x = e && editOf(e);
      const url = e?.sources?.[0]?.url ?? '';
      const form = el(`
        <form class="card dx-form">
          <h3>${e ? '일정 고치기' : '새 일정'} ${tag(x)}</h3>
          <div class="dx-fields">
            <label>날짜 <input type="date" name="date" value="${esc(e?.date ?? today())}" required /></label>
            <label>시간 <input type="time" name="time" value="${esc(e?.time ?? '')}" /></label>
            <label>끝 날짜 <input type="date" name="endDate" value="${esc(e?.endDate ?? '')}" /></label>
            <label>끝 시간 <input type="time" name="endTime" value="${esc(e?.endTime ?? '')}" /></label>
            <label class="w2">제목 <input name="title" value="${esc(e?.title ?? '')}" placeholder="예: 유튜브 안될과학" required /></label>
            <label class="w2">단계 <input name="step" value="${esc(e?.step ?? '')}" placeholder="예: NCT DREAM 출연분 공개" /></label>
            <label>종류 <select name="kind">${options(meta.eventKinds, e?.kind ?? '방송')}</select></label>
            <label class="w2">링크 <input name="url" type="url" value="${esc(url)}" placeholder="https://" /></label>
            <label class="w2">메모 (기록용) <input name="note" value="${esc(x?.note ?? '')}" /></label>
          </div>
          <p class="dx-label">멤버 (아무도 안 고르면 단체)</p>
          ${memberChecks(e?.members ?? [])}
          <div class="admin-actions">
            <button type="submit" class="admin-btn is-primary">저장</button>
            ${e ? '<button type="button" class="admin-btn" data-act="hide">이 일정 숨기기</button>' : ''}
            ${x ? '<button type="button" class="admin-btn" data-act="revert">고친 것 되돌리기</button>' : ''}
            <button type="button" class="admin-btn" data-act="close">닫기</button>
          </div>
        </form>`);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const data = { date: val(form, 'date'), time: val(form, 'time'), endDate: val(form, 'endDate'), endTime: val(form, 'endTime'), title: val(form, 'title'), step: val(form, 'step'), kind: val(form, 'kind'), url: val(form, 'url'), members: pickedMembers(form) };
        const ok = e ? await save({ id: x?.id, kind: 'event', op: 'patch', target: x?.target ?? eventTarget(e), data, base: e, note: val(form, 'note') })
          : await save({ kind: 'event', op: 'add', target: {}, data, note: val(form, 'note') }, '일정을 만들었어요');
        if (ok) { closeForm(); renderList(); }
      });
      form.querySelector('[data-act="hide"]')?.addEventListener('click', async () => {
        if (await save({ id: x?.op === 'hide' ? x.id : undefined, kind: 'event', op: 'hide', target: x?.target ?? eventTarget(e!), note: val(form, 'note') }, '숨겼어요')) { closeForm(); renderList(); }
      });
      form.querySelector('[data-act="revert"]')?.addEventListener('click', async () => { if (await revert(x!.id)) { closeForm(); renderList(); } });
      form.querySelector('[data-act="close"]')!.addEventListener('click', closeForm);
      formBox().replaceChildren(form);
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ── 소식 ──
  async function feedView() {
    const data = await raw('feed.json');
    const all = () => applyFeed((data?.items ?? []) as Feed[], doc.items);
    const editOf = (f: Feed) => doc.items.find((x) => x.kind === 'feed' && ((x.data?.url && normUrl(x.data.url) === normUrl(f.url)) || (x.target.url && normUrl(x.target.url) === normUrl(f.url))));
    const listBox = el('<div class="admin-list"></div>');
    body.replaceChildren(toolbar('제목·매체로 찾기', '새 소식'), el('<div id="dx-form"></div>'), listBox);
    body.querySelector('[data-new]')!.addEventListener('click', () => feedForm());
    renderList = () => {
      const q = query.toLowerCase();
      const list = all().filter((f) => !q || `${f.title} ${f.publisher ?? ''} ${f.url}`.toLowerCase().includes(q)).slice(0, 80);
      listBox.replaceChildren(...(list.length ? list.map((f) => {
        const row = el(`<button type="button" class="card dx-row"><span class="dx-when">${esc(kstLabel(f.publishedAt))}</span><span class="dx-what"><strong>${esc(f.title)}</strong></span><span class="dx-meta">${esc(f.publisher ?? f.type)} ${tag(editOf(f))}</span></button>`);
        row.addEventListener('click', () => feedForm(f));
        return row;
      }) : [el('<div class="card admin-empty">찾는 소식이 없어요.</div>')]));
    };
    renderList();

    function feedForm(f?: Feed) {
      const x = f && editOf(f);
      const form = el(`
        <form class="card dx-form">
          <h3>${f ? '소식 고치기' : '새 소식'} ${tag(x)}</h3>
          <div class="dx-fields">
            <label class="w2">제목 <input name="title" value="${esc(f?.title ?? '')}" required /></label>
            <label class="w2">링크 <input name="url" type="url" value="${esc(f?.url ?? '')}" placeholder="https://" required /></label>
            <label>매체·채널 <input name="publisher" value="${esc(f?.publisher ?? '')}" /></label>
            <label>올라온 시각 <input type="datetime-local" name="publishedAt" value="${esc(f ? kstInput(f.publishedAt) : kstInput(new Date().toISOString()))}" /></label>
            <label>종류 <select name="type">${meta.feedTypes.map((t) => `<option value="${t}" ${t === (f?.type ?? 'news') ? 'selected' : ''}>${({ news: '기사', youtube: '영상', sns: 'SNS', 'weverse-notice': '위버스 공지' } as Record<string, string>)[t] ?? t}</option>`).join('')}</select></label>
            <label class="w2">사진 주소 (선택) <input name="image" type="url" value="${esc(f?.image ?? '')}" /></label>
            <label class="w2">메모 (기록용) <input name="note" value="${esc(x?.note ?? '')}" /></label>
          </div>
          <p class="dx-label">멤버</p>
          ${memberChecks(f?.members ?? [])}
          <div class="admin-actions">
            <button type="submit" class="admin-btn is-primary">저장</button>
            ${f ? '<button type="button" class="admin-btn" data-act="hide">이 소식 숨기기</button>' : ''}
            ${x ? '<button type="button" class="admin-btn" data-act="revert">고친 것 되돌리기</button>' : ''}
            <button type="button" class="admin-btn" data-act="close">닫기</button>
          </div>
        </form>`);
      const target = { url: x?.target.url ?? f?.url };
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const at = val(form, 'publishedAt');
        const data = { title: val(form, 'title'), url: val(form, 'url'), publisher: val(form, 'publisher'), publishedAt: at ? `${at}:00+09:00` : '', type: val(form, 'type'), image: val(form, 'image'), members: pickedMembers(form) };
        const ok = f ? await save({ id: x?.id, kind: 'feed', op: 'patch', target, data, base: f, note: val(form, 'note') })
          : await save({ kind: 'feed', op: 'add', target: {}, data, note: val(form, 'note') }, '소식을 만들었어요');
        if (ok) { closeForm(); renderList(); }
      });
      form.querySelector('[data-act="hide"]')?.addEventListener('click', async () => { if (await save({ kind: 'feed', op: 'hide', target, note: val(form, 'note') }, '숨겼어요')) { closeForm(); renderList(); } });
      form.querySelector('[data-act="revert"]')?.addEventListener('click', async () => { if (await revert(x!.id)) { closeForm(); renderList(); } });
      form.querySelector('[data-act="close"]')!.addEventListener('click', closeForm);
      formBox().replaceChildren(form);
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ── 시리즈·아카이브 공통: 영상 빼기·되살리기·넣기 ──
  type VideoRow = { key: string; title: string; date: string; url?: string; group: string };
  function videoTools(opts: {
    rows: VideoRow[]; removed: VideoRow[]; added: AddedVideo[]; withTarget?: boolean;
    onRemove: (key: string) => void; onRestore: (key: string) => void; onAdd: (v: AddedVideo) => void; onUnadd: (key: string) => void;
  }) {
    const box = el('<div class="dx-videos"></div>');
    const addedKeys = new Set(opts.added.map((v) => v.id));
    const groups = new Map<string, VideoRow[]>();
    for (const r of opts.rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
    for (const [g, list] of groups) {
      const sec = el(`<details class="dx-vgroup" ${groups.size <= 3 ? 'open' : ''}><summary>${esc(g)} <span class="admin-status">${list.length}</span></summary><ul></ul></details>`);
      const ul = sec.querySelector('ul')!;
      for (const r of list) {
        const li = el(`<li><span class="dx-when">${esc(r.date)}</span> ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)} <button type="button" class="admin-btn ed-mini">${addedKeys.has(r.key) ? '넣은 것 취소' : '빼기'}</button></li>`);
        li.querySelector('button')!.addEventListener('click', () => (addedKeys.has(r.key) ? opts.onUnadd(r.key) : opts.onRemove(r.key)));
        ul.append(li);
      }
      box.append(sec);
    }
    if (!opts.rows.length) box.append(el('<p class="admin-hint">영상이 없어요.</p>'));
    if (opts.removed.length) {
      const sec = el(`<details class="dx-vgroup" open><summary>뺀 영상 <span class="admin-status">${opts.removed.length}</span></summary><ul></ul></details>`);
      for (const r of opts.removed) {
        const li = el(`<li class="is-off"><span class="dx-when">${esc(r.date)}</span> ${esc(r.title)} <button type="button" class="admin-btn ed-mini">되살리기</button></li>`);
        li.querySelector('button')!.addEventListener('click', () => opts.onRestore(r.key));
        sec.querySelector('ul')!.append(li);
      }
      box.append(sec);
    }
    const add = el(`
      <div class="dx-add">
        <p class="dx-label">영상 넣기 (유튜브 주소면 제목을 자동으로 가져와요)</p>
        <div class="dx-fields">
          <label class="w2">주소 <input name="addUrl" type="url" placeholder="https://youtu.be/…" /></label>
          <label>제목 (비우면 자동) <input name="addTitle" /></label>
          <label>날짜 <input type="date" name="addDate" value="${today()}" /></label>
          ${opts.withTarget ? `<label>넣을 곳 <select name="addTo"><option value="related">관련 영상</option><option value="own">자체 콘텐츠</option><option value="official">공식 영상</option></select></label><label>묶음 이름 (선택) <input name="addGroup" placeholder="추가한 영상" /></label>` : ''}
        </div>
        ${memberChecks([])}
        <button type="button" class="admin-btn is-accent">넣기</button>
      </div>`);
    add.querySelector('button.is-accent')!.addEventListener('click', async () => {
      const u = val(add, 'addUrl');
      if (!u) return say('주소를 넣어 주세요');
      let title = val(add, 'addTitle');
      let url = u;
      let thumb = '';
      say('영상 정보를 가져오는 중…');
      try {
        const d = await api<{ title: string; url: string; thumb: string }>(`/api/admin/oembed?url=${encodeURIComponent(u)}`);
        title ||= d.title;
        url = d.url;
        thumb = d.thumb;
      } catch (err) {
        if (!title) return say((err as Error).message);
      }
      opts.onAdd({ id: linkKey(url), title, url, thumb, date: val(add, 'addDate') || today(), members: pickedMembers(add), ...(opts.withTarget ? { to: val(add, 'addTo') as AddedVideo['to'], group: val(add, 'addGroup') || undefined } : {}) });
    });
    box.append(add);
    return box;
  }

  // ── 시리즈 ──
  async function seriesView() {
    const data = await raw('series.json');
    const all = () => applySeriesList((data?.series ?? []) as { id: string; name: string; type: string; count: number; from: string; to: string; members: string[] }[], doc.items);
    const editOf = (id: string) => doc.items.find((x) => x.kind === 'series' && (x.target.id === id || x.data?.id === id));
    const listBox = el('<div class="admin-list"></div>');
    body.replaceChildren(toolbar('시리즈 이름·종류로 찾기', '새 시리즈'), el('<div id="dx-form"></div>'), listBox);
    body.querySelector('[data-new]')!.addEventListener('click', () => newSeries());
    renderList = () => {
      const q = query.toLowerCase();
      const list = all().filter((s) => !q || `${s.name} ${s.type} ${s.id}`.toLowerCase().includes(q)).sort((a, b) => a.type.localeCompare(b.type) || b.to.localeCompare(a.to)).slice(0, 120);
      listBox.replaceChildren(...list.map((s) => {
        const row = el(`<button type="button" class="card dx-row"><span class="dx-when">${esc(s.type)}</span><span class="dx-what"><strong>${esc(s.name)}</strong></span><span class="dx-meta">${s.count}개 · ${esc(s.to.slice(0, 7))} ${tag(editOf(s.id))}</span></button>`);
        row.addEventListener('click', () => seriesForm(s.id));
        return row;
      }));
    };
    renderList();

    function newSeries() {
      const form = el(`
        <form class="card dx-form">
          <h3>새 시리즈</h3>
          <div class="dx-fields">
            <label class="w2">이름 <input name="name" required placeholder="예: 안될과학 궤과속" /></label>
            <label>종류 <select name="type">${options(meta.seriesTypes, '외부활동')}</select></label>
          </div>
          <div class="admin-actions"><button type="submit" class="admin-btn is-primary">만들기</button><button type="button" class="admin-btn" data-act="close">닫기</button></div>
        </form>`);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (await save({ kind: 'series', op: 'add', target: {}, data: { name: val(form, 'name'), type: val(form, 'type'), addVideos: [] } }, '시리즈를 만들었어요')) {
          const made = doc.items.at(-1);
          renderList();
          if (made?.data?.id) seriesForm(made.data.id);
        }
      });
      form.querySelector('[data-act="close"]')!.addEventListener('click', closeForm);
      formBox().replaceChildren(form);
    }

    async function seriesForm(id: string) {
      const original = await raw(`series/${id}.json`);
      const x = editOf(id);
      const page = applySeriesPage(original, id, doc.items);
      if (!page) { say('이 시리즈는 숨겨져 있어요. "고친 목록"에서 되돌릴 수 있어요'); return; }
      const d = { ...(x?.data ?? {}) } as { name?: string; type?: string; removeVideos?: string[]; addVideos?: AddedVideo[] };
      const made = x?.op === 'add';
      const rowsOf = (p: any): VideoRow[] => [
        ...(p?.seasons ?? []).flatMap((s: any) => s.videos.map((v: any) => ({ key: linkKey(v.url) || v.id, title: v.title, date: v.date, url: v.url, group: s.name }))),
        ...(p?.episodes ?? []).map((e: any) => ({ key: e.url ? linkKey(e.url) : e.title, title: e.title, date: e.date, url: e.url, group: '회차' })),
      ];
      const removedKeys = new Set(d.removeVideos ?? []);
      const removed = rowsOf(original).filter((r) => removedKeys.has(r.key));
      const form = el(`
        <form class="card dx-form">
          <h3>${esc(page.name)} ${tag(x)}</h3>
          ${page.activities ? '<p class="admin-hint">활동을 묶은 시리즈라 영상은 고칠 수 없어요. 이름·종류·숨기기만 돼요.</p>' : ''}
          <div class="dx-fields">
            <label class="w2">이름 <input name="name" value="${esc(page.name)}" /></label>
            <label>종류 <select name="type">${options(meta.seriesTypes, page.type)}</select></label>
          </div>
          <div class="admin-actions">
            <button type="submit" class="admin-btn is-primary">저장</button>
            <button type="button" class="admin-btn" data-act="hide">${made ? '이 시리즈 지우기' : '이 시리즈 숨기기'}</button>
            ${x && !made ? '<button type="button" class="admin-btn" data-act="revert">고친 것 모두 되돌리기</button>' : ''}
            <a class="admin-btn" href="/series/${encodeURIComponent(id)}/" target="_blank" rel="noopener">사이트에서 보기</a>
            <button type="button" class="admin-btn" data-act="close">닫기</button>
          </div>
        </form>`);
      const commit = (patch: Partial<typeof d>, done: string) => save({ id: x?.id, kind: 'series', op: made ? 'add' : 'patch', target: x?.target ?? { id }, data: { ...d, ...patch, name: patch.name ?? d.name ?? (made ? page.name : undefined), type: patch.type ?? d.type ?? (made ? page.type : undefined) } }, done)
        .then((ok) => { if (ok) { renderList(); seriesForm(id); } });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const name = val(form, 'name');
        const type = val(form, 'type');
        commit({ name: name !== original?.name || made ? name : undefined, type: type !== original?.type || made ? type : undefined }, '저장했어요');
      });
      form.querySelector('[data-act="hide"]')!.addEventListener('click', async () => {
        if (await save({ kind: 'series', op: 'hide', target: { id } }, made ? '지웠어요' : '숨겼어요')) { closeForm(); renderList(); }
      });
      form.querySelector('[data-act="revert"]')?.addEventListener('click', async () => { if (await revert(x!.id)) { renderList(); seriesForm(id); } });
      form.querySelector('[data-act="close"]')!.addEventListener('click', closeForm);
      if (!page.activities) form.append(videoTools({
        rows: rowsOf(page), removed, added: d.addVideos ?? [],
        onRemove: (key) => commit({ removeVideos: [...new Set([...(d.removeVideos ?? []), key])] }, '뺐어요'),
        onRestore: (key) => commit({ removeVideos: (d.removeVideos ?? []).filter((k) => k !== key) }, '되살렸어요'),
        onAdd: (v) => commit({ addVideos: [...(d.addVideos ?? []).filter((a) => a.id !== v.id), v], removeVideos: (d.removeVideos ?? []).filter((k) => k !== v.id) }, '넣었어요'),
        onUnadd: (key) => commit({ addVideos: (d.addVideos ?? []).filter((a) => a.id !== key) }, '넣은 것을 뺐어요'),
      }));
      formBox().replaceChildren(form);
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ── 아카이브(활동) ──
  async function eraView() {
    const data = await raw('eras.json');
    const all = () => applyEraList((data?.eras ?? []) as { id: string; title: string; kind: string; from: string; to: string; subtitle?: string }[], doc.items);
    const editOf = (id: string) => doc.items.find((x) => x.kind === 'era' && x.target.id === id);
    const listBox = el('<div class="admin-list"></div>');
    body.replaceChildren(toolbar('활동 이름으로 찾기'), el('<div id="dx-form"></div>'), listBox);
    renderList = () => {
      const q = query.toLowerCase();
      const list = all().filter((e) => !q || `${e.title} ${e.subtitle ?? ''} ${e.kind} ${e.id}`.toLowerCase().includes(q)).sort((a, b) => b.from.localeCompare(a.from)).slice(0, 120);
      listBox.replaceChildren(...list.map((e) => {
        const row = el(`<button type="button" class="card dx-row"><span class="dx-when">${esc(e.kind)}</span><span class="dx-what"><strong>${esc(e.title)}</strong> ${esc(e.subtitle ?? '')}</span><span class="dx-meta">${esc(e.from)} ~ ${esc(e.to)} ${tag(editOf(e.id))}</span></button>`);
        row.addEventListener('click', () => eraForm(e.id));
        return row;
      }));
    };
    renderList();

    async function eraForm(id: string) {
      const original = await raw(`eras/${id}.json`);
      const x = editOf(id);
      const page: any = applyEraPage(original, doc.items);
      if (!page) { say('이 활동은 숨겨져 있어요. "고친 목록"에서 되돌릴 수 있어요'); return; }
      const d = { ...(x?.data ?? {}) } as { title?: string; subtitle?: string; from?: string; to?: string; removeVideos?: string[]; addVideos?: AddedVideo[] };
      const LABEL: Record<string, string> = { official: '공식 영상', own: '자체 콘텐츠', related: '관련 영상', shorts: '쇼츠', outside: '외부 출연', news: '기사' };
      const rowsOf = (p: any): VideoRow[] => {
        if (!p) return [];
        const one = (v: any, group: string) => ({ key: v.url ? linkKey(v.url) : v.id, title: v.title, date: v.date, url: v.url, group });
        return [
          ...(['official', 'own', 'related', 'shorts', 'outside', 'news'] as const).flatMap((k) => (p[k] ?? []).map((v: any) => one(v, v.group ? `${LABEL[k]} · ${v.group}` : LABEL[k]))),
          ...(p.stages ?? []).flatMap((s: any) => s.videos.map((v: any) => one(v, `무대 · ${s.program}`))),
          ...(p.fancams ?? []).flatMap((s: any) => s.videos.map((v: any) => one(v, `직캠 · ${s.member}`))),
        ];
      };
      const removedKeys = new Set(d.removeVideos ?? []);
      const form = el(`
        <form class="card dx-form">
          <h3>${esc(page.title)} ${tag(x)}</h3>
          <div class="dx-fields">
            <label class="w2">제목 <input name="title" value="${esc(page.title)}" /></label>
            <label class="w2">부제 <input name="subtitle" value="${esc(page.subtitle ?? '')}" /></label>
            <label>시작 <input type="date" name="from" value="${esc(page.from)}" /></label>
            <label>끝 <input type="date" name="to" value="${esc(page.to)}" /></label>
          </div>
          <div class="admin-actions">
            <button type="submit" class="admin-btn is-primary">저장</button>
            <button type="button" class="admin-btn" data-act="hide">이 활동 숨기기</button>
            ${x ? '<button type="button" class="admin-btn" data-act="revert">고친 것 모두 되돌리기</button>' : ''}
            <a class="admin-btn" href="/archive/${encodeURIComponent(id)}/" target="_blank" rel="noopener">사이트에서 보기</a>
            <button type="button" class="admin-btn" data-act="close">닫기</button>
          </div>
        </form>`);
      const commit = (patch: Partial<typeof d>, done: string) => save({ id: x?.id, kind: 'era', op: 'patch', target: { id }, data: { ...d, ...patch } }, done)
        .then((ok) => { if (ok) { renderList(); eraForm(id); } });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const changed = (k: 'title' | 'subtitle' | 'from' | 'to') => (val(form, k) !== (original?.[k] ?? '') ? val(form, k) : undefined);
        commit({ title: changed('title'), subtitle: changed('subtitle'), from: changed('from'), to: changed('to') }, '저장했어요');
      });
      form.querySelector('[data-act="hide"]')!.addEventListener('click', async () => { if (await save({ kind: 'era', op: 'hide', target: { id } }, '숨겼어요')) { closeForm(); renderList(); } });
      form.querySelector('[data-act="revert"]')?.addEventListener('click', async () => { if (await revert(x!.id)) { renderList(); eraForm(id); } });
      form.querySelector('[data-act="close"]')!.addEventListener('click', closeForm);
      form.append(videoTools({
        rows: rowsOf(page), removed: rowsOf(original).filter((r) => removedKeys.has(r.key)), added: d.addVideos ?? [], withTarget: true,
        onRemove: (key) => commit({ removeVideos: [...new Set([...(d.removeVideos ?? []), key])] }, '뺐어요'),
        onRestore: (key) => commit({ removeVideos: (d.removeVideos ?? []).filter((k) => k !== key) }, '되살렸어요'),
        onAdd: (v) => commit({ addVideos: [...(d.addVideos ?? []).filter((a) => a.id !== v.id), v], removeVideos: (d.removeVideos ?? []).filter((k) => k !== v.id) }, '넣었어요'),
        onUnadd: (key) => commit({ addVideos: (d.addVideos ?? []).filter((a) => a.id !== key) }, '넣은 것을 뺐어요'),
      }));
      formBox().replaceChildren(form);
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ── 고친 목록 ──
  function editsView() {
    const KIND: Record<string, string> = { event: '일정', feed: '소식', series: '시리즈', era: '아카이브' };
    const label = (x: Edit) => x.data?.title || x.data?.name || x.target.title || x.target.url || x.target.id || '';
    const list = [...doc.items].sort((a, b) => b.at.localeCompare(a.at));
    body.replaceChildren(el(`<p class="admin-hint">되돌리면 수집기가 만든 원래 데이터로 돌아가요. 수정 ${list.length}개</p>`), ...(list.length ? list.map((x) => {
      const row = el(`
        <article class="card admin-item">
          <div class="admin-item-top"><span class="admin-tag">${KIND[x.kind]}</span>${tag(x)}<span>${esc(kstLabel(x.at))}</span>${x.by ? `<span>${esc(x.by)}</span>` : ''}</div>
          <h3>${esc(label(x))}</h3>
          ${x.note ? `<p class="admin-reason">${esc(x.note)}</p>` : ''}
          <div class="admin-actions"><button type="button" class="admin-btn">되돌리기</button></div>
        </article>`);
      row.querySelector('button')!.addEventListener('click', async () => { if (await revert(x.id)) editsView(); });
      return row;
    }) : [el('<div class="card admin-empty">아직 고친 게 없어요.</div>')]));
  }

  async function render() {
    query = '';
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    body.replaceChildren(el('<div class="card admin-item" aria-hidden="true"><span class="skel-line w60"></span><span class="skel-line w40"></span></div>'));
    if (view === 'event') await eventView();
    else if (view === 'feed') await feedView();
    else if (view === 'series') await seriesView();
    else if (view === 'era') await eraView();
    else editsView();
  }

  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-view]')) b.addEventListener('click', () => { view = b.dataset.view as View; render(); });
  root.querySelector('#dx-reload')?.addEventListener('click', () => { rawCache.clear(); load(); });

  async function load() {
    try {
      const d = await api<EditsDoc & typeof meta>('/api/admin/edits');
      doc = { rev: d.rev, items: d.items };
      meta = { seriesTypes: d.seriesTypes, eventKinds: d.eventKinds, feedTypes: d.feedTypes };
      setCount();
      await render();
    } catch (err) {
      body.replaceChildren(el(`<div class="card admin-empty">${esc((err as Error).message)}</div>`));
    }
  }
  document.addEventListener('admin:tab', (ev) => {
    if ((ev as CustomEvent).detail === 'data' && !started) { started = true; load(); }
  });
  // 숫자만 먼저
  api<EditsDoc>('/api/admin/edits').then((d) => { if (!started) { doc = { rev: d.rev, items: d.items }; setCount(); } }).catch(() => {});
}
