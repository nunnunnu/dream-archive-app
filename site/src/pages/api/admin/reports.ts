/**
 * 어드민 제보 확인 (로그인한 운영자만, middleware.ts가 확인)
 *  GET  /api/admin/reports           확인 대기 제보 + 최근 처리한 제보 + 아직 반영 안 된 결정
 *  POST /api/admin/reports {id, action: 'approve'|'reject'|'cancel', note?}
 *  POST /api/admin/reports {id, action: 'toEvent'}  소식 제보를 일정 제보(add)로도 하나 더 만든다 (소식은 그대로, 새 일정 제보는 승인 결정까지 붙여서)
 *       결정은 Supabase reports.decision 칸에 적어 두고, 다음 수집(15~30분)이 반영한다 (collector/lib/reports.ts applyReportDecisions)
 */
import type { APIRoute } from 'astro';
import { db, dbReady, reportFromRow, reportToRow, type DbEnv, type Report } from '../../../lib/reports-db';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
type Env = DbEnv & { REPORTS?: KV };
const envOf = (locals: App.Locals) => (locals.runtime?.env ?? {}) as Env;

export const GET: APIRoute = async ({ locals }) => {
  const env = envOf(locals);
  if (!dbReady(env)) return json({ ok: false, error: 'DB 설정이 없어요' }, 503);
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const [pendingRows, recentRows] = await Promise.all([
    db(env, 'reports?select=*&status=eq.pending&order=created_at.desc').then((r) => r.json()),
    // 처리 시각 기준 최근 14일: 넉넉히 60일 안에 들어온 것을 읽어서 거른다
    db(env, `reports?select=*&status=neq.pending&created_at=gte.${encodeURIComponent(new Date(Date.now() - 60 * 864e5).toISOString())}&order=created_at.desc&limit=500`).then((r) => r.json()),
  ]) as [Parameters<typeof reportFromRow>[0][], Parameters<typeof reportFromRow>[0][]];
  const pending: Report[] = pendingRows.map(reportFromRow);
  const recent: Report[] = recentRows.map(reportFromRow)
    .filter((r) => (r.reviewedAt ?? r.createdAt) >= since)
    .sort((a, b) => (b.reviewedAt ?? b.createdAt).localeCompare(a.reviewedAt ?? a.createdAt))
    .slice(0, 30);
  const decisions = Object.fromEntries(pendingRows.filter((r) => r.decision).map((r) => [r.id, r.decision]));
  return json({ ok: true, pending, recent, decisions });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envOf(locals);
  if (!dbReady(env)) return json({ ok: false, error: 'DB 설정이 없어요' }, 503);
  let b: { id?: unknown; action?: unknown; note?: unknown };
  try { b = await request.json(); } catch { return json({ ok: false, error: '형식이 올바르지 않아요' }, 400); }
  const id = typeof b.id === 'string' && /^[\w-]{4,40}$/.test(b.id) ? b.id : null;
  const action = b.action === 'approve' || b.action === 'reject' || b.action === 'cancel' || b.action === 'toEvent' ? b.action : null;
  if (!id || !action) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  if (action === 'toEvent') return toEvent(env, id, locals.admin?.email ?? '');
  const [r] = await (await db(env, `reports?select=id,status&id=eq.${id}`)).json() as { id: string; status: string }[];
  if (!r) return json({ ok: false, error: '없는 제보예요' }, 404);
  if (action === 'cancel') {
    await db(env, `reports?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ decision: null }), prefer: 'return=minimal' });
    return json({ ok: true });
  }
  if (r.status !== 'pending') return json({ ok: false, error: '이미 처리된 제보예요' }, 409);
  const decision = { action, note: typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '', at: new Date().toISOString(), by: locals.admin?.email ?? '' };
  await db(env, `reports?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ decision }), prefer: 'return=minimal' });
  // 다음 15·45분 빠른 실행도 돌도록 (새 제보와 같은 신호, 이미 켜져 있으면 다시 쓰지 않음)
  try { if (env.REPORTS && !(await env.REPORTS.get('pending-reports'))) await env.REPORTS.put('pending-reports', id); } catch { /* 정시 수집이 처리 */ }
  return json({ ok: true, decision });
};

/** 소식 제보 → 같은 내용의 일정 제보(add). id 는 원래 id + 'e' 라서 두 번 눌러도 하나만 생긴다 */
async function toEvent(env: Env, id: string, by: string) {
  const [row] = await (await db(env, `reports?select=*&id=eq.${id}`)).json() as Parameters<typeof reportFromRow>[0][];
  if (!row) return json({ ok: false, error: '없는 제보예요' }, 404);
  const r = reportFromRow(row);
  if (r.type !== 'news') return json({ ok: false, error: '소식 제보만 일정으로 넣을 수 있어요' }, 400);
  const eventId = `${id}e`;
  const [exists] = await (await db(env, `reports?select=id&id=eq.${eventId}`)).json() as unknown[];
  if (exists) return json({ ok: false, error: '이미 일정으로 넣었어요' }, 409);
  const pick = (k: string) => (typeof r[k] === 'string' ? r[k] as string : '');
  const title = pick('title') || String(r.message ?? '').slice(0, 80);
  if (!title) return json({ ok: false, error: '제목이 없어서 일정으로 넣을 수 없어요' }, 400);
  const now = new Date().toISOString();
  const report = {
    id: eventId, type: 'add', title, url: pick('url'), message: pick('message'), eventId: '', eventTitle: '',
    date: pick('date'), time: pick('time'), endDate: pick('endDate'), endTime: pick('endTime'),
    members: Array.isArray(r.members) ? r.members : [], fromNews: id, status: 'pending', createdAt: now,
  };
  // 운영자가 일정이라고 본 것이니 승인 결정을 같이 적는다 (다음 수집이 링크를 읽어 일정으로 넣음)
  const decision = { action: 'approve', note: `소식 제보 ${id}에서 일정으로`, at: now, by };
  await db(env, 'reports', { method: 'POST', body: JSON.stringify({ ...reportToRow(report), decision }), prefer: 'return=minimal' });
  try { if (env.REPORTS && !(await env.REPORTS.get('pending-reports'))) await env.REPORTS.put('pending-reports', eventId); } catch { /* 정시 수집이 처리 */ }
  return json({ ok: true, id: eventId });
}
