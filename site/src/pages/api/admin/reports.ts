/**
 * 어드민 제보 확인 (로그인한 운영자만, middleware.ts가 확인)
 *  GET  /api/admin/reports           확인 대기 제보 + 최근 처리한 제보 + 아직 반영 안 된 결정
 *  POST /api/admin/reports {id, action: 'approve'|'reject', note?}
 *       결정은 KV report-decision:<id> 에 적어 두고, 다음 수집(15~30분)이 반영한다 (collector/lib/reports.ts applyReportDecisions)
 */
import type { APIRoute } from 'astro';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
interface Report { id: string; type: string; status: string; createdAt: string; reviewedAt?: string; reviewMode?: string; reviewReason?: string; [k: string]: unknown }

async function listAll(kv: KV, prefix: string) {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, limit: 1000, cursor });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

export const GET: APIRoute = async ({ locals }) => {
  const kv = locals.runtime?.env?.REPORTS;
  if (!kv) return json({ ok: false, error: 'KV가 없어요' }, 503);
  const [reportKeys, decisionKeys] = await Promise.all([listAll(kv, 'report:'), listAll(kv, 'report-decision:')]);
  const reports = (await Promise.all(reportKeys.map((k) => kv.get<Report>(k, 'json').catch(() => null)))).filter((r): r is Report => Boolean(r?.id));
  const decisions = Object.fromEntries((await Promise.all(decisionKeys.map(async (k) => [k.slice('report-decision:'.length), await kv.get(k, 'json').catch(() => null)] as const))).filter(([, v]) => v));
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const pending = reports.filter((r) => r.status === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recent = reports
    .filter((r) => r.status !== 'pending' && (r.reviewedAt ?? r.createdAt) >= since)
    .sort((a, b) => (b.reviewedAt ?? b.createdAt).localeCompare(a.reviewedAt ?? a.createdAt))
    .slice(0, 30);
  return json({ ok: true, pending, recent, decisions });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const kv = locals.runtime?.env?.REPORTS;
  if (!kv) return json({ ok: false, error: 'KV가 없어요' }, 503);
  let b: { id?: unknown; action?: unknown; note?: unknown };
  try { b = await request.json(); } catch { return json({ ok: false, error: '형식이 올바르지 않아요' }, 400); }
  const id = typeof b.id === 'string' && /^[\w-]{4,40}$/.test(b.id) ? b.id : null;
  const action = b.action === 'approve' || b.action === 'reject' || b.action === 'cancel' ? b.action : null;
  if (!id || !action) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  const r = await kv.get<Report>(`report:${id}`, 'json');
  if (!r) return json({ ok: false, error: '없는 제보예요' }, 404);
  if (action === 'cancel') {
    await kv.delete(`report-decision:${id}`);
    return json({ ok: true });
  }
  if (r.status !== 'pending') return json({ ok: false, error: '이미 처리된 제보예요' }, 409);
  const decision = { action, note: typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '', at: new Date().toISOString(), by: locals.admin?.email ?? '' };
  await kv.put(`report-decision:${id}`, JSON.stringify(decision), { expirationTtl: 30 * 86400 });
  // 다음 15·45분 빠른 실행도 돌도록 (새 제보와 같은 신호)
  await kv.put('pending-reports', id);
  return json({ ok: true, decision });
};
