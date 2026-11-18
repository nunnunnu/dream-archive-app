// 물어보기 화면: 질문 보내기, 답·출처 보여 주기, 👍/👎 평가
interface Source { id: string; ids?: string[]; title: string; url: string }
interface Answer { ok: boolean; id?: string; answer?: string; sources?: Source[]; unverified?: string[]; dataAt?: string | null; error?: string }

const REASONS = ['틀린 정보', '날짜·시간 오류', '자료에 있는데 모른대요', '출처가 엉뚱해요', '답이 너무 길어요', '기타'];
const log = document.getElementById('chat-log')!;
const empty = document.getElementById('chat-empty');
const form = document.getElementById('chat-form') as HTMLFormElement;
const input = document.getElementById('chat-input') as HTMLTextAreaElement;
const send = document.getElementById('chat-send') as HTMLButtonElement;

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
/** 이어지는 질문을 이해하도록 최근 대화 2개를 함께 보낸다 */
const history: { q: string; a: string }[] = [];
const scroll = () => log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });

/** 답 본문: [E1]·[D2] 표시를 출처 번호 칩으로 */
function renderAnswer(text: string, sources: Source[]) {
  const num = new Map(sources.flatMap((s, i) => (s.ids ?? [s.id]).map((id) => [id, i + 1] as const)));
  const anchor = new Map(sources.flatMap((s) => (s.ids ?? [s.id]).map((id) => [id, s.id] as const)));
  // 같은 출처 번호가 연달아 나오면 하나만
  return esc(text).replace(/(\s*\[([EDL]\d+)\])+/g, (run) => {
    const nums = [...new Set([...run.matchAll(/\[([EDL]\d+)\]/g)].map((m) => m[1]).filter((id) => num.has(id)).map((id) => `${num.get(id)}|${anchor.get(id)}`))];
    return nums.map((x) => { const [n, a] = x.split('|'); return `<a class="cite" href="#src-${a}">${n}</a>`; }).join('');
  });
}

function feedbackBox(q: string, r: Answer) {
  const box = el(`<div class="fb"><span>도움이 됐나요?</span><button type="button" class="fb-btn" data-r="up" aria-label="도움이 됐어요">👍</button><button type="button" class="fb-btn" data-r="down" aria-label="별로예요">👎</button></div>`);
  const post = async (rating: 'up' | 'down', reason = '', note = '') => {
    const res = await fetch('/api/ask-feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: r.id, rating, reason, note, question: q, answer: r.answer, sources: r.sources }) }).catch(() => null);
    const ok = res?.ok ? ((await res.json()) as { ok: boolean }).ok : false;
    box.innerHTML = ok ? '<span class="fb-done">고마워요! 답 품질을 고치는 데 쓸게요.</span>' : '<span class="fb-done">평가를 저장하지 못했어요 (준비 중).</span>';
  };
  box.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('.fb-btn');
    if (!b) return;
    if (b.dataset.r === 'up') return void post('up');
    // 👎: 이유 고르기
    box.innerHTML = `<div class="fb-why"><span>무엇이 아쉬웠나요?</span><div class="fb-reasons">${REASONS.map((x) => `<button type="button" class="chip-btn" data-reason="${x}">${x}</button>`).join('')}</div><input class="fb-note" maxlength="300" placeholder="(선택) 맞는 정보나 링크를 알려 주세요" /><button type="button" class="fb-send">보내기</button></div>`;
    let reason = '';
    box.querySelectorAll<HTMLButtonElement>('[data-reason]').forEach((c) => c.addEventListener('click', () => {
      reason = c.dataset.reason!;
      box.querySelectorAll('[data-reason]').forEach((x) => x.classList.toggle('on', x === c));
    }));
    box.querySelector('.fb-send')!.addEventListener('click', () => post('down', reason, (box.querySelector('.fb-note') as HTMLInputElement).value));
  });
  return box;
}

async function ask(q: string) {
  empty?.remove();
  log.append(el(`<div class="msg me"><p>${esc(q)}</p></div>`));
  const wait = el('<div class="msg bot wait"><p><span class="dots"><i></i><i></i><i></i></span> 공지·일정을 찾는 중…</p></div>');
  log.append(wait);
  scroll();
  send.disabled = true;
  const form = new FormData(document.getElementById('chat-form') as HTMLFormElement);
  let r: Answer;
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, website: form.get('website'), history: history.slice(-2) }) });
    r = (await res.json()) as Answer;
  } catch {
    r = { ok: false, error: '연결이 끊겼어요. 잠시 뒤에 다시 시도해 주세요' };
  }
  wait.remove();
  send.disabled = false;
  if (!r.ok) {
    log.append(el(`<div class="msg bot err"><p>${esc(r.error ?? '답을 만들지 못했어요')}</p></div>`));
    return scroll();
  }
  const sources = r.sources ?? [];
  history.push({ q, a: r.answer ?? '' });
  const msg = el(`<div class="msg bot"><p class="answer">${renderAnswer(r.answer ?? '', sources)}</p></div>`);
  if (r.unverified?.length) msg.append(el(`<p class="warn">⚠ 자료에서 확인되지 않은 날짜·시간이 있어요: ${esc(r.unverified.join(', '))} · 원문 공지를 확인해 주세요</p>`));
  if (sources.length) {
    msg.append(el(`<ol class="srcs">${sources.map((s) => `<li id="src-${esc(s.id)}"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><span>${/weverse/.test(s.url) ? '위버스 공지' : /youtu/.test(s.url) ? '유튜브' : '기사'}</span></li>`).join('')}</ol>`));
  }
  if (r.dataAt) msg.append(el(`<p class="data-at">자료 기준 ${esc(new Date(r.dataAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</p>`));
  msg.append(feedbackBox(q, r));
  log.append(msg);
  scroll();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || send.disabled) return;
  input.value = '';
  input.style.height = '';
  void ask(q);
});
// Enter 보내기, Shift+Enter 줄바꿈 (한글 조합 중에는 보내지 않음)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; });
document.querySelectorAll<HTMLButtonElement>('.ex').forEach((b) => b.addEventListener('click', () => void ask(b.dataset.q!)));
