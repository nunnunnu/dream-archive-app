/**
 * 제보 저장소: Supabase reports 테이블 (db/state2.sql). 사이트 서버에서만 비밀 키로 읽고 쓴다.
 * 행 모양은 수집기 collector/lib/repo.ts reportToRow·reportFromRow 와 같아야 한다.
 */
export interface DbEnv { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string }
export interface Report { id: string; type: string; status: string; createdAt: string; reviewedAt?: string; reviewMode?: string; reviewReason?: string; [k: string]: unknown }
interface ReportRow {
  id: string; type: string; event_id: string | null; event_snapshot: Record<string, unknown> | null; title: string | null; source_url: string | null;
  proposed_changes: Record<string, unknown> | null; message: string | null; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
  decision?: unknown;
}

export const dbReady = (env: DbEnv) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

export async function db(env: DbEnv, path: string, init: RequestInit & { prefer?: string } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const res = await fetch(`${(env.SUPABASE_URL ?? '').replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.prefer ? { prefer: init.prefer } : {}) },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

export function reportToRow(r: Record<string, unknown>) {
  const { id, type, url, message, eventId, eventTitle, status, createdAt, reviewedAt, reviewReason, ...rest } = r;
  return {
    id, type, event_id: eventId ?? null, title: eventTitle ?? null, source_url: url ?? null, message: message ?? null,
    event_snapshot: eventId ? { eventTitle, date: rest.date, time: rest.time, members: rest.members } : null,
    proposed_changes: rest, status: status ?? 'pending', review_reason: reviewReason ?? null,
    created_at: createdAt ?? new Date().toISOString(), reviewed_at: reviewedAt ?? null,
  };
}

export function reportFromRow(r: ReportRow): Report {
  return {
    ...(r.proposed_changes ?? {}), id: r.id, type: r.type, url: r.source_url ?? '', message: r.message ?? '', eventId: r.event_id ?? undefined, eventTitle: r.title ?? undefined,
    status: r.status, createdAt: r.created_at, ...(r.reviewed_at ? { reviewedAt: r.reviewed_at } : {}), ...(r.review_reason ? { reviewReason: r.review_reason } : {}),
  };
}
