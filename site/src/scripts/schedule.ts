/**
 * 일정 페이지: 공식/참여 캘린더 전환, 멤버·유형 필터, 월간 달력(기간 막대), 그날 일정, 다가오는 일정.
 * 데이터는 수집기가 만든 /data/events.json 을 읽는다.
 */
type Cal = '공식' | '참여';
interface Source { type: string; url: string; title: string; publisher?: string }
interface Ev {
  id: string;
  date: string;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
  timezone: string | null;
  kst?: { date: string; time: string };
  title: string;
  step: string;
  kind: string;
  members: string[];
  scope: string;
  status: string;
  evidence: string;
  sources: Source[];
  category: Cal;
  calendars?: Cal[];
  audience: 'all' | 'winners';
}
/** 달력 칸에 놓이는 조각 (여러 날 일정은 날마다 하나씩) */
interface Piece { e: Ev; span: boolean; first: boolean; last: boolean; label: string; time: string | null; gap?: false }
type Slot = Piece | { gap: true };

// 그룹·멤버·음방 줄임말·활동 이름은 /data/site.json 에서 (start()에서 채운다)
let MEMBERS: string[] = [];
let PROGRAMS: [RegExp, string][] = [];
let STRIP_RE = /$^/;
const KINDS = ['방송', '발매', '행사', '녹화', '신청', '당첨 발표', '본인 확인', '판매', '투표', '모임', '기념일', '기타'];
const KIND_LABEL: Record<string, string> = { 행사: '공연·행사', 발매: '공개' };
const PERIOD = ['투표', '판매', '신청'];
const WD = ['일', '월', '화', '수', '목', '금', '토'];

const kindVar = (k: string) => `var(--k-${k.replace(/\s/g, '')})`;
const $ = (id: string) => document.getElementById(id)!;

function h(tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style') el.setAttribute('style', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// 오늘 (한국 시간)
const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
const TODAY = kstNow.toISOString().slice(0, 10);
const NOW_HM = kstNow.toISOString().slice(11, 16);

const state = {
  cal: '공식' as Cal | '전체',
  who: '전체',
  kinds: new Set<string>(),
  winners: false,
  y: Number(TODAY.slice(0, 4)),
  m: Number(TODAY.slice(5, 7)),
  selected: TODAY,
};
let ALL: Ev[] = [];
// 달별 파일: 보는 달 앞뒤만 받는다 (전체 일정 파일은 2MB가 넘어서). 받은 달은 다시 받지 않는다
let MONTHS: Record<string, number> = {};
const LOADED = new Map<string, Ev[]>();
const LOADING = new Map<string, Promise<void>>();
const ymOf = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const around = (y: number, m: number) => [-1, 0, 1, 2].map((d) => { const t = new Date(Date.UTC(y, m - 1 + d, 1)); return ymOf(t.getUTCFullYear(), t.getUTCMonth() + 1); });
function loadMonth(ym: string): Promise<void> {
  if (LOADED.has(ym) || !MONTHS[ym]) return Promise.resolve();
  if (!LOADING.has(ym)) LOADING.set(ym, fetch(`/data/events/${ym}.json`).then((r) => (r.ok ? r.json() : { events: [] })).then((d: { events: Ev[] }) => {
    LOADED.set(ym, d.events);
    const seen = new Map<string, Ev>();
    for (const list of LOADED.values()) for (const e of list) seen.set(e.id, e);
    ALL = [...seen.values()];
  }));
  return LOADING.get(ym)!;
}
/** 보는 달 앞뒤를 받고 다시 그린다 (받는 동안 달력은 스켈레톤) */
async function ensure(y: number, m: number) {
  const need = around(y, m).filter((ym) => MONTHS[ym] && !LOADED.has(ym));
  if (!need.length) return;
  if (!LOADED.has(ymOf(y, m)) && MONTHS[ymOf(y, m)]) $('grid').classList.add('loading');
  await Promise.all(need.map(loadMonth));
  $('grid').classList.remove('loading');
  render();
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const wd = (d: string) => WD[new Date(`${d}T00:00:00Z`).getUTCDay()];
const fmtMD = (d: string) => `${Number(d.slice(5, 7))}. ${Number(d.slice(8, 10))}`;

/** 음악방송 줄임말 (팬들이 쓰는 이름) */
const FLOW_STEP: Record<string, string> = { 신청: '신청', '당첨 발표': '당첨 발표', '본인 확인': '본인 확인', 녹화: '', 모임: '재모임' };

/** 달력 칸·카드용 짧은 이름 */
function shortLabel(e: Ev): string {
  const prog = PROGRAMS.find(([re]) => re.test(e.title))?.[1];
  if (prog && e.kind === '방송') return prog;
  if (prog && /사전\s*녹화|사녹/.test(e.title)) return `${prog} 사녹${FLOW_STEP[e.kind] !== undefined ? (FLOW_STEP[e.kind] ? ` ${FLOW_STEP[e.kind]}` : '') : ` ${e.step}`}`;
  if (prog && e.kind === '투표') return `${prog} ${e.step}`;
  const t = e.title
    .replace(STRIP_RE, '')
    .replace(/발매\s*기념|<[^>]+>/g, '')
    .replace(/^\s*(KBS2?|MBC|SBS|JTBC|ENA|tvN|Mnet|유튜브)\s+/i, '')
    .replace(/[‘’'"\[\]]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!t || e.step.includes(t)) return e.step;
  if (t.includes(e.step)) return t;
  return `${t.length > 16 ? `${t.slice(0, 16)}…` : t} · ${e.step}`;
}
const whoText = (e: Ev) => (e.members.length ? e.members.join('·') : '단체');
const calsOf = (e: Ev): Cal[] => e.calendars ?? [e.category];

function visible(): Ev[] {
  return ALL.filter((e) => {
    if (state.cal !== '전체' && !calsOf(e).includes(state.cal)) return false;
    // 당첨자만 가는 단계는 참여 캘린더에서 따로 켤 때만 (공식 캘린더의 사전녹화 시간은 보인다)
    if (e.audience === 'winners' && !state.winners && !(state.cal === '공식' && e.kind === '녹화')) return false;
    if (state.who !== '전체') {
      if (state.who === '단체' ? e.members.length > 0 : !(e.members.includes(state.who) || e.members.length === 0)) return false;
    }
    if (state.kinds.size && !state.kinds.has(e.kind)) return false;
    return true;
  });
}

// ── 필터 ──────────────────────────────────────────────
function renderFilters() {
  $('who').replaceChildren(
    ...['전체', '단체', ...MEMBERS].map((w) =>
      h('button', { class: 'chip', 'aria-pressed': String(state.who === w), onclick: () => { state.who = w; render(); } }, w),
    ),
  );
  const base = ALL.filter((e) => state.cal === '전체' || calsOf(e).includes(state.cal));
  const counts = new Map<string, number>();
  for (const e of base) if (e.date >= addDays(TODAY, -31)) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const kinds = KINDS.filter((k) => counts.get(k));
  $('kinds').replaceChildren(
    h('button', { class: 'chip', 'aria-pressed': String(state.kinds.size === 0), onclick: () => { state.kinds.clear(); render(); } }, '전체'),
    ...kinds.map((k) =>
      h('button', {
        class: 'chip', 'aria-pressed': String(state.kinds.has(k)),
        onclick: () => { state.kinds.has(k) ? state.kinds.delete(k) : state.kinds.add(k); render(); },
      }, h('span', { class: 'dot', style: `--c:${kindVar(k)}` }), KIND_LABEL[k] ?? k, h('span', { class: 'n' }, counts.get(k))),
    ),
  );
  for (const b of document.querySelectorAll<HTMLButtonElement>('#cal-switch button')) b.setAttribute('aria-pressed', String(b.dataset.cal === state.cal));
  ($('winners-wrap') as HTMLElement).hidden = state.cal === '공식';
}

// ── 다가오는 일정 ──────────────────────────────────────
function renderUpcoming(evs: Ev[]) {
  const next = evs
    .filter((e) => (e.endDate ?? e.date) > TODAY || ((e.endDate ?? e.date) === TODAY && (!e.time || e.time >= NOW_HM)))
    .filter((e) => e.date >= TODAY || (e.endDate && PERIOD.includes(e.kind)))
    .sort((a, b) => `${a.date} ${a.time ?? '99'}`.localeCompare(`${b.date} ${b.time ?? '99'}`))
    .slice(0, 5);
  $('upcoming-note').textContent = '오늘부터';
  $('upcoming').replaceChildren(
    ...(next.length
      ? next.map((e) => {
          const ongoing = e.date < TODAY;
          const d = ongoing ? e.endDate! : e.date;
          const pub = e.sources[0]?.publisher ?? (e.sources[0]?.type === 'weverse-notice' ? '위버스' : '');
          return h('button', { class: 'up-card', onclick: () => select(d) },
            h('div', { class: 'up-top' },
              h('span', { class: 'up-day' }, Number(d.slice(8, 10)), h('small', {}, `${wd(d)}${d.slice(5, 7) !== TODAY.slice(5, 7) ? ` · ${Number(d.slice(5, 7))}월` : ''}`)),
              h('span', { class: 'up-time' }, ongoing ? `${e.endTime ?? ''} 마감` : e.time ?? '')),
            h('span', { class: 'up-kind' }, h('span', { class: 'dot', style: `--c:${kindVar(e.kind)}` }), KIND_LABEL[e.kind] ?? e.kind),
            h('span', { class: 'up-title' }, shortLabel(e)),
            h('span', { class: 'up-foot' }, h('span', {}, whoText(e)), h('span', {}, pub)));
        })
      : [h('p', { class: 'up-empty' }, '다가오는 일정이 없어요.')]),
  );
}

// ── 달력 ──────────────────────────────────────────────
function piecesByDate(evs: Ev[]): Map<string, Piece[]> {
  const map = new Map<string, Piece[]>();
  const put = (d: string, p: Piece) => (map.get(d) ?? map.set(d, []).get(d)!).push(p);
  for (const e of evs) {
    if (e.endDate && e.endDate !== e.date) {
      const period = PERIOD.includes(e.kind);
      let d = e.date;
      for (let i = 0; i < 120; i++) {
        const first = d === e.date;
        const last = d === e.endDate;
        put(d, {
          e, span: true, first, last,
          time: first ? e.time : last && period ? e.endTime : null,
          label: first ? (period ? `${shortLabel(e)} 시작` : shortLabel(e)) : last && period ? `${shortLabel(e)} 마감` : shortLabel(e),
        });
        if (last) break;
        d = addDays(d, 1);
      }
    } else put(e.date, { e, span: false, first: true, last: true, time: e.time, label: shortLabel(e) });
  }
  for (const list of map.values()) list.sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'));
  return map;
}

function renderCalendar(evs: Ev[]) {
  const { y, m } = state;
  $('month-title').textContent = `${y}년 ${m}월`;
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = addDays(first.toISOString().slice(0, 10), -first.getUTCDay());
  const weeks = addDays(start, 35).slice(5, 7) === String(m).padStart(2, '0') ? 6 : 5;
  const byDate = piecesByDate(evs);

  // 주마다 기간 막대 줄 맞추기: 같은 일정은 그 주 안에서 같은 높이
  const laid = new Map<string, Slot[]>();
  for (let w = 0; w < weeks; w++) {
    const days = Array.from({ length: 7 }, (_, k) => addDays(start, w * 7 + k));
    const spans = new Map<string, { from: number; to: number }>();
    days.forEach((d, k) => (byDate.get(d) ?? []).filter((p) => p.span).forEach((p) => {
      const r = spans.get(p.e.id) ?? { from: k, to: k };
      r.to = k;
      spans.set(p.e.id, r);
    }));
    const lanes: { from: number; to: number }[][] = [];
    const laneOf = new Map<string, number>();
    [...spans.entries()].sort((a, b) => a[1].from - b[1].from || b[1].to - b[1].from - (a[1].to - a[1].from)).forEach(([id, r]) => {
      let lane = 0;
      while ((lanes[lane] ?? []).some((x) => !(r.to < x.from || r.from > x.to))) lane++;
      (lanes[lane] ??= []).push(r);
      laneOf.set(id, lane);
    });
    for (const d of days) {
      const list = byDate.get(d) ?? [];
      const row: Slot[] = [];
      for (const p of list.filter((x) => x.span)) row[laneOf.get(p.e.id)!] = p;
      for (let i = 0; i < row.length; i++) row[i] ??= { gap: true };
      laid.set(d, [...row, ...list.filter((x) => !x.span)]);
    }
  }

  const cells: HTMLElement[] = WD.map((w, i) => h('div', { class: `wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}` }, w));
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const slots = laid.get(d) ?? [];
    const real = slots.filter((s): s is Piece => !('gap' in s && s.gap));
    const shown = slots.slice(0, 4);
    const hidden = real.length - shown.filter((s) => !('gap' in s && s.gap)).length;
    const dow = i % 7;
    const cls = ['day', dow === 0 && 'sun', dow === 6 && 'sat', d.slice(5, 7) !== String(m).padStart(2, '0') && 'other', d === TODAY && 'today', d === state.selected && 'selected'].filter(Boolean).join(' ');
    cells.push(h('button', { class: cls, onclick: () => select(d), 'aria-label': `${fmtMD(d)} 일정 ${real.length}개` },
      h('span', { class: 'num' }, h('span', {}, Number(d.slice(8, 10)))),
      shown.map((s) => {
        if ('gap' in s && s.gap) return h('div', { class: 'ev gap', 'aria-hidden': 'true' }, ' ');
        const p = s as Piece;
        const showText = !p.span || p.first || p.last || dow === 0;
        const cls2 = ['ev', p.span && 'span', p.span && p.first && 'first', p.span && p.last && 'last', p.e.kind === '녹화' && state.cal === '공식' && 'rec'].filter(Boolean).join(' ');
        return h('div', { class: cls2, style: `--c:${kindVar(p.e.kind)}`, title: `${p.time ?? ''} ${p.e.title} · ${p.e.step}`.trim() },
          showText ? `${p.time && !p.span ? `${p.time} ` : ''}${p.label}` : ' ');
      }),
      hidden > 0 ? h('span', { class: 'more' }, `+${hidden}개`) : null,
    ));
  }
  $('grid').replaceChildren(...cells);

  const used = new Set(evs.filter((e) => e.date.slice(0, 7) === `${y}-${String(m).padStart(2, '0')}`).map((e) => e.kind));
  $('legend').replaceChildren(...KINDS.filter((k) => used.has(k)).map((k) => h('span', {}, h('span', { class: 'dot', style: `--c:${kindVar(k)}` }), KIND_LABEL[k] ?? k)));
}

// ── 그날 일정 ─────────────────────────────────────────
function sourceLinks(e: Ev) {
  const label = (s: Source) =>
    s.type === 'weverse-notice' ? '위버스 공지' : s.type === 'youtube' ? `▶ ${s.publisher ?? '유튜브'}` : s.publisher ?? (s.type === 'news' ? '기사' : '출처');
  const seen = new Set<string>();
  const list = e.sources.filter((s) => (seen.has(label(s)) ? false : (seen.add(label(s)), true))).slice(0, 4);
  return h('div', { class: 'src' }, list.map((s) => (s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener' }, `${label(s)} ↗`) : h('span', {}, label(s)))),
    e.sources.length > list.length ? h('span', { class: 'badge' }, `출처 ${e.sources.length}`) : null);
}

function itemRow(e: Ev, day: string) {
  const multi = e.endDate && e.endDate !== e.date;
  const isNow = day === TODAY && e.time && e.time <= NOW_HM && (!e.endTime || e.endTime >= NOW_HM) && !multi;
  const t = multi
    ? h('div', { class: 't' }, '기간', h('small', {}, `${fmtMD(e.date)} – ${fmtMD(e.endDate!)}`))
    : h('div', { class: 't' }, e.time ? `${e.time}${e.endTime ? '–' : ''}` : '시간 미정', e.endTime ? h('small', {}, e.endTime) : null);
  const same = e.step.includes(e.title);
  return h('div', { class: `item${isNow ? ' now' : ''}` }, t,
    h('div', {},
      h('div', { class: 'meta' }, h('span', { class: 'dot', style: `--c:${kindVar(e.kind)}` }), `${KIND_LABEL[e.kind] ?? e.kind} · ${whoText(e)}`,
        e.kind === '녹화' ? h('span', { class: 'badge' }, '사전녹화 · 당첨자 입장') : null,
        e.audience === 'winners' && e.kind !== '녹화' ? h('span', { class: 'badge' }, '당첨자') : null,
        e.timezone ? h('span', { class: 'badge' }, e.kst ? `현지 ${e.timezone} · 한국 ${e.kst.date !== e.date ? `${fmtMD(e.kst.date)} ` : ''}${e.kst.time}` : `현지 시간 ${e.timezone}`) : null,
        e.status === 'needs-check' ? h('span', { class: 'badge warn' }, '확인 중') : null),
      h('div', { class: 'ttl' }, same ? e.step : e.title, same ? null : h('em', {}, ` · ${e.step}`)),
      h('div', { class: 'desc' }, e.evidence),
      sourceLinks(e),
      h('div', { class: 'report-links' },
        h('a', { href: `/report/?type=fix&event=${encodeURIComponent(e.id)}&title=${encodeURIComponent(`${fmtMD(e.date)} ${shortLabel(e)}`)}` }, '정보 보완'),
        h('a', { href: `/report/?type=delete&event=${encodeURIComponent(e.id)}&title=${encodeURIComponent(`${fmtMD(e.date)} ${shortLabel(e)}`)}` }, '삭제 요청'))));
}

function renderPanel(evs: Ev[]) {
  const d = state.selected;
  const onDay = evs.filter((e) => e.date === d || (e.endDate && e.date <= d && d <= e.endDate))
    .sort((a, b) => Number(Boolean(a.endDate && a.endDate !== a.date)) - Number(Boolean(b.endDate && b.endDate !== b.date)) || (a.time ?? '99').localeCompare(b.time ?? '99'));
  const later = evs.filter((e) => e.date > d).sort((a, b) => `${a.date} ${a.time ?? '99'}`.localeCompare(`${b.date} ${b.time ?? '99'}`)).slice(0, 6);
  $('panel').replaceChildren(
    h('div', { class: 'panel-head' }, h('h3', {}, `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 ${wd(d)}요일`), d === TODAY ? h('span', { class: 'today-badge' }, '오늘') : null),
    ...(onDay.length ? onDay.map((e) => itemRow(e, d)) : [h('p', { class: 'empty' }, '이날은 일정이 없어요.')]),
    h('a', { class: 'add-report', href: `/report/?type=add&date=${d}` }, '+ 빠진 일정 알려주기'),
    later.length ? h('div', { class: 'panel-sub' }, '이후 일정') : null,
    ...later.map((e) => {
      const row = itemRow(e, e.date);
      row.querySelector('.t')!.replaceChildren(`${fmtMD(e.date)} ${wd(e.date)}`, h('small', {}, e.time ?? ''));
      return row;
    }),
  );
}

function select(d: string) {
  state.selected = d;
  state.y = Number(d.slice(0, 4));
  state.m = Number(d.slice(5, 7));
  render();
  void ensure(state.y, state.m);
  if (window.innerWidth <= 1000) $('panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render() {
  renderFilters();
  const evs = visible();
  renderUpcoming(evs);
  renderCalendar(evs);
  renderPanel(evs);
}

export async function start() {
  // 아카이브 공백기 카드에서 넘어오면 (?month=2026-05) 그 달을 보여 준다
  const want = new URLSearchParams(location.search).get('month');
  if (want && /^\d{4}-\d{2}$/.test(want)) { state.y = Number(want.slice(0, 4)); state.m = Number(want.slice(5, 7)); state.selected = `${want}-01`; }
  const [monthsRes, siteRes] = await Promise.all([fetch('/data/events/months.json'), fetch('/data/site.json')]);
  MONTHS = monthsRes.ok ? ((await monthsRes.json()) as { months: Record<string, number> }).months : {};
  // 달별 파일이 없으면(예전 데이터) 전체 파일로
  if (!Object.keys(MONTHS).length) ALL = ((await (await fetch('/data/events.json')).json()) as { events: Ev[] }).events;
  else await Promise.all(around(state.y, state.m).map(loadMonth));
  const cfg = (await siteRes.json()) as { group: { nameVariants: string[] }; members: { name: string }[]; programs: { names: string[]; short: string }[]; eras: { title: string }[] };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  MEMBERS = cfg.members.map((m) => m.name);
  PROGRAMS = cfg.programs.map((p) => [new RegExp(p.names.map(esc).join('|'), 'i'), p.short]);
  // 달력 칸에서는 그룹 이름과 활동(앨범) 이름을 떼서 짧게
  STRIP_RE = new RegExp([...cfg.group.nameVariants, ...cfg.eras.map((e) => e.title)].map((n) => `[‘’'"]?${esc(n)}[‘’'"]?`).join('|'), 'gi');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#cal-switch button')) {
    b.addEventListener('click', () => { state.cal = b.dataset.cal as Cal | '전체'; render(); });
  }
  const shift = (n: number) => {
    let { y, m } = state;
    m += n;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.y = y;
    state.m = m;
    render();
    void ensure(y, m);
  };
  $('prev').addEventListener('click', () => shift(-1));
  $('next').addEventListener('click', () => shift(1));
  $('today').addEventListener('click', () => select(TODAY));
  $('winners').addEventListener('change', (ev) => { state.winners = (ev.target as HTMLInputElement).checked; render(); });
  render();
}
