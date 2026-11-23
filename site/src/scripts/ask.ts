// 물어보기 화면: 질문 보내기, 답 카드(핵심 일정 표·확인 대기·근거·캘린더·이어서 질문), 최근 질문, 오늘 기준 데이터
interface Source { id: string; ids?: string[]; title: string; url: string; kind?: string; date?: string }
interface CitedEvent { id: string; date: string; time: string | null; endDate: string | null; endTime: string | null; title: string; step: string; kind: string; status: string; fromSubmission: boolean; url: string; flowId?: string }
interface Answer {
  ok: boolean; id?: string; answer?: string; sources?: Source[]; unverified?: string[]; dataAt?: string | null; error?: string;
  events?: CitedEvent[]; notFound?: boolean; category?: string; askedCount?: number; cached?: boolean; cachedAt?: string; warn?: boolean;
}
interface Stats { collectedAt: string; notices: number; articles: number; videos: number; events: number; review: number; submissions: number }
interface Recent { qk: string | null; q: string; a: string; at: string; category: string; sources: Source[]; count: number; ups: number; downs: number; state: 'ai' | 'check' | 'expired' | 'notfound'; warn: boolean }

const REASONS = ['틀린 정보', '날짜·시간 오류', '자료에 있는데 모른대요', '출처가 엉뚱해요', '답이 너무 길어요', '기타'];
// 이어서 물어볼 질문 (카테고리별, AI 없이)
const FOLLOW: Record<string, string[]> = {
  '사녹·방송': ['사녹 갈 때 준비물은?', '당첨 발표는 어디서 봐?', '이번주 방송 시간 알려줘'],
  '예매·응모': ['응모 마감 언제야?', '당첨 발표 언제야?', '예매 방법 알려줘'],
  '앨범·MD': ['특전 어디서 받아?', '판매처 어디야?', '판매 마감 언제야?'],
  소식: ['최근 출국 소식 있어?', '이번주 일정 뭐 있어?'],
  '오늘·이번주': ['내일은 뭐 있어?', '다음주 일정 알려줘', '이번주 마감인 거 알려줘'],
  기타: ['이번주 일정 뭐 있어?', '다음주 일정 알려줘'],
};
const CAT_CLS: Record<string, string> = { '오늘·이번주': 'c-week', '사녹·방송': 'c-show', '예매·응모': 'c-ticket', '앨범·MD': 'c-album', 소식: 'c-news', 기타: 'c-etc' };
const KIND_LABEL: Record<string, string> = { notice: '공지', article: '기사', video: '영상', event: '일정', submission: '제보', list: '목록' };

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const today = () => kstNow().toISOString().slice(0, 10);
const md = (d: string) => `${d.slice(5, 7)}.${d.slice(8, 10)}`;
const WD = '일월화수목금토';
const wd = (d: string) => WD[new Date(`${d}T00:00:00Z`).getUTCDay()];
const when = (iso: string) => { const d = new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString(); const day = d.slice(0, 10); return day === today() ? `오늘 ${d.slice(11, 16)}` : `${md(day)} ${d.slice(11, 16)}`; };
const dday = (d: string) => Math.round((Date.parse(d) - Date.parse(today())) / 864e5);
const stripCites = (t: string) => t.replace(/\s*\[[EDL]\d+\]/g, '');

const log = document.querySelector<HTMLElement>('[data-log]')!;
const convo = document.querySelector<HTMLElement>('[data-convo]')!;
const sticky = document.querySelector<HTMLElement>('[data-sticky]')!;
const publicBox = document.querySelector<HTMLInputElement>('[data-public]')!;
let stats: Stats | null = null;
/** 이어지는 질문을 이해하도록 최근 대화 2개를 함께 보낸다 */
const history: { q: string; a: string }[] = [];

// 공개 스위치
const syncPublic = () => {
  const on = publicBox.checked;
  document.querySelector('[data-public-title]')!.textContent = on ? "이 질문은 '최근 질문'에 공개돼요" : '이 질문은 공개하지 않아요';
  document.querySelector('[data-public-label]')!.textContent = on ? '공개' : '비공개';
  document.querySelector('[data-public-mini]')!.textContent = on ? '🔒 이 질문은 최근 질문에 공개돼요' : '🔒 이 질문은 공개하지 않아요';
};
publicBox.addEventListener('change', syncPublic);

/** 답 본문: [E1]·[D2] 표시를 근거 번호 칩으로, 날짜는 강조 */
function renderAnswer(text: string, sources: Source[]) {
  const num = new Map(sources.flatMap((s, i) => (s.ids ?? [s.id]).map((id) => [id, i + 1] as const)));
  const html = esc(text).replace(/(\s*\[([EDL]\d+)\])+/g, (run) => {
    const nums = [...new Set([...run.matchAll(/\[([EDL]\d+)\]/g)].map((m) => num.get(m[1])).filter(Boolean))];
    return nums.map((n) => `<span class="cite">${n}</span>`).join('');
  });
  return html.replace(/(\d{4}-\d{2}-\d{2}(\([월화수목금토일][^)]*\))?(\s*\d{1,2}:\d{2}(AM|PM)?)?|\d{1,2}월\s*\d{1,2}일(\s*\([월화수목금토일]\))?(\s*\d{1,2}:\d{2})?)/g, '<mark>$1</mark>');
}

/** 핵심 일정 표: 답이 근거로 단 일정에서 (AI가 만든 게 아니라 데이터 그대로) */
function factsTable(events: CitedEvent[]) {
  if (!events.length) return '';
  const rows = events.slice(0, 6).map((e) => {
    const end = e.endDate && e.endDate !== e.date ? ` – ${md(e.endDate)}(${wd(e.endDate)})${e.endTime ? ` ${e.endTime}` : ''}` : '';
    const n = dday(e.endDate ?? e.date);
    const badge = n < 0 ? '<span class="dd past">지남</span>' : n === 0 ? '<span class="dd today">오늘</span>' : `<span class="dd">D-${n}</span>`;
    const label = e.step.includes(e.title) ? e.kind : e.step;
    return `<div class="fr"><span class="fk">${esc(label.slice(0, 18))}</span><span class="fv"><b>${md(e.date)}(${wd(e.date)})${e.time ? ` ${e.time}` : ''}</b>${end} · ${esc(e.title.slice(0, 40))} ${badge}</span></div>`;
  });
  return `<div class="facts">${rows.join('')}</div>`;
}

function sourceCards(sources: Source[], dataAt?: string | null) {
  if (!sources.length) return '';
  return `<div class="src-head"><span>근거 ${sources.length}건</span>${dataAt ? `<span>${esc(when(dataAt))} 기준</span>` : ''}</div>
    <div class="src-grid">${sources.map((s, i) => `<a class="src ${s.kind === 'submission' ? 'sub' : ''}" href="${esc(s.url)}" target="_blank" rel="noopener">
      <span class="src-top"><i>${i + 1}</i><em>${KIND_LABEL[s.kind ?? ''] ?? (/weverse/.test(s.url) ? '공지' : /youtu/.test(s.url) ? '영상' : '기사')}</em></span>
      <b>${esc(s.title.slice(0, 60))}</b>${s.date ? `<small>${s.date.replaceAll('-', '.')}</small>` : ''}<span class="src-link">원문 보기 ↗</span></a>`).join('')}</div>`;
}

function feedbackBox(q: string, r: Answer) {
  const box = el(`<span class="fb"><small>도움이 됐나요?</small><button type="button" class="fb-btn" data-r="up" aria-label="도움이 됐어요">👍</button><button type="button" class="fb-btn" data-r="down" aria-label="별로예요">👎</button></span>`);
  const post = async (rating: 'up' | 'down', reason = '', note = '') => {
    const res = await fetch('/api/ask-feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: r.id, rating, reason, note, question: q, answer: r.answer, sources: r.sources }) }).catch(() => null);
    const ok = res?.ok ? ((await res.json()) as { ok: boolean }).ok : false;
    box.innerHTML = `<small class="fb-done">${ok ? '고마워요! 답 품질을 고치는 데 쓸게요.' : '평가를 저장하지 못했어요.'}</small>`;
  };
  box.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('.fb-btn');
    if (!b) return;
    if (b.dataset.r === 'up') return void post('up');
    box.innerHTML = `<span class="fb-why"><small>무엇이 아쉬웠나요?</small><span class="fb-reasons">${REASONS.map((x) => `<button type="button" class="chip-btn" data-reason="${x}">${x}</button>`).join('')}</span><input class="fb-note" maxlength="300" placeholder="(선택) 맞는 정보나 링크를 알려 주세요" /><button type="button" class="fb-send">보내기</button></span>`;
    let reason = '';
    box.querySelectorAll<HTMLButtonElement>('[data-reason]').forEach((c) => c.addEventListener('click', () => {
      reason = c.dataset.reason!;
      box.querySelectorAll('[data-reason]').forEach((x) => x.classList.toggle('on', x === c));
    }));
    box.querySelector('.fb-send')!.addEventListener('click', () => post('down', reason, (box.querySelector('.fb-note') as HTMLInputElement).value));
  });
  return box;
}

function answerCard(q: string, r: Answer) {
  if (r.notFound) {
    const s = stats;
    return el(`<div class="bot-row"><span class="avatar">D</span><div class="card ans notfound">
      <div class="nf-head"><span class="qmark">?</span><span><b>관련 공지나 기사를 찾지 못했어요</b><small>확실하지 않은 내용은 추측해서 답하지 않아요.</small></span></div>
      <p class="ans-text">${renderAnswer(r.answer ?? '', r.sources ?? [])}</p>
      
      <div class="ans-actions"><a class="btn dark" href="/report/">제보하기</a><a class="btn" href="/">일정 전체 보기</a></div>
    </div></div>`);
  }
  const head = [
    '<span class="badge b-ai">● AI 답변</span>',
    (r.askedCount ?? 1) > 1 ? `<small>· ${r.askedCount}명이 같은 질문을 했어요</small>` : '',
  ].join('');
  const flow = (r.events ?? []).find((e) => e.flowId)?.flowId;
  const card = el(`<div class="bot-row"><span class="avatar">D</span><div class="card ans">
    <div class="ans-head">${head}</div>
    <p class="ans-text">${renderAnswer(r.answer ?? '', r.sources ?? [])}</p>
    ${factsTable(r.events ?? [])}
    ${r.warn ? '<p class="warnbox"><span>● 확인 중</span> 아직 공식 공지로 확인되지 않은 내용이 섞여 있어요. 공식 공지를 꼭 확인해 주세요.</p>' : ''}
    ${r.unverified?.length ? `<p class="warnbox"><span>● 확인 필요</span> 공지에서 확인하지 못한 날짜·시간이 있어요: ${esc(r.unverified.join(', '))}</p>` : ''}
    ${sourceCards(r.sources ?? [], r.dataAt)}
    <div class="ans-actions">
      ${flow ? `<a class="btn dark" href="/calendar/flows/${encodeURIComponent(flow)}.ics">📅 캘린더에 추가</a>` : ''}
      <a class="btn" href="/">일정 페이지에서 보기</a>
      <span class="grow"></span>
    </div>
    <div class="follow"><small>이어서</small>${(FOLLOW[r.category ?? '기타'] ?? FOLLOW.기타).map((f) => `<button type="button" class="chip-btn" data-ask="${esc(f)}">${esc(f)}</button>`).join('')}</div>
  </div></div>`);
  card.querySelector('.ans-actions')!.append(feedbackBox(q, r));
  return card;
}

let busy = false;
async function ask(q: string) {
  if (busy) return;
  busy = true;
  convo.hidden = false;
  sticky.hidden = false;
  log.append(el(`<div class="me-row"><p class="me">${esc(q)}</p></div>`));
  const wait = el('<div class="bot-row"><span class="avatar">D</span><div class="card ans wait"><span class="dots"><i></i><i></i><i></i></span> 공지·일정을 찾는 중…</div></div>');
  log.append(wait);
  wait.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const hp = (document.querySelector('[data-ask-form] [name=website]') as HTMLInputElement).value;
  let r: Answer;
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, website: hp, history: history.slice(-2), public: publicBox.checked }) });
    r = (await res.json()) as Answer;
  } catch {
    r = { ok: false, error: '연결이 끊겼어요. 잠시 뒤에 다시 시도해 주세요' };
  }
  wait.remove();
  busy = false;
  if (!r.ok) {
    log.append(el(`<div class="bot-row"><span class="avatar">D</span><div class="card ans err">${esc(r.error ?? '답을 만들지 못했어요')}</div></div>`));
    return;
  }
  history.push({ q, a: r.answer ?? '' });
  const card = answerCard(q, r);
  log.append(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (publicBox.checked) setTimeout(() => loadRecent(), 1500);
}

// 질문 칸 (위쪽·아래 고정 둘 다)
for (const form of document.querySelectorAll<HTMLFormElement>('[data-ask-form]')) {
  const input = form.querySelector('textarea')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    input.style.height = '';
    void ask(q);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; });
}
// 예시·자주 묻는 질문·이어서 질문·다시 물어보기 (누르면 바로 물어봄)
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ask]');
  if (b?.dataset.ask) void ask(b.dataset.ask);
});

// ── 최근 질문 + 오늘 기준 데이터 ──
const recentBox = document.querySelector<HTMLElement>('[data-recent]')!;
const moreBtn = document.querySelector<HTMLButtonElement>('[data-more]')!;
let cursor: string | null = null;

function renderStats(s: Stats) {
  stats = s;
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(s.collectedAt)) / 60000));
  const fresh = document.querySelector('[data-fresh]');
  if (fresh) fresh.textContent = ` · 최근 업데이트 ${mins < 60 ? `${mins}분` : `${Math.round(mins / 60)}시간`} 전`;
}

function recentCard(it: Recent) {
  const kinds = it.sources.reduce<Record<string, number>>((m, s) => { const k = KIND_LABEL[s.kind ?? ''] ?? '자료'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const srcLine = Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(' · ');
  const badge = it.state === 'check' ? '<span class="badge b-check">! 다시 확인 중</span>' : it.state === 'expired' ? '<span class="badge b-old">지난 일정</span>' : it.state === 'notfound' ? '<span class="badge b-old">자료 없음</span>' : '<span class="badge b-ai">● AI 답변</span>';
  const summary = stripCites(it.a).split('\n')[0].slice(0, 120);
  const card = el(`<details class="card rc s-${it.state}">
    <summary>
      <span class="rc-top"><span class="cat ${CAT_CLS[it.category] ?? 'c-etc'}">${esc(it.category)}</span>${badge}<time>${esc(when(it.at))}</time></span>
      <span class="rc-q"><b>${esc(it.q)}</b>${it.count > 1 ? `<span class="asked">${it.count}명이 물어봄</span>` : ''}</span>
      <span class="rc-sum">${esc(summary)}</span>
      <span class="rc-foot">${it.qk ? `<span class="votes" data-qk="${it.qk}"><button type="button" class="vote" data-vote="up" aria-label="도움이 됐어요">👍 <b>${it.ups}</b></button><button type="button" class="vote" data-vote="down" aria-label="틀렸어요">👎 <b>${it.downs}</b></button></span>` : `<span>👍 ${it.ups}${it.downs ? ` · 👎 ${it.downs}` : ''}</span>`}${srcLine ? `<span>근거 ${esc(srcLine)}</span>` : ''}<span class="grow"></span>
        ${it.state === 'expired' || it.state === 'check' ? `<button type="button" class="btn small" data-ask="${esc(it.q)}">↻ 다시 물어보기</button>` : '<span class="rc-open">답변 보기</span>'}</span>
    </summary>
    <div class="rc-body">
      <p class="ans-text">${esc(stripCites(it.a))}</p>
      ${it.sources.length ? `<ul class="rc-src">${it.sources.filter((s) => s.url).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul>` : ''}
      <button type="button" class="btn small" data-ask="${esc(it.q)}">이 질문 하기</button>
    </div>
  </details>`);
  return card;
}

const shownQ = new Set<string>();
async function loadRecent(more = false) {
  const res = await fetch(`/api/ask-log${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`).catch(() => null);
  const data = res?.ok ? ((await res.json()) as { items: Recent[]; next: string | null; stats: Stats | null }) : { items: [], next: null, stats: null };
  if (data.stats) renderStats(data.stats);
  if (!more) { recentBox.innerHTML = data.items.length ? '' : '<p class="recent-empty">아직 질문이 없어요. 첫 질문을 해 보세요.</p>'; shownQ.clear(); }
  // 같은 질문은 한 번만 (서버는 쪽마다 따로 합쳐서, 더 보기로 붙이면 겹칠 수 있다)
  for (const it of data.items) { const k = it.qk ?? it.q.replace(/\s+/g, ''); if (shownQ.has(k)) continue; shownQ.add(k); recentBox.append(recentCard(it)); }
  cursor = data.next;
  moreBtn.hidden = !data.next;
}
moreBtn.addEventListener('click', () => loadRecent(true));
// 최근 질문 👍/👎: 질문한 사람이 아니어도 누를 수 있다 (하루 한 번, 누른 건 이 기기에 기억)
const votedKey = (qk: string) => `askvoted:${qk}`;
const markVoted = (box: HTMLElement, r: string) => box.querySelectorAll<HTMLButtonElement>('.vote').forEach((b) => b.classList.toggle('on', b.dataset.vote === r));
recentBox.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.vote');
  if (!b) return;
  e.preventDefault(); e.stopPropagation(); // 카드 펼치기와 따로
  const box = b.closest<HTMLElement>('[data-qk]')!;
  const qk = box.dataset.qk!;
  let voted: string | null = null;
  try { voted = localStorage.getItem(votedKey(qk)); } catch {}
  if (voted) return;
  const res = await fetch('/api/ask-vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qk, rating: b.dataset.vote }) }).catch(() => null);
  const d = res ? ((await res.json()) as { ok: boolean; ups?: number; downs?: number }) : null;
  if (d && d.ups !== undefined) { box.querySelector('[data-vote="up"] b')!.textContent = String(d.ups); box.querySelector('[data-vote="down"] b')!.textContent = String(d.downs ?? 0); }
  if (d && (d.ok || res?.status === 409)) { try { localStorage.setItem(votedKey(qk), b.dataset.vote!); } catch {} markVoted(box, b.dataset.vote!); }
});
const restoreVotes = () => recentBox.querySelectorAll<HTMLElement>('[data-qk]').forEach((box) => { let v: string | null = null; try { v = localStorage.getItem(votedKey(box.dataset.qk!)); } catch {} if (v) markVoted(box, v); });
new MutationObserver(restoreVotes).observe(recentBox, { childList: true });
syncPublic();
void loadRecent();
