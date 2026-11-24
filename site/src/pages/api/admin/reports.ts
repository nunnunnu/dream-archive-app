/**
 * 어드민 제보 확인 (로그인한 운영자만, middleware.ts가 확인)
 *  GET  /api/admin/reports           확인 대기 제보 + 최근 처리한 제보 + 아직 반영 안 된 결정
 *  POST /api/admin/reports {id, action: 'approve'|'reject', note?}
 *       결정은 Supabase reports.decision 칸에 적어 두고, 다음 수집(15~30분)이 반영한다 (collector/lib/reports.ts applyReportDecisions)
 */
import type { APIRoute } from 'astro';
import { db, dbReady, reportFromRow, type DbEnv, type Report } from '../../../lib/reports-db';

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
  const action = b.action === 'approve' || b.action === 'reject' || b.action === 'cancel' ? b.action : null;
  if (!id || !action) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
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
