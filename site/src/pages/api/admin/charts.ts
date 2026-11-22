/**
 * 어드민 응원법 채보 (로그인한 운영자만, middleware.ts가 확인)
 *  GET  /api/admin/charts            채보 목록 (요약)
 *  GET  /api/admin/charts?id=<곡ID>   채보 하나 전체
 *  POST /api/admin/charts {chart}                    검사 후 KV chart:<곡ID> 에 저장 (바로 전 저장본은 chart-prev:<곡ID>)
 *  POST /api/admin/charts {action:'delete', songId}  지우기 (지운 것도 chart-prev:<곡ID> 에 30일 남김)
 * verified 가 켜진 채보만 다음 수집 때 publish:site 가 fanchant/ 로 공개한다.
 */
import type { APIRoute } from 'astro';
import { loadPublic } from '../../../lib/data';
import { checkChart, indexEntry, SONG_ID, type FanchantChart } from '../../../lib/fanchant';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const PREV_TTL = 30 * 86400;
const MAX_BODY = 400_000;

export const GET: APIRoute = async ({ url, locals }) => {
  const kv = locals.runtime?.env?.REPORTS;
  if (!kv) return json({ ok: false, error: 'KV가 없어요' }, 503);
  const id = url.searchParams.get('id');
  if (id) {
    if (!SONG_ID.test(id)) return json({ ok: false, error: '곡 ID가 올바르지 않아요' }, 400);
    const chart = await kv.get<FanchantChart>(`chart:${id}`, 'json');
    return chart ? json({ ok: true, chart }) : json({ ok: false, error: '그 채보가 없어요' }, 404);
  }
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'chart:', limit: 1000, cursor });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const charts = (await Promise.all(names.map((k) => kv.get<FanchantChart>(k, 'json').catch(() => null)))).filter((c): c is FanchantChart => Boolean(c?.songId));
  const list = charts
    .map((c) => ({ ...indexEntry(c), updatedAt: c.updatedAt ?? '', updatedBy: c.updatedBy ?? '', emptyText: c.cues.filter((q) => !q.text).length }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return json({ ok: true, charts: list });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const kv = locals.runtime?.env?.REPORTS;
  if (!kv) return json({ ok: false, error: 'KV가 없어요' }, 503);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: '채보가 너무 커요' }, 413);
  let b: { action?: unknown; songId?: unknown; chart?: unknown; baseUpdatedAt?: unknown; force?: unknown };
  try { b = JSON.parse(text); } catch { return json({ ok: false, error: '형식이 올바르지 않아요' }, 400); }
  const by = locals.admin?.email ?? '';

  if (b.action === 'delete') {
    const id = typeof b.songId === 'string' && SONG_ID.test(b.songId) ? b.songId : null;
    if (!id) return json({ ok: false, error: '곡 ID가 올바르지 않아요' }, 400);
    const cur = await kv.get(`chart:${id}`);
    if (!cur) return json({ ok: false, error: '그 채보가 없어요' }, 404);
    await kv.put(`chart-prev:${id}`, cur, { expirationTtl: PREV_TTL });
    await kv.delete(`chart:${id}`);
    return json({ ok: true });
  }

  const members = await loadPublic<{ members?: { slug: string }[] }>(locals, 'members.json', {}).catch(() => ({ members: [] }));
  const checked = checkChart(b.chart, { memberSlugs: (members.members ?? []).map((m) => m.slug) });
  if (!checked.chart) return json({ ok: false, error: checked.errors.join(' · '), errors: checked.errors, warnings: checked.warnings }, 400);
  const key = `chart:${checked.chart.songId}`;
  const cur = await kv.get<FanchantChart>(key, 'json');
  // 다른 기기·창에서 먼저 저장한 게 있으면 덮어쓰기 전에 묻는다
  const base = typeof b.baseUpdatedAt === 'string' ? b.baseUpdatedAt : '';
  if (cur && b.force !== true && (cur.updatedAt ?? '') !== base) {
    return json({ ok: false, conflict: true, error: base ? '다른 곳에서 먼저 저장한 채보가 있어요' : '같은 곡 ID의 채보가 이미 있어요', updatedAt: cur.updatedAt ?? '', updatedBy: cur.updatedBy ?? '' }, 409);
  }
  const chart: FanchantChart = { ...checked.chart, updatedAt: new Date().toISOString(), updatedBy: by };
  if (cur) await kv.put(`chart-prev:${chart.songId}`, JSON.stringify(cur), { expirationTtl: PREV_TTL });
  await kv.put(key, JSON.stringify(chart));
  return json({ ok: true, chart, warnings: checked.warnings });
};
