/// <reference types="astro/client" />
interface KV {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  SITE_DATA_URL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  GROQ_SMALL_MODEL?: string;
  GROQ_RERANK_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_FALLBACK_MODEL?: string;
  ASK_MODEL?: string;
  ASK_DAILY_LIMIT?: string;
  ASK_ALLOW_NO_KV?: string;
  REPORTS?: KV;
}
type Runtime = import('@astrojs/cloudflare').Runtime<Env>;
declare namespace App {
  interface Locals extends Runtime {}
}
