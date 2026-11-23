// 어드민 화면: 제보 승인·거절, 물어보기 👎 확인 (API는 로그인한 운영자만). 응원법 채보는 game/editor.ts
interface Report {
  id: string; type: 'add' | 'delete' | 'fix' | 'news'; title?: string; url: string; message: string; eventId: string; eventTitle: string;
  date: string; time: string; endDate?: string; endTime?: string; reasonCode?: string; members: string[];
  status: 'pending' | 'approved' | 'rejected'; createdAt: string; target?: 'event' | 'news'; newsUrl?: string; reviewedAt?: string; reviewMode?: 'auto' | 'manual'; reviewReason?: string;
}
interface Decision { action: 'approve' | 'reject'; note: string; at: string; by: string }
interface Feedback { id: string; at: string; reason: string; note: string; question: string; answer: string; sources: { id: string; url: string }[]; mark: string | null }
interface Group { qk: string; question: string; items: Feedback[] }

const TYPE: Record<Report['type'], string> = { add: '빠진 일정', fix: '정보 보완', delete: '삭제 요청', news: '소식' };
const STATUS: Record<Report['status'], string> = { pending: '대기', approved: '승인', rejected: '거절' };
const REASON: Record<string, string> = { unrelated: '드림 일정·소식이 아님', duplicate: '중복', cancelled: '취소됨', wrong: '잘못된 정보', rights: '권리자·초상권 요청', privacy: '사생활 침해', other: '기타' };
const MARK: Record<string, string> = { eval: '평가 세트 후보', seen: '확인함' };

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
/** 화면 시각은 KST */
const kst = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString();
  return `${d.slice(5, 7)}.${d.slice(8, 10)} ${d.slice(11, 16)}`;
};
const link = (url: string) => {
  try { return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(url).hostname.replace(/^www\./, ''))}</a>`; } catch { return esc(url); }
};
const $ = (id: string) => document.getElementById(id)!;
const setCount = (k: string, n: number) => { const c = document.querySelector<HTMLElement>(`[data-count="${k}"]`); if (c) c.textContent = n ? String(n) : ''; };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

// ── 탭 ──
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.admin-tabs [role="tab"]')];
const loaded = new Set<string>();
function show(tab: HTMLButtonElement) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    $(t.getAttribute('aria-controls')!).hidden = !on;
  }
  const key = tab.id.replace('tab-', '');
  try { localStorage.setItem('admin.tab', key); } catch { /* 저장 안 돼도 괜찮음 */ }
  if (key === 'feedback' && !loaded.has('feedback')) loadFeedback();
  // 채보 도구(game/editor.ts)는 탭을 처음 열 때 시작
  document.dispatchEvent(new CustomEvent('admin:tab', { detail: key }));
}
tabs.forEach((t) => t.addEventListener('click', () => show(t)));

// ── 제보 ──
function reportRow(r: Report, decision?: Decision) {
  const rows: [string, string][] = [];
  if (r.eventTitle) rows.push(['대상', esc(r.eventTitle)]);
  if (r.date || r.time) rows.push(['날짜·시간', esc(`${r.date} ${r.time}${r.endDate || r.endTime ? ` ~ ${r.endDate ?? ''} ${r.endTime ?? ''}` : ''}`.trim())]);
  if (r.members?.length) rows.push(['멤버', esc(r.members.join('·'))]);
  if (r.reasonCode) rows.push(['이유', esc(REASON[r.reasonCode] ?? r.reasonCode)]);
  if (r.message) rows.push(['내용', esc(r.message)]);
  if (r.url) rows.push(['링크', link(r.url)]);
  if (r.newsUrl) rows.push(['지울 소식', link(r.newsUrl)]);
  const pending = r.status === 'pending';
  const node = el(`
    <article class="card admin-item ${pending ? '' : 'is-done'}">
      <div class="admin-item-top">
        <span class="admin-tag t-${r.type}">${TYPE[r.type] ?? r.type}</span>
        ${pending ? '' : `<span class="admin-tag s-${r.status}">${STATUS[r.status]}${r.reviewMode === 'manual' ? ' · 운영자' : r.reviewMode === 'auto' ? ' · 자동' : ''}</span>`}
        <span>${kst(r.createdAt)} 접수</span>${r.reviewedAt ? `<span>· ${kst(r.reviewedAt)} 처리</span>` : ''}
      </div>
      <h3>${esc(r.title || r.eventTitle || r.message.slice(0, 60) || '(제목 없음)')}</h3>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${r.reviewReason ? `<p class="admin-reason">${pending ? 'AI가 넘긴 이유: ' : ''}${esc(r.reviewReason)}</p>` : ''}
      ${pending ? `
      <div class="admin-actions">
        <input type="text" maxlength="300" placeholder="메모 (선택, 기록용)" aria-label="메모" />
        <button type="button" class="admin-btn is-primary" data-act="approve">승인</button>
        <button type="button" class="admin-btn" data-act="reject">거절</button>
        <button type="button" class="admin-btn" data-act="cancel" hidden>결정 취소</button>
        <span class="admin-status" aria-live="polite"></span>
      </div>` : ''}
    </article>`);
  if (!pending) return node;
  const input = node.querySelector('input')!;
  const status = node.querySelector<HTMLElement>('.admin-status')!;
  const buttons = [...node.querySelectorAll<HTMLButtonElement>('[data-act]')];
  const paint = (d?: Decision) => {
    for (const b of buttons) b.hidden = d ? b.dataset.act !== 'cancel' : b.dataset.act === 'cancel';
    input.hidden = Boolean(d);
    status.textContent = d ? `${d.action === 'approve' ? '승인' : '거절'} 결정 · 다음 수집 때 반영돼요${d.note ? ` · 메모: ${d.note}` : ''}` : '';
  };
  paint(decision);
  for (const b of buttons) b.addEventListener('click', async () => {
    const act = b.dataset.act as 'approve' | 'reject' | 'cancel';
    buttons.forEach((x) => (x.disabled = true));
    status.textContent = '저장하는 중…';
    try {
      const res = await api<{ decision?: Decision }>('/api/admin/reports', { id: r.id, action: act, note: input.value });
      paint(act === 'cancel' ? undefined : res.decision);
    } catch (err) {
      status.textContent = (err as Error).message;
    } finally {
      buttons.forEach((x) => (x.disabled = false));
    }
  });
  return node;
}

async function loadReports() {
  const pendingBox = $('reports-pending');
  const recentBox = $('reports-recent');
  try {
    const d = await api<{ pending: Report[]; recent: Report[]; decisions: Record<string, Decision> }>('/api/admin/reports');
    pendingBox.replaceChildren(...(d.pending.length ? d.pending.map((r) => reportRow(r, d.decisions[r.id])) : [el('<div class="card admin-empty">확인할 제보가 없어요.</div>')]));
    recentBox.replaceChildren(...(d.recent.length ? d.recent.map((r) => reportRow(r)) : [el('<div class="card admin-empty">최근 처리한 제보가 없어요.</div>')]));
    setCount('reports', d.pending.filter((r) => !d.decisions[r.id]).length);
  } catch (err) {
    pendingBox.replaceChildren(el(`<div class="card admin-empty">${esc((err as Error).message)}</div>`));
  }
}

// ── 물어보기 👎 ──
function feedbackGroup(g: Group) {
  const ids = g.items.map((x) => x.id);
  const node = el(`
    <article class="card admin-item">
      <div class="admin-item-top"><span class="admin-tag t-delete">👎 ${g.items.length}</span><span>최근 ${kst(g.items[0].at)}</span><span class="admin-status" aria-live="polite"></span></div>
      <h3>${esc(g.question || '(질문 없음)')}</h3>
      ${g.items.slice(0, 5).map((x) => `
        <div class="admin-fb">
          <div class="admin-item-top"><span>${kst(x.at)}</span>${x.reason ? `<span class="admin-tag">${esc(x.reason)}</span>` : ''}${x.mark ? `<span class="admin-tag s-approved">${MARK[x.mark] ?? x.mark}</span>` : ''}</div>
          ${x.note ? `<p class="admin-reason">의견: ${esc(x.note)}</p>` : ''}
          <div class="admin-answer">${esc(x.answer)}</div>
          ${x.sources.length ? `<div class="admin-srcs">${x.sources.filter((s) => s.url).slice(0, 6).map((s) => link(s.url)).join('')}</div>` : ''}
        </div>`).join('')}
      ${g.items.length > 5 ? `<p class="admin-hint">외 ${g.items.length - 5}개</p>` : ''}
      <div class="admin-actions">
        <button type="button" class="admin-btn is-accent" data-mark="eval">평가 세트 후보로</button>
        <button type="button" class="admin-btn" data-mark="seen">확인함</button>
        <button type="button" class="admin-btn" data-mark="clear">표시 지우기</button>
      </div>
    </article>`);
  const status = node.querySelector<HTMLElement>('.admin-status')!;
  const buttons = [...node.querySelectorAll<HTMLButtonElement>('[data-mark]')];
  for (const b of buttons) b.addEventListener('click', async () => {
    buttons.forEach((x) => (x.disabled = true));
    try {
      await api('/api/admin/feedback', { ids, mark: b.dataset.mark });
      status.textContent = b.dataset.mark === 'clear' ? '표시를 지웠어요' : `${MARK[b.dataset.mark!]}으로 표시했어요`;
      node.classList.toggle('is-done', b.dataset.mark !== 'clear');
    } catch (err) {
      status.textContent = (err as Error).message;
    } finally {
      buttons.forEach((x) => (x.disabled = false));
    }
  });
  if (g.items.every((x) => x.mark)) node.classList.add('is-done');
  return node;
}

async function loadFeedback() {
  loaded.add('feedback');
  const box = $('feedback-list');
  const days = ($('feedback-days') as HTMLSelectElement).value;
  try {
    const d = await api<{ total: number; up: number; down: number; groups: Group[] }>(`/api/admin/feedback?days=${days}`);
    $('feedback-summary').textContent = `최근 ${days}일 평가 ${d.total}개 · 👍 ${d.up} · 👎 ${d.down}${d.total ? ` (만족 ${Math.round((d.up / d.total) * 100)}%)` : ''}`;
    box.replaceChildren(...(d.groups.length ? d.groups.map(feedbackGroup) : [el('<div class="card admin-empty">👎 받은 답이 없어요.</div>')]));
    setCount('feedback', d.groups.filter((g) => !g.items.every((x) => x.mark)).length);
  } catch (err) {
    box.replaceChildren(el(`<div class="card admin-empty">${esc((err as Error).message)}</div>`));
  }
}
$('feedback-days').addEventListener('change', loadFeedback);

loadReports();
let saved: string | null = null;
try { saved = localStorage.getItem('admin.tab'); } catch { /* 없음 */ }
const first = tabs.find((t) => t.id === `tab-${saved}`);
if (first) show(first);
// 첫 화면이 제보가 아니어도 숫자는 보이게
if (!loaded.has('feedback')) loadFeedback();
