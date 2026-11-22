/// <reference types="astro/client" />
interface KV {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
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
  /** 어드민 로그인(Cloudflare Access): 팀 도메인(예: xxx.cloudflareaccess.com)과 앱 AUD 태그. 비밀값 아님 */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** 어드민을 여는 주소 (Access가 걸린 곳). 다른 주소로 온 /admin 은 여기로 넘긴다 */
  ADMIN_HOST?: string;
}
type Runtime = import('@astrojs/cloudflare').Runtime<Env>;
declare namespace App {
  interface Locals extends Runtime {
    /** 어드민 경로에서 로그인 확인을 통과한 운영자 */
    admin?: { email: string };
  }
}
