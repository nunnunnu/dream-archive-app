/** 기존 일정 선택용 검색. DB 전환 중에는 public_events를 먼저 보고, 아직 없으면 공개 events.json을 사용한다. */
import type { APIRoute } from 'astro';
import { loadPublic } from '../../../lib/data';

interface EventRow {
  id: string; date: string; time: string | null; endDate?: string | null; end_date?: string | null;
  endTime?: string | null; end_time?: string | null; title: string; step: string; members: string[];
}
type Env = { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const norm = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const shape = (e: EventRow) => ({ id: e.id, date: e.date, time: e.time, endDate: e.endDate ?? e.end_date ?? null, endTime: e.endTime ?? e.end_time ?? null, title: e.title, step: e.step, members: e.members ?? [] });

export const GET: APIRoute = async ({ request, locals }) => {
  const q = new URL(request.url).searchParams.get('q')?.trim().slice(0, 80) ?? '';
  if (q.length < 2) return json({ events: [] });
  const env = (locals.runtime?.env ?? {}) as Env;
  let rows: EventRow[] = [];
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
    const query = new URLSearchParams({ select: 'id,date,time,end_date,end_time,title,step,members', order: 'date.desc', limit: '20', or: `(title.ilike.*${q.replace(/[,*()]/g, '')}*,step.ilike.*${q.replace(/[,*()]/g, '')}*)` });
    const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/public_events?${query}`, { headers }).catch(() => null);
    if (res?.ok) rows = await res.json() as EventRow[];
  }
  if (!rows.length) {
    const data = await loadPublic<{ events: EventRow[] }>(locals, 'events.json', { events: [] });
    const needle = norm(q);
    rows = data.events.filter((e) => norm(`${e.date} ${e.title} ${e.step} ${e.members.join(' ')}`).includes(needle)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  }
  return json({ events: rows.map(shape) });
};
