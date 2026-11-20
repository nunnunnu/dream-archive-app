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

export class AiHttpError extends Error {
  constructor(public provider: 'groq' | 'openai', public status: number, message: string) {
    super(message);
  }
}

const clean = (t: string) => t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
const retryable = (e: unknown) => !(e instanceof AiHttpError) || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
const usageCost = (model: string, input: number, output: number, cached = 0) => {
  const p = PRICES[model] ?? { input: 0, output: 0 };
  return ((input - cached) * p.input + cached * p.input * 0.1 + output * p.output) / 1_000_000;
};

async function groq(env: AiEnv, req: AiRequest): Promise<AiResult> {
  const model = req.primaryModel ?? env.GROQ_MODEL ?? GROQ_MODEL;
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
  if (!res.ok) throw new AiHttpError('groq', res.status, `Groq 요청 실패 ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const body = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const value = body.choices?.[0]?.message?.content ?? '';
  if (!value.trim()) throw new Error('Groq 응답이 비었어요');
  if (req.schema) JSON.parse(value);
  return { value, usage: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0, costUsd: 0 }, provider: 'groq', model };
}

async function openai(env: AiEnv, req: AiRequest): Promise<AiResult> {
  const model = req.fallbackModel ?? env.OPENAI_FALLBACK_MODEL ?? OPENAI_MODEL;
  const userContent: unknown = req.images?.length
    ? [{ type: 'input_text', text: clean(req.input) }, ...req.images.map((image_url) => ({ type: 'input_image', image_url, detail: 'high' }))]
    : clean(req.input);
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', signal: AbortSignal.timeout(180_000),
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, reasoning: { effort: req.effort ?? 'low' }, max_output_tokens: req.maxOutputTokens ?? 8000,
      input: [{ role: 'system', content: clean(req.instructions) }, { role: 'user', content: userContent }],
      ...(req.schema ? { text: { format: { type: 'json_schema', name: req.schema.name, schema: req.schema.schema, strict: true } } } : {}),
    }),
  });
  if (!res.ok) throw new AiHttpError('openai', res.status, `OpenAI 요청 실패 ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const body = await res.json() as { status?: string; incomplete_details?: { reason?: string }; output?: { type: string; content?: { type: string; text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } };
  if (body.status === 'incomplete') throw new Error(`OpenAI 응답이 잘림: ${body.incomplete_details?.reason}`);
  const value = (body.output ?? []).filter((x) => x.type === 'message').flatMap((x) => x.content ?? []).filter((x) => x.type === 'output_text').map((x) => x.text ?? '').join('');
  if (req.schema) JSON.parse(value);
  const input = body.usage?.input_tokens ?? 0, output = body.usage?.output_tokens ?? 0;
  return { value, usage: { input, output, costUsd: usageCost(model, input, output, body.usage?.input_tokens_details?.cached_tokens ?? 0) }, provider: 'openai', model };
}

export async function callAi(env: AiEnv, req: AiRequest): Promise<AiResult> {
  if (env.GROQ_API_KEY) {
    try {
      return await groq(env, req);
    } catch (e) {
      if (!env.OPENAI_API_KEY || !retryable(e)) throw e;
      console.warn(`Groq 실패, OpenAI 예비 모델 사용: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (env.OPENAI_API_KEY) return openai(env, req);
  throw new Error('GROQ_API_KEY 또는 OPENAI_API_KEY가 필요해요');
}

export const hasAiKey = (env: AiEnv) => Boolean(env.GROQ_API_KEY || env.OPENAI_API_KEY);
export const primaryModel = (env: AiEnv) => env.GROQ_API_KEY ? (env.GROQ_MODEL ?? GROQ_MODEL) : (env.OPENAI_FALLBACK_MODEL ?? OPENAI_MODEL);
