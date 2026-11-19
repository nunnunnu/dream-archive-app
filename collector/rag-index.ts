/**
 * RAG 색인: 공지·기사·영상·일정을 조각으로 나눠 임베딩하고 Supabase rag_chunks(pgvector)에 넣는다.
 *   npm run rag:index [-- --dry]    (--dry: 조각 수·예상 비용만)
 * 바뀐 조각만 다시 임베딩하고(content_hash), 없어진 문서의 조각은 지운다.
 * 기사 본문은 사이트 잡음(다른 기사 목록 등)이 섞여 있어 그룹·멤버·기사 제목 낱말이 있는 문단만 넣는다.
 */
import './lib/env.ts';
import { createHash } from 'node:crypto';
import { loadAskData } from './lib/ask.ts';
import { Budget } from './lib/budget.ts';
import { GROUP, GROUP_NAME_RE } from './lib/group.ts';
import { callModel } from './lib/llm.ts';
import { mentionedMembers } from './lib/members.ts';
import { JsonRepo } from './lib/repo.ts';
import { isFanMade, loadRecentVideos } from './lib/youtube.ts';

const MODEL = 'text-embedding-3-small';
const PRICE_PER_M = 0.02; // USD / 100만 토큰
const dry = process.argv.includes('--dry');
const url = process.env.SUPABASE_URL!.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) };
const sha = (t: string) => createHash('sha1').update(t).digest('hex').slice(0, 16);
const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const relevant = (t: string) => GROUP_NAME_RE.test(t) || mentionedMembers(t).members.length > 0 || /엔시티|NCT/i.test(t);

interface Chunk { id: string; doc_type: string; doc_url: string; title: string; published_at: string | null; members: string[]; content: string; content_hash: string }
const chunks: Chunk[] = [];
// 자르다 남은 반쪽 이모지(짝 없는 서로게이트)·NUL 문자는 DB(JSON·text)가 받지 않는다
const clean = (t: string) => t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/g, '');
const add = (doc_type: string, doc_url: string, rawTitle: string, published_at: string | null, content: string, i: number) => {
  const title = clean(rawTitle);
  const text = clean(content.trim().slice(0, 1200));
  if (text.length < 20) return;
  chunks.push({ id: sha(`${doc_url}#${i}`), doc_type, doc_url, title, published_at, members: mentionedMembers(`${title} ${text}`).members, content: text, content_hash: sha(`${title}\n${text}`) });
};
/** 문단을 700자 안팎으로 묶는다 */
const split = (text: string) => text.split(/\n{2,}|(?<=다\.)\s+(?=\S)/).reduce<string[]>((acc, p) => {
  const last = acc.at(-1);
  if (last && last.length + p.length < 700) acc[acc.length - 1] = `${last}\n${p}`;
  else acc.push(p);
  return acc;
}, []);

const repo = new JsonRepo();
const data = await loadAskData(repo);
for (const d of data.docs.filter((x) => x.kind === 'notice')) split(d.text).forEach((p, i) => add('notice', d.url, d.title, `${d.date}T${d.time ?? '00:00'}:00+09:00`, p, i));
for (const d of data.docs.filter((x) => x.kind === 'article')) {
  const words = sq(d.title).length >= 4 ? d.title.split(/\s+/).map(sq).filter((w) => w.length >= 2) : [];
  split(d.text).filter((p) => relevant(p) || words.filter((w) => sq(p).includes(w)).length >= 2).forEach((p, i) => add('article', d.url, d.title, `${d.date}T00:00:00+09:00`, p, i));
}
// 영상은 믿을 수 있는 것만: 공식 채널 · 출연 · 방송사 공식 채널. 팬 채널(커버댄스·노래방·가사 등)은 넣지 않는다
const OFFICIAL_CH = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
const BROADCAST_CH = new Set([...GROUP.youtube.channels.filter((c) => c.guest).map((c) => c.name), ...(GROUP.youtube.stageChannels ?? [])]);
const trusted = (v: { channel: string; guest?: boolean; title: string }) => (OFFICIAL_CH.has(v.channel) || BROADCAST_CH.has(v.channel) || Boolean(v.guest)) && !isFanMade(v.title);
for (const v of (await loadRecentVideos(new Date(), 160)).filter(trusted)) add('video', v.url, `${v.title} (${v.channel})`, v.publishedAt, `${v.title}\n${v.channel}\n${(v.description ?? '').slice(0, 400)}`, 0);
for (const e of data.events) add('event', `event:${e.id}`, `${e.title} · ${e.step}`, `${e.date}T${e.time ?? '00:00'}:00+09:00`, `${e.date} ${e.time ?? '시간 미정'} ${e.kind} ${e.title} · ${e.step} · ${e.members.join('·') || '단체'}${e.evidence ? `\n${e.evidence}` : ''}`, 0);

// 같은 문서가 두 번 잡히면(같은 영상이 두 달 파일에 있는 경우 등) 조각 ID가 겹친다 → 하나만
{ const seen = new Map<string, Chunk>(); for (const c of chunks) seen.set(c.id, c); chunks.length = 0; chunks.push(...seen.values()); }
// ── 조각 보강: 문서마다 한 줄 요약(나오는 멤버 한글·영어 이름, 종류, 내용)을 조각 앞에 붙여 임베딩한다
//    사람이 낱말 목록을 만들지 않아도 "런쥔 커버"가 "Cover | RENJUN" 영상과 가까워지게. 같은 문서는 다시 요약하지 않는다.
const enrichCache = await repo.getState<Record<string, string>>('rag/enrich', {});
const memberHint = GROUP.members.map((m) => `${m.name}(${m.aliases.filter((a) => /^[A-Z]+$/.test(a)).join('/')})`).join(', ');
const SUMMARY_RULE = `NCT DREAM 자료 한 건을 검색용으로 한 줄(100자 이내) 요약한다. 형식: "멤버: … / 종류: … / 내용: …". 멤버는 한글·영어 이름을 같이 (${memberHint}), 없으면 단체. 종류는 커버, 안무 영상, 뮤직비디오·티저, 자체 콘텐츠(시리즈 이름·회차), 외부 출연(프로그램 이름), 무대·직캠, 공지(사전녹화·예매·팬사인회 등), 기사 중에서. 자료에 없는 내용은 쓰지 않는다.`;
const docKey = (url: string, text: string) => sha(`${url}\n${text.slice(0, 2000)}`);
const byDoc = new Map<string, Chunk[]>();
for (const c of chunks) if (c.doc_type !== 'event') byDoc.set(c.doc_url, [...(byDoc.get(c.doc_url) ?? []), c]);
const needDocs = [...byDoc.entries()].filter(([url, cs]) => !enrichCache[docKey(url, cs.map((c) => c.content).join('\n'))]);
const videoDocs = needDocs.filter(([, cs]) => cs[0].doc_type === 'video');
const textDocs = needDocs.filter(([, cs]) => cs[0].doc_type !== 'video');
console.log(`조각 보강: 요약할 문서 ${needDocs.length}개 (영상 ${videoDocs.length} · 공지·기사 ${textDocs.length}), 저장된 요약 ${Object.keys(enrichCache).length}개`);
let enrichCost = 0;
if (!dry && needDocs.length) {
  const budget0 = await new Budget(repo, new Date()).load();
  // 영상: 40개씩 한 번에
  for (let i = 0; i < videoDocs.length; i += 40) {
    const batch = videoDocs.slice(i, i + 40);
    const r = await callModel({
      model: 'gpt-5-nano', effort: 'low', instructions: `${SUMMARY_RULE} 여러 건이 번호와 함께 온다. 번호마다 한 줄씩.`,
      input: clean(batch.map(([, cs], j) => `[${j}] ${cs[0].title}\n${cs[0].content.slice(0, 300)}`).join('\n\n')),
      schema: { name: 'summaries', schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 's'], properties: { i: { type: 'integer' }, s: { type: 'string' } } } } } } },
    }).catch((err) => { console.log(`\n영상 요약 실패 (${i}~${i + batch.length - 1}번): ${(err as Error).message.slice(0, 160)}`); return null; });
    if (!r) continue;
    enrichCost += r.usage.costUsd;
    for (const it of (JSON.parse(r.value) as { items: { i: number; s: string }[] }).items) {
      const d = batch[it.i];
      if (d) enrichCache[docKey(d[0], d[1].map((c) => c.content).join('\n'))] = clean(it.s).slice(0, 200);
    }
    process.stdout.write(`\r영상 요약 ${Math.min(i + 40, videoDocs.length)}/${videoDocs.length}`);
    if (i % 400 === 0) await repo.putState('rag/enrich', enrichCache);
  }
  // 공지·기사: 문서마다
  // 문서마다 한 번씩이라 8개씩 동시에 (하나씩 하면 수백 개일 때 한 시간 넘게 걸려 다른 수집을 막는다)
  let done = 0;
  const queue = [...textDocs];
  await Promise.all(Array.from({ length: 8 }, async () => { for (let item = queue.shift(); item; item = queue.shift()) {
    const [url, cs] = item;
    const r = await callModel({ model: 'gpt-5-nano', effort: 'low', instructions: SUMMARY_RULE, input: clean(`${cs[0].title}\n${cs.map((c) => c.content).join('\n').slice(0, 1800)}`), schema: { name: 'summary', schema: { type: 'object', additionalProperties: false, required: ['s'], properties: { s: { type: 'string' } } } } }).catch(() => null);
    if (!r) continue;
    enrichCost += r.usage.costUsd;
    enrichCache[docKey(url, cs.map((c) => c.content).join('\n'))] = clean((JSON.parse(r.value) as { s: string }).s).slice(0, 200);
    process.stdout.write(`\r공지·기사 요약 ${++done}/${textDocs.length}`);
  } }));
  await repo.putState('rag/enrich', enrichCache);
  budget0.record(enrichCost);
  await budget0.save();
  console.log(`\n조각 보강 비용 약 ${Math.round(enrichCost * 1400 * 10) / 10}원`);
}
// 요약을 조각 앞에 붙이고 지문을 다시 계산 (요약이 바뀌면 다시 임베딩)
for (const [url, cs] of byDoc) {
  const sum = enrichCache[docKey(url, cs.map((c) => c.content).join('\n'))];
  if (!sum) continue;
  for (const c of cs) { c.content = `요약: ${sum}\n${c.content}`; c.content_hash = sha(`${c.title}\n${c.content}`); }
}
// 지금 들어 있는 조각 (id → content_hash)
const have = new Map<string, string>();
for (let from = 0; ; from += 1000) {
  const res = await fetch(`${url}/rest/v1/rag_chunks?select=id,content_hash`, { headers: { ...sb, Range: `${from}-${from + 999}` } });
  const rows = (await res.json()) as { id: string; content_hash: string }[];
  for (const r of rows) have.set(r.id, r.content_hash);
  if (rows.length < 1000) break;
}
const todo = chunks.filter((c) => have.get(c.id) !== c.content_hash);
const ids = new Set(chunks.map((c) => c.id));
const stale = [...have.keys()].filter((id) => !ids.has(id));
const estTokens = todo.reduce((s, c) => s + Math.ceil((c.title.length + c.content.length) / 1.3), 0);
const byType = (l: Chunk[]) => Object.entries(l.reduce<Record<string, number>>((m, c) => ({ ...m, [c.doc_type]: (m[c.doc_type] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(' · ');
console.log(`조각 ${chunks.length}개 (${byType(chunks)}) · 새로·바뀜 ${todo.length}개 · 지울 것 ${stale.length}개 · 예상 약 ${Math.round(estTokens / 1000)}천 토큰 ≈ ${Math.round((estTokens / 1e6) * PRICE_PER_M * 1400 * 10) / 10}원`);
if (dry) process.exit(0);

const budget = await new Budget(repo, new Date()).load();
let tokens = 0;
// 중간에 실패해도 쓴 만큼은 비용 기록에 남긴다
try {
for (let i = 0; i < todo.length; i += 100) {
  const batch = todo.slice(i, i + 100);
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: batch.map((c) => clean(`${c.title}\n${c.content}`)) }),
  });
  if (!res.ok) throw new Error(`임베딩 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as { data: { embedding: number[] }[]; usage: { total_tokens: number } };
  tokens += out.usage.total_tokens;
  const rows = batch.map((c, j) => ({ ...c, embedding: `[${out.data[j].embedding.join(',')}]`, updated_at: new Date().toISOString() }));
  const up = await fetch(`${url}/rest/v1/rag_chunks`, { method: 'POST', headers: { ...sb, 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  if (!up.ok) throw new Error(`넣기 실패 ${up.status}: ${(await up.text()).slice(0, 200)}`);
  process.stdout.write(`\r임베딩 ${Math.min(i + 100, todo.length)}/${todo.length}`);
}
} finally {
  budget.record((tokens / 1e6) * PRICE_PER_M);
  await budget.save();
}
for (let i = 0; i < stale.length; i += 100) {
  await fetch(`${url}/rest/v1/rag_chunks?id=in.(${stale.slice(i, i + 100).join(',')})`, { method: 'DELETE', headers: sb });
}
const cost = (tokens / 1e6) * PRICE_PER_M;
console.log(`\n완료: ${todo.length}개 임베딩 (${tokens} 토큰, 약 ${Math.round(cost * 1400 * 10) / 10}원), ${stale.length}개 지움`);
