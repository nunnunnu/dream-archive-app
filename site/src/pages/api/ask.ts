/**
 * 팬 질문 (Astro API, Cloudflare에서 실행): POST /api/ask  { question }
 * 자료(일정·공지·기사)는 수집기가 KV에 올린 ask:index 를 쓰고, 답은 OpenAI로 만든다 (collector/lib/ask-core.ts 와 같은 규칙).
 * 비용 지키기: 질문 200자까지, 같은 IP는 1시간에 10번, 전체는 하루 ASK_DAILY_LIMIT번(기본 50, 질문 1번 약 5원). 횟수는 KV(REPORTS)에 센다.
 * KV가 없으면 운영에서는 받지 않는다 (로컬 시험은 ASK_ALLOW_NO_KV=1).
 */
import type { APIRoute } from 'astro';
import { askCore, supabaseVector, type AskCall, type AskData } from '../../../../collector/lib/ask-core.ts';

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

interface KV {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; OPENAI_API_KEY?: string; ASK_MODEL?: string; ASK_DAILY_LIMIT?: string; ASK_ALLOW_NO_KV?: string; REPORTS?: KV }

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
  const r = (await res.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[]; usage?: { input_tokens: number; output_tokens: number } };
  const value = (r.output ?? []).filter((x) => x.type === 'message').flatMap((x) => x.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
  const p = PRICES[o.model] ?? PRICES['gpt-5-mini'];
  return { value, usage: { costUsd: ((r.usage?.input_tokens ?? 0) * p.input + (r.usage?.output_tokens ?? 0) * p.output) / 1e6 } };
};

async function sha(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals.runtime?.env ?? {}) as Env;
  if (!env.OPENAI_API_KEY) return json({ ok: false, error: '질문 기능이 아직 준비 중이에요' }, 503);
  if (!env.REPORTS && env.ASK_ALLOW_NO_KV !== '1') return json({ ok: false, error: '질문 기능이 아직 준비 중이에요' }, 503);
  let body: { question?: unknown; website?: unknown; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  }
  if (body.website) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400); // 봇이 채우는 숨은 칸
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 200) : '';
  if (question.length < 2) return json({ ok: false, error: '질문을 적어 주세요' }, 400);

  // 횟수 제한 (IP는 해시로만, 1시간 뒤 사라짐)
  const now = new Date();
  const kstDay = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  if (env.REPORTS) {
    const ip = await sha(request.headers.get('cf-connecting-ip') ?? 'unknown');
    const hourKey = `ask:ip:${ip}:${now.toISOString().slice(0, 13)}`;
    const dayKey = `ask:day:${kstDay}`;
    const [ipCount, dayCount] = await Promise.all([env.REPORTS.get(hourKey), env.REPORTS.get(dayKey)]);
    if (Number(ipCount ?? 0) >= 10) return json({ ok: false, error: '질문이 너무 많아요. 잠시 뒤에 다시 물어봐 주세요' }, 429);
    if (Number(dayCount ?? 0) >= Number(env.ASK_DAILY_LIMIT ?? 50)) return json({ ok: false, error: '오늘 질문을 모두 받았어요. 내일 다시 물어봐 주세요' }, 429);
    await Promise.all([
      env.REPORTS.put(hourKey, String(Number(ipCount ?? 0) + 1), { expirationTtl: 3700 }),
      env.REPORTS.put(dayKey, String(Number(dayCount ?? 0) + 1), { expirationTtl: 3 * 86400 }),
    ]);
  }

  const index = env.REPORTS ? await loadIndex(env.REPORTS) : null;
  if (!index) return json({ ok: false, error: '질문 자료를 준비 중이에요' }, 503);
  try {
    const history = Array.isArray(body.history)
      ? body.history.slice(-2).map((t) => ({ q: String((t as { q?: unknown }).q ?? '').slice(0, 200), a: String((t as { a?: unknown }).a ?? '').slice(0, 600) })).filter((t) => t.q && t.a)
      : [];
    // Supabase 비밀 키가 있으면 하이브리드(낱말 + pgvector 의미 검색), 없으면 낱말 검색만
    const r = await askCore(question, index, openai(env.OPENAI_API_KEY), { model: env.ASK_MODEL ?? 'gpt-5-mini', history, vector: supabaseVector(env) });
    return json({
      ok: true, id: crypto.randomUUID(), answer: r.answer, sources: r.sources, unverified: r.unverified,
      dataAt: index.generatedAt ?? null,
    });
  } catch {
    return json({ ok: false, error: '답을 만들지 못했어요. 잠시 뒤에 다시 시도해 주세요' }, 502);
  }
};
