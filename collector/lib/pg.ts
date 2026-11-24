/**
 * Supabase Postgres (REST, SDK 없이). 수집 상태 저장용 (db/state.sql).
 * service_role(비밀) 키로만 읽고 쓴다. 테이블은 RLS가 켜져 있고 공개 정책이 없다.
 * STORE=pg 이면 수집기가 JSON 파일 대신 여기에 저장한다 (collector/lib/repo.ts, videoStore.ts).
 */
export const usePg = () => process.env.STORE === 'pg';

const base = () => `${(process.env.SUPABASE_URL ?? '').replace(/\/$/, '')}/rest/v1`;
const headers = () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
};

/** 조건에 맞는 행 전부 (1,000개씩 나눠 읽음). query 예: "select=data&published_at=gte.2026-01-01" */
export async function pgSelect<T>(table: string, query: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${base()}/${table}?${query}`, { headers: { ...headers(), 'range-unit': 'items', range: `${from}-${from + 999}` } });
    if (!res.ok) throw new Error(`DB 읽기 실패 ${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/** 행 넣기·바꾸기 (같은 키면 덮어씀). 200개씩 나눠 보낸다 */
export async function pgUpsert(table: string, rows: Record<string, unknown>[], onConflict: string, chunk = 200): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const res = await fetch(`${base()}/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { ...headers(), prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + chunk)),
    });
    if (!res.ok) throw new Error(`DB 저장 실패 ${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** 조건에 맞는 행의 몇 칸만 바꾸기. where 예: "id=in.(a,b)" */
export async function pgPatch(table: string, where: string, values: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base()}/${table}?${where}`, { method: 'PATCH', headers: { ...headers(), prefer: 'return=minimal' }, body: JSON.stringify(values) });
  if (!res.ok) throw new Error(`DB 저장 실패 ${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** 문자열 안의 짝 없는 문자(이모지 반쪽)는 JSON 저장을 깨뜨리므로 뺀다 */
export const pgClean = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/gi, ''));

/** 테이블 행 수 */
export async function pgCount(table: string): Promise<number> {
  const res = await fetch(`${base()}/${table}?select=*&limit=1`, { headers: { ...headers(), prefer: 'count=exact' } });
  return Number(res.headers.get('content-range')?.split('/')[1] ?? 0);
}
