/**
 * 팬 질문 (Astro API, Cloudflare에서 실행): POST /api/ask  { question }
 * 자료(일정·공지·기사)는 수집기가 KV에 올린 ask:index 를 쓰고, 답은 OpenAI로 만든다 (collector/lib/ask-core.ts 와 같은 규칙).
 * 비용 지키기: 질문 200자까지, 같은 IP는 1시간에 10번, 전체는 하루 ASK_DAILY_LIMIT번(기본 50, 질문 1번 약 5원). 횟수는 KV(REPORTS)에 센다.
 * KV가 없으면 운영에서는 받지 않는다 (로컬 시험은 ASK_ALLOW_NO_KV=1).
 */
import type { APIRoute } from 'astro';
import { askCore, supabaseVector, type AskCall, type AskData } from '../../../../collector/lib/ask-core.ts';
import { categoryOf, maskPersonal, questionKey, sha, type KV as SharedKV } from '../../lib/ask-shared';

/** 질문 자료 묶음(공지·기사 원문 포함)은 수집기가 KV에 올린다 (npm run publish:site). 버전이 같으면 다시 읽지 않는다 */
type AskIndex = AskData & { generatedAt?: string };
let cached: { ver: string | null; data: AskIndex } | null = null;
async function loadIndex(kv: KV): Promise<AskIndex | null> {
  const ver = await kv.get('ask:index:version');
  if (cached && cached.ver === ver) return cached.data;
  const data = await kv.get<AskIndex>('ask:index', 'json');
  if (data) cached = { ver, data };
  return data;
}

interface KV extends SharedKV {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
}
interface Env { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; OPENAI_API_KEY?: string; ASK_MODEL?: string; ASK_DAILY_LIMIT?: string; ASK_MONTHLY_BUDGET_KRW?: string; ASK_ALLOW_NO_KV?: string; REPORTS?: KV }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const PRICES: Record<string, { input: number; output: number }> = { 'gpt-5-nano': { input: 0.05, output: 0.4 }, 'gpt-5-mini': { input: 0.25, output: 2.0 } };

/** OpenAI Responses API (SDK 없이 fetch) */
const openai = (key: string): AskCall => async (o) => {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: o.model, reasoning: { effort: o.effort }, max_output_tokens: 6000,
      input: [{ role: 'system', content: o.instructions }, { role: 'user', content: o.input }],
      ...(o.schema ? { text: { format: { type: 'json_schema', name: o.schema.name, schema: o.schema.schema, strict: true } } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AI 요청 실패 ${res.status}`);
  const r = (await res.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[]; usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } } };
  const value = (r.output ?? []).filter((x) => x.type === 'message').flatMap((x) => x.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
  const p = PRICES[o.model] ?? PRICES['gpt-5-mini'];
  // 프롬프트 캐시로 읽힌 입력은 10% 가격
  const cached = r.usage?.input_tokens_details?.cached_tokens ?? 0;
  return { value, usage: { costUsd: (((r.usage?.input_tokens ?? 0) - cached) * p.input + cached * p.input * 0.1 + (r.usage?.output_tokens ?? 0) * p.output) / 1e6 } };
};

type Result = { answer: string; sources: { id: string; ids: string[]; title: string; url: string; kind?: string; date?: string }[]; unverified: string[]; dataAt: string | null; events: NonNullable<Awaited<ReturnType<typeof askCore>>['events']>; notFound: boolean; at: string };

/** 근거 일정 중 가장 늦은 날짜 (그날이 지나면 목록에서 "지난 일정"으로) */
const untilOf = (r: Result) => r.events.map((e) => e.endDate ?? e.date).sort().at(-1) ?? null;
/** 확인 대기: 팬 제보만 있거나 원문과 숫자가 안 맞는 일정이 근거에 있음 */
const warnOf = (r: Result) => r.events.some((e) => e.fromSubmission || e.status === 'needs-check');

/** 최근 질문 목록(공개)에 남기기: 키는 시각을 거꾸로 써서 최신순, 90일 보관. 아이디·IP는 남기지 않는다 */
async function logQuestion(kv: KV, now: Date, id: string, qk: string, q: string, r: Result, costUsd: number, cached: boolean) {
  const key = String(9_999_999_999_999 - now.getTime()).padStart(13, '0');
  await kv.put(`asklog:${key}`, JSON.stringify({
    id, qk, q: maskPersonal(q), a: maskPersonal(r.answer).slice(0, 1500), at: now.toISOString(), category: categoryOf(q),
    sources: r.sources.slice(0, 6).map((x) => ({ title: x.title, url: x.url, kind: x.kind, date: x.date })),
    until: untilOf(r), notFound: r.notFound, warn: warnOf(r), costKrw: Math.round(costUsd * 1400 * 100) / 100, cached,
  }), { expirationTtl: 90 * 86400 }).catch(() => {});
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals.runtime?.env ?? {}) as Env;
  if (!env.OPENAI_API_KEY) return json({ ok: false, error: '질문 기능이 아직 준비 중이에요' }, 503);
  if (!env.REPORTS && env.ASK_ALLOW_NO_KV !== '1') return json({ ok: false, error: '질문 기능이 아직 준비 중이에요' }, 503);
  let body: { question?: unknown; website?: unknown; history?: unknown; public?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  }
  if (body.website) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400); // 봇이 채우는 숨은 칸
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 200) : '';
  if (question.length < 2) return json({ ok: false, error: '질문을 적어 주세요' }, 400);
  const isPublic = body.public !== false; // 공개 끄면 최근 질문 목록에 올리지 않는다

  const now = new Date();
  const kstDay = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  const month = kstDay.slice(0, 7);
  const history = Array.isArray(body.history)
    ? body.history.slice(-2).map((t) => ({ q: String((t as { q?: unknown }).q ?? '').slice(0, 200), a: String((t as { a?: unknown }).a ?? '').slice(0, 600) })).filter((t) => t.q && t.a)
    : [];
  const qk = await questionKey(question);
  const kv = env.REPORTS;
  const meta = async (cached: boolean, cachedAt?: string) => {
    if (!kv) return { askedCount: 1, category: categoryOf(question), cached, cachedAt };
    const n = Number((await kv.get(`askcount:${qk}`)) ?? 0) + 1;
    await kv.put(`askcount:${qk}`, String(n), { expirationTtl: 90 * 86400 }).catch(() => {});
    return { askedCount: n, category: categoryOf(question), cached, cachedAt };
  };

  // 같은 질문 답 재사용: 같은 날·같은 질문 자료 버전·이어지는 질문이 아닐 때 (AI를 부르지 않아 0원, 하루 횟수에도 안 셈)
  //   👎가 3개 넘게 쌓인(👍보다 많은) 질문은 재사용하지 않고 새로 답한다
  const dataVer = kv ? (await kv.get('ask:index:version')) ?? '' : '';
  const cacheKey = `askcache:${kstDay}:${dataVer}:${qk}`;
  const [ups, downs] = kv ? await Promise.all([kv.get(`askvote:${qk}:up`), kv.get(`askvote:${qk}:down`)]).then((v) => v.map((x) => Number(x ?? 0))) : [0, 0];
  const disputed = downs >= 3 && downs > ups;
  if (kv && !history.length && !disputed) {
    const hit = await kv.get(cacheKey);
    if (hit) {
      const c = JSON.parse(hit) as Result;
      const id = crypto.randomUUID();
      if (isPublic) await logQuestion(kv, now, id, qk, question, c, 0, true);
      return json({ ok: true, id, ...c, ...(await meta(true, c.at)), warn: warnOf(c) });
    }
  }
  if (kv) {
    // 월 상한: 이번 달 물어보기 비용이 정한 금액(기본 3,000원)을 넘으면 멈춘다 (수집 AI 상한 7,000원과 합쳐 월 1만원)
    const spentUsd = Number((await kv.get(`askcost:${month}`)) ?? 0);
    if (spentUsd * 1400 >= Number(env.ASK_MONTHLY_BUDGET_KRW ?? 3000)) return json({ ok: false, error: '이번 달 질문 한도가 찼어요. 다음 달에 다시 물어봐 주세요' }, 429);
    // 횟수 제한 (IP는 해시로만, 1시간 뒤 사라짐)
    const ip = await sha(request.headers.get('cf-connecting-ip') ?? 'unknown');
    const hourKey = `ask:ip:${ip}:${now.toISOString().slice(0, 13)}`;
    const dayKey = `ask:day:${kstDay}`;
    const [ipCount, dayCount] = await Promise.all([kv.get(hourKey), kv.get(dayKey)]);
    if (Number(ipCount ?? 0) >= 10) return json({ ok: false, error: '질문이 너무 많아요. 잠시 뒤에 다시 물어봐 주세요' }, 429);
    if (Number(dayCount ?? 0) >= Number(env.ASK_DAILY_LIMIT ?? 50)) return json({ ok: false, error: '오늘 질문을 모두 받았어요. 내일 다시 물어봐 주세요' }, 429);
    await Promise.all([
      kv.put(hourKey, String(Number(ipCount ?? 0) + 1), { expirationTtl: 3700 }),
      kv.put(dayKey, String(Number(dayCount ?? 0) + 1), { expirationTtl: 3 * 86400 }),
    ]);
  }

  const index = kv ? await loadIndex(kv) : null;
  if (!index) return json({ ok: false, error: '질문 자료를 준비 중이에요' }, 503);
  try {
    // Supabase 비밀 키가 있으면 하이브리드(낱말 + pgvector 의미 검색), 없으면 낱말 검색만
    let costUsd = 0;
    const r = await askCore(question, index, openai(env.OPENAI_API_KEY), { model: env.ASK_MODEL ?? 'gpt-5-mini', history, vector: supabaseVector(env), onCost: (usd) => { costUsd += usd; } });
    const result: Result = { answer: r.answer, sources: r.sources, unverified: r.unverified, dataAt: index.generatedAt ?? null, events: r.events ?? [], notFound: Boolean(r.notFound), at: now.toISOString() };
    const id = crypto.randomUUID();
    if (kv) {
      // 이번 달 물어보기 비용 쌓기 (월 상한·질문당 비용 기록), 같은 질문 재사용 저장(그날만, 찾지 못한 답은 저장 안 함), 최근 질문 목록
      const prev = Number((await kv.get(`askcost:${month}`)) ?? 0);
      await Promise.all([
        kv.put(`askcost:${month}`, String(prev + costUsd), { expirationTtl: 400 * 86400 }),
        history.length || result.notFound ? Promise.resolve() : kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 }),
        isPublic ? logQuestion(kv, now, id, qk, question, result, costUsd, false) : Promise.resolve(),
      ]).catch(() => {});
    }
    return json({ ok: true, id, ...result, ...(await meta(false)), warn: warnOf(result) });
  } catch {
    return json({ ok: false, error: '답을 만들지 못했어요. 잠시 뒤에 다시 시도해 주세요' }, 502);
  }
};
