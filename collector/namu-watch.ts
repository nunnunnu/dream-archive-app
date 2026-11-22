/**
 * 나무위키 주간 검토: 그룹·멤버 문서에서 지난번과 달라진 줄만 골라 AI(무료 Groq 작은 모델 → 막히면 nano)가 활동 이름·기간을 뽑고,
 * 아카이브(기사 제목·일정)에 없는 활동은 app_state 'namu/seeds'에 넣는다 → backfill:seeds --from-state가 그 이름으로 기사를 찾는다.
 *   STORE=pg npm run namu:watch [-- --force]   (마지막 검토 후 intervalDays가 안 지났으면 바로 끝남)
 * 처음 읽는 문서는 기준으로만 저장하고 넘어간다 (지난 내용 전체는 2026-11-22에 손으로 검토함).
 * 원문은 bodies(kind 'namu', 비공개)에만 두고 사이트에 옮기지 않는다. 봇 확인 화면·차단이면 우회하지 않고 건너뛴다.
 */
import './lib/env.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Budget } from './lib/budget.ts';
import { GROUP } from './lib/group.ts';
import { callModel, hasLlmKey } from './lib/llm.ts';
import { JsonRepo } from './lib/repo.ts';
import { ROOT } from './lib/store.ts';

const UA = 'dream-archive-bot/1.0 (+https://dream-archive.pages.dev; weekly schedule check)';
const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'namu.json'), 'utf8')) as { intervalDays: number; pages: { title: string; member?: string }[] };
const repo = new JsonRepo();
const now = new Date();
const state = await repo.getState<{ lastRun?: string }>('namu/watch', {});
if (!process.argv.includes('--force') && state.lastRun && now.getTime() - Date.parse(state.lastRun) < cfg.intervalDays * 864e5) {
  console.log(`나무위키 검토: 마지막 검토 ${state.lastRun.slice(0, 10)} → 아직 ${cfg.intervalDays}일이 안 지남`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const isNum = (l: string) => /^\d+(\.\d+)*\.$/.test(l);
function textOf(html: string): string[] {
  const lines = decode(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, '\n'))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 2 && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(l));
  // "둘러보기"(아래쪽 목록 상자)부터는 읽지 않는다: 다른 그룹·유닛(NCT 127 등) 음반 목록이 통째로 들어 있다
  const nav = lines.findIndex((l, i) => isNum(l) && lines[i + 1] === '둘러보기');
  return nav >= 0 ? lines.slice(0, nav) : lines;
}

interface Seed { name: string; keywords: string[]; member?: string; from: string; to: string; done?: boolean; found?: number; addedAt?: string }
const seeds = await repo.getState<Seed[]>('namu/seeds', []);
const budget = await new Budget(repo, now).load();
const norm = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
// 아카이브에 있는지: 기사 제목·뽑은 일정 이름(대상·단계)에 이름이 나오면 있음
const haystack: string[] = [
  ...(await repo.listArticles('2000-01-01T00:00:00Z')).map((a) => norm(a.title)),
  ...(await Promise.all((['notice', 'article', 'video', 'submission'] as const).map((t) => repo.listExtractions(t)))).flat().flatMap((x) => x.checked.map((e) => norm(`${e.target} ${e.step}`))),
];
// 이름에서 연도·회차·괄호를 뗀 것도 본다 ("2026 15th 드림 페스티벌" → "드림 페스티벌", "부산원아시아페스티벌 2026" → "부산원아시아페스티벌")
const variants = (k: string) => [k, k.replace(/\([^)]*\)/g, ''), k.replace(/\([^)]*\)|\b(19|20)\d{2}\b|\b\d+(st|nd|rd|th)\b|제\s*\d+\s*회/gi, '')];
const inArchive = (keys: string[]) => keys.flatMap(variants).map(norm).filter((k) => k.length >= 3).some((k) => haystack.filter((h) => h.includes(k)).length >= 2);

let checked = 0;
for (const p of cfg.pages) {
  const res = await fetch(`https://namu.wiki/w/${encodeURIComponent(p.title)}`, { headers: { 'user-agent': UA } }).catch(() => null);
  await sleep(3000);
  const html = res?.ok ? await res.text() : '';
  if (!res?.ok || /cf-chl|challenge-platform|Just a moment/i.test(html) || !html.includes('나무위키')) {
    console.log(`나무위키 ${p.title}: 읽지 못함 (${res?.status ?? '연결 실패'}) → 이번 주는 건너뜀 (우회하지 않음)`);
    continue;
  }
  checked++;
  const lines = textOf(html);
  const prev = (await repo.getBody('namu', p.title))?.split('\n') ?? null;
  await repo.putBody('namu', p.title, lines.join('\n'));
  if (!prev) { console.log(`나무위키 ${p.title}: 처음 읽음 → 기준으로 저장`); continue; }
  const old = new Set(prev);
  // 새로 생긴 줄 + 앞뒤 3줄 (표가 칸마다 줄로 나뉘어서: 이름·구분·날짜)
  const idx = lines.map((l, i) => (old.has(l) ? -1 : i)).filter((i) => i >= 0);
  if (!idx.length) { console.log(`나무위키 ${p.title}: 바뀐 곳 없음`); continue; }
  const keep = new Set(idx.flatMap((i) => [i - 3, i - 2, i - 1, i, i + 1, i + 2, i + 3]).filter((i) => i >= 0 && i < lines.length));
  // 줄마다 속한 목차 제목("4.2. NCT 127", "6.1. 음반")을 붙인다: 멤버 문서에는 다른 유닛(NCT 127 등) 활동도 있어서 어느 활동인지 알아야 한다
  // 목차 제목은 "4.2." 줄 다음 줄에 이름이 온다
  const headOf = (i: number) => { for (let k = i; k >= 0; k--) if (isNum(lines[k])) return `${lines[k]} ${lines[k + 1] ?? ''}`; return ''; };
  let lastHead = '';
  const out: string[] = [];
  for (const i of [...keep].sort((a, b) => a - b)) { const h = headOf(i); if (h && h !== lastHead) { out.push(`## ${h}`); lastHead = h; } out.push(lines[i]); }
  const diff = out.join('\n').slice(0, 8000);
  if (process.env.NAMU_DEBUG) console.log(`--- ${p.title} 바뀐 부분\n${diff}\n---`);
  if (!hasLlmKey() || !budget.canSpend()) { console.log(`나무위키 ${p.title}: 바뀐 줄 ${idx.length}개, AI를 못 써서 다음 검토로`); continue; }
  const r = await callModel({
    model: 'gpt-5-mini', effort: 'medium', // 주 1회·바뀐 부분만이라 몇 원: 무료 작은 모델은 같은 입력에도 뽑는 결과가 들쭉날쭉해서
    instructions: [
      `${GROUP.name}${p.member ? ` 멤버 ${p.member}` : ''} 위키 문서에서 새로 추가·수정된 부분이다. 여기서 활동(음반·곡·OST·콘서트·팬미팅·드라마·영화·고정 예능·라디오·자체 콘텐츠·페스티벌 출연)을 뽑는다.`,
      `- ${GROUP.name} 단체 또는 ${p.member ? `${p.member} 개인(솔로·개인 출연)` : '유닛'} 활동만. "## 목차"가 다른 그룹·유닛(NCT 127, NCT U, WayV, SuperM 등)이면 뺀다.`,
      '- 해당하는 활동은 빠짐없이 모두 뽑는다 (표의 행마다 하나씩).',
      '- 날짜(연·월, 가능하면 일)가 바로 옆에 적힌 것만. 날짜가 없거나 추측해야 하면 뺀다. 광고·화보·앰버서더·논란·공연장·도시 이름은 활동이 아니다.',
      '- name: 활동 이름 그대로. keywords: 기사 제목에 나올 법한 이름 1~4개 (원래 이름, 한글·영어 표기). from/to: YYYY-MM-DD (모르는 날은 그달 1일·말일).',
      '- 표에서 연도가 위쪽 줄("2026년")에만 있고 행에는 "6월 27일"만 있으면 위쪽 연도를 쓴다. 표의 행은 보통 "날짜 → 이름" 또는 "이름 → 구분 → 날짜" 순서다.',
      '- evidence: 이름과 날짜가 적힌 줄을 입력에서 글자 그대로 복사한다. 표처럼 칸이 여러 줄로 나뉘어 있으면 같은 행의 줄만 " / "로 잇는다 (다른 행의 날짜를 섞지 말 것).',
    ].join('\n'),
    input: diff,
    schema: { name: 'acts', schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'keywords', 'from', 'to', 'evidence'], properties: { name: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, evidence: { type: 'string' } } } } } } },
  }).catch((e) => { console.log(`나무위키 ${p.title}: AI 실패 ${(e as Error).message.slice(0, 80)}`); return null; });
  if (!r) continue;
  budget.record(r.usage.costUsd);
  // 검증: 이름이 바뀐 부분에 그대로 있고, 시작 연도도 그 근처에 있어야 한다 (지어낸 이름·날짜를 막는다)
  //   근거(evidence): 이름 줄과 날짜 줄이 문서에 그대로 있고 3줄 안에 붙어 있어야 한다.
  //   이름 앞뒤 3줄 안에 날짜 줄이 둘 이상이면 어느 행의 날짜인지 애매해서 뺀다 (표: "이름 → 구분 → 날짜" 행이 이어질 때 앞 행 날짜를 집는 경우)
  const DATE_LINE = /^(\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?|\d{1,2}월\s?\d{1,2}일|\d{4}년\s?\d{1,2}월(\s?\d{1,2}일)?)$/;
  const verified = (a: { name: string; from: string; evidence?: string }) => {
    const [y, m] = [a.from.slice(0, 4), String(Number(a.from.slice(5, 7)))];
    const nameN = norm(a.name.replace(/\([^)]*\)/g, '')).slice(0, 12);
    const nameIdx = lines.findIndex((l) => norm(l).length >= 3 && norm(l).includes(nameN));
    if (nameIdx < 0 || !norm(a.evidence ?? '').includes(nameN)) return false;
    const win = lines.slice(Math.max(0, nameIdx - 3), nameIdx + 4);
    const dates = win.filter((l) => DATE_LINE.test(l) && !/^\d{4}년$/.test(l));
    if (dates.length !== 1) return false;
    const d = dates[0];
    if (new RegExp(`^${y}\\s*[.년]\\s*0?${m}(?!\\d)`).test(d)) return true;
    // 행에는 "6월 27일"만 있고 연도는 위쪽 줄("2026년")이나 이름에 있는 표
    if (!new RegExp(`^0?${m}월`).test(d)) return false;
    const yearAbove = lines.slice(Math.max(0, nameIdx - 15), nameIdx + 1).reverse().find((l) => /^\d{4}년$/.test(l));
    return a.name.includes(y) || yearAbove === `${y}년`;
  };
  const raw = (JSON.parse(r.value) as { items: (Omit<Seed, 'member'> & { evidence?: string })[] }).items;
  const acts = raw.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.from) && /^\d{4}-\d{2}-\d{2}$/.test(a.to) && verified(a));
  const dropped = raw.filter((a) => !acts.includes(a));
  if (dropped.length) console.log(`  근거 확인 안 돼서 뺌: ${dropped.map((a) => `${a.name}(${a.from}) [${(a.evidence ?? '').slice(0, 60)}]`).join(', ')}`);
  if (acts.length) console.log(`  뽑은 활동: ${acts.map((a) => `${a.name}(${a.from})`).join(', ')}`);
  const missing = acts.filter((a) => !inArchive([a.name, ...a.keywords]) && !seeds.some((s) => norm(s.name) === norm(a.name)));
  for (const a of missing) {
    // 기사는 발표가 조금 먼저 나오니 2주 앞부터
    const from = new Date(Date.parse(a.from) - 14 * 864e5).toISOString().slice(0, 10);
    seeds.push({ name: a.name, keywords: [...new Set([a.name, ...a.keywords])].slice(0, 5), member: p.member, from, to: a.to, addedAt: now.toISOString() });
  }
  console.log(`나무위키 ${p.title}: 바뀐 줄 ${idx.length}개 → 활동 ${acts.length}개 중 아카이브에 없는 것 ${missing.length}개${missing.length ? ` (${missing.map((a) => a.name).join(', ')})` : ''}`);
}
await repo.putState('namu/seeds', seeds);
if (checked) await repo.putState('namu/watch', { lastRun: now.toISOString() });
await budget.save();
console.log(`나무위키 검토 끝: 읽은 문서 ${checked}/${cfg.pages.length} · 찾을 활동 ${seeds.filter((s) => !s.done).length}개`);
