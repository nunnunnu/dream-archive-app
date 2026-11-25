/** Groq 무료 모델 우선, OpenAI 유료 모델은 일시 장애·무료 한도 초과 때만 쓰는 공통 호출기. */
export interface AiEnv {
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  GROQ_SMALL_MODEL?: string;
  GROQ_RERANK_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_FALLBACK_MODEL?: string;
}

export interface AiRequest {
  instructions: string;
  input: string;
  schema?: { name: string; schema: object };
  images?: string[];
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
  fallbackModel?: string;
  primaryModel?: string;
}

export interface AiResult {
  value: string;
  usage: { input: number; output: number; costUsd: number };
  provider: 'groq' | 'openai';
  model: string;
}

const GROQ_MODEL = 'qwen/qwen3.8-27b';
const OPENAI_MODEL = 'gpt-5-mini';
const PRICES: Record<string, { input: number; output: number }> = {
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
};

/** 이 실행(프로세스)에서 AI를 부른 횟수. 실패도 센다 (Budget 실행당 상한이 실패한 호출 때문에 끝없이 돌지 않게) */
export const aiStats = { attempts: 0 };
// OpenAI 잔액 없음(insufficient_quota)이면 10분 동안은 부르지 않고 바로 실패 (충전 뒤에는 저절로 다시 부른다)
let openaiOutUntil = 0;
export const openaiQuotaOut = () => Date.now() < openaiOutUntil;
// Groq 하루 토큰 한도(TPD)에 걸린 모델은 알려 준 시각까지 건너뛰고 바로 예비로
const groqOutUntil = new Map<string, number>();
/** "Please try again in 1h2m3.5s" → 밀리초 */
export const retryAfterMs = (text: string) => {
  const m = text.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  return m ? ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000 : 0;
};

export class AiHttpError extends Error {
  constructor(public provider: 'groq' | 'openai', public status: number, message: string) {
    super(message);
  }
}

const clean = (t: string) => t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
// 413: 요청 하나가 Groq 무료 등급의 분당 토큰 한도보다 큼 → 기다려도 안 되니 OpenAI로
const retryable = (e: unknown) => !(e instanceof AiHttpError) || e.status === 408 || e.status === 409 || e.status === 413 || e.status === 429 || e.status >= 500;
/** 달러 비용. batch: OpenAI Batch API는 절반 값 */
export const usageCost = (model: string, input: number, output: number, cached = 0, batch = false) => {
  const p = PRICES[model] ?? { input: 0, output: 0 };
  return ((input - cached) * p.input + cached * p.input * 0.1 + output * p.output) / 1_000_000 * (batch ? 0.5 : 1);
};

async function groq(env: AiEnv, req: AiRequest): Promise<AiResult> {
  const model = req.primaryModel ?? env.GROQ_MODEL ?? GROQ_MODEL;
  if ((groqOutUntil.get(model) ?? 0) > Date.now()) throw new AiHttpError('groq', 429, `Groq ${model} 하루 한도 초과 (풀릴 때까지 건너뜀)`);
  const userContent: unknown = req.images?.length
    ? [{ type: 'text', text: clean(req.input) }, ...req.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : clean(req.input);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(180_000),
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: clean(req.instructions) }, { role: 'user', content: userContent }],
      max_completion_tokens: req.maxOutputTokens ?? 8000,
      ...(model.startsWith('qwen/')
        ? (req.effort === 'low' || req.effort === 'minimal' ? { reasoning_effort: 'none' } : { reasoning_effort: req.effort })
        : { reasoning_effort: req.effort === 'high' ? 'high' : req.effort === 'medium' ? 'medium' : 'low' }),
      ...(req.schema ? { response_format: { type: 'json_schema', json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } } } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429 && /tokens per day|requests per day|\(TPD\)|\(RPD\)/i.test(text)) groqOutUntil.set(model, Date.now() + Math.max(retryAfterMs(text), 60_000));
    throw new AiHttpError('groq', res.status, `Groq 요청 실패 ${res.status}: ${text.slice(0, 240)}`);
  }
  const body = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const value = body.choices?.[0]?.message?.content ?? '';
  if (!value.trim()) throw new Error('Groq 응답이 비었어요');
  if (req.schema) JSON.parse(value);
  return { value, usage: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0, costUsd: 0 }, provider: 'groq', model };
}

/** OpenAI Responses API 요청 본문 (바로 부를 때와 Batch 줄에 똑같이 쓴다) */
export function openaiBody(model: string, req: AiRequest) {
  const userContent: unknown = req.images?.length
    ? [{ type: 'input_text', text: clean(req.input) }, ...req.images.map((image_url) => ({ type: 'input_image', image_url, detail: 'high' }))]
    : clean(req.input);
  return {
    model, reasoning: { effort: req.effort ?? 'low' }, max_output_tokens: req.maxOutputTokens ?? 8000,
    input: [{ role: 'system', content: clean(req.instructions) }, { role: 'user', content: userContent }],
    ...(req.schema ? { text: { format: { type: 'json_schema', name: req.schema.name, schema: req.schema.schema, strict: true } } } : {}),
  };
}

type OpenAiResponseBody = { status?: string; incomplete_details?: { reason?: string }; output?: { type: string; content?: { type: string; text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } };
/** Responses API 응답 → 글과 사용량 (잘렸거나 JSON이 깨졌으면 오류) */
export function readOpenAiResponse(model: string, body: OpenAiResponseBody, req: Pick<AiRequest, 'schema'>, batch = false): AiResult {
  if (body.status === 'incomplete') throw new Error(`OpenAI 응답이 잘림: ${body.incomplete_details?.reason}`);
  const value = (body.output ?? []).filter((x) => x.type === 'message').flatMap((x) => x.content ?? []).filter((x) => x.type === 'output_text').map((x) => x.text ?? '').join('');
  if (req.schema) JSON.parse(value);
  const input = body.usage?.input_tokens ?? 0, output = body.usage?.output_tokens ?? 0;
  return { value, usage: { input, output, costUsd: usageCost(model, input, output, body.usage?.input_tokens_details?.cached_tokens ?? 0, batch) }, provider: 'openai', model };
}

async function openai(env: AiEnv, req: AiRequest): Promise<AiResult> {
  const model = req.fallbackModel ?? env.OPENAI_FALLBACK_MODEL ?? OPENAI_MODEL;
  if (openaiQuotaOut()) throw new AiHttpError('openai', 429, 'OpenAI 잔액 없음 (충전 전까지 부르지 않음)');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', signal: AbortSignal.timeout(180_000),
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(openaiBody(model, req)),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429 && /insufficient_quota|no credits remaining/i.test(text)) {
      if (!openaiQuotaOut()) console.warn('OpenAI 잔액이 없어요. 10분 동안 OpenAI를 부르지 않아요 (https://platform.openai.com/settings/organization/billing/)');
      openaiOutUntil = Date.now() + 10 * 60_000;
    }
    throw new AiHttpError('openai', res.status, `OpenAI 요청 실패 ${res.status}: ${text.slice(0, 240)}`);
  }
  return readOpenAiResponse(model, await res.json() as OpenAiResponseBody, req);
}

export async function callAi(env: AiEnv, req: AiRequest): Promise<AiResult> {
  aiStats.attempts++;
  if (env.GROQ_API_KEY) {
    try {
      return await groq(env, req);
    } catch (e) {
      if (!env.OPENAI_API_KEY || !retryable(e)) throw e;
      // 잔액이 없으면 예비도 소용없으니 Groq 오류를 그대로 (로그도 한 번만 남게)
      if (openaiQuotaOut()) throw e;
      if (!(e instanceof Error && e.message.includes('건너뜀'))) console.warn(`Groq 실패, OpenAI 예비 모델 사용: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (env.OPENAI_API_KEY) return openai(env, req);
  throw new Error('GROQ_API_KEY 또는 OPENAI_API_KEY가 필요해요');
}

export const hasAiKey = (env: AiEnv) => Boolean(env.GROQ_API_KEY || env.OPENAI_API_KEY);
export const primaryModel = (env: AiEnv) => env.GROQ_API_KEY ? (env.GROQ_MODEL ?? GROQ_MODEL) : (env.OPENAI_FALLBACK_MODEL ?? OPENAI_MODEL);
