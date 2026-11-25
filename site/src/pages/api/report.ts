/**
 * 제보 받기 (Astro API, Cloudflare에서 실행): POST /api/report
 * 받은 제보는 Supabase reports 테이블에 저장한다 (KV는 무료 쓰기 한도가 하루 1,000번이라 옮김). 공식 원문 대조를 통과한 추가·보완 제보는 수집기가 자동 승인하고,
 * 그 밖의 제보와 삭제 요청은 운영자가 확인한다. 삭제 요청은 일정 또는 소식(target: 'news', newsUrl).
 * 개인정보는 받지 않는다.
 *  - 한 건: { type, title, ... } → 같은 IP(해시)에서 1분에 5건까지
 *  - 여러 건(Grok 등 자동 제보): [{...}, {...}] 최대 50건, Authorization: Bearer <REPORT_BULK_TOKEN> 이 있어야 하고 횟수 제한 없음.
 *    답은 { ok, saved, results: [{ ok, id } | { ok: false, error }] } (보낸 순서대로)
 */
import type { APIRoute } from 'astro';
import { db, dbReady, reportToRow, type DbEnv } from '../../lib/reports-db';
interface Env extends DbEnv { REPORT_BULK_TOKEN?: string }

const TYPES = ['add', 'delete', 'fix', 'news'] as const;
// 소식 제보에 붙이는 시리즈 단서 (선택): 수집기가 같은 이름끼리 시리즈 페이지로 묶는다
const SERIES_KINDS = ['광고', '화보', '예능', '드라마', '외부콘텐츠'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

async function sha(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MAX_BULK = 50;

/** 제보 하나 검사: 통과하면 저장할 값, 아니면 오류 문구 */
function parse(body: Record<string, unknown>) {
  const type = body.type as (typeof TYPES)[number];
  if (!TYPES.includes(type)) return '제보 종류를 골라 주세요';
  const report = {
    type,
    title: clip(body.title, 200),
    url: clip(body.url, 500),
    message: clip(body.message, 2000),
    eventId: clip(body.eventId, 80),
    eventTitle: clip(body.eventTitle, 200),
    date: clip(body.date, 10),
    time: clip(body.time, 5),
    endDate: clip(body.endDate, 10),
    endTime: clip(body.endTime, 5),
    reasonCode: clip(body.reasonCode, 40),
    // 삭제 요청 대상: 일정(기본) 또는 소식 (소식은 원문 주소로 찾는다)
    target: body.target === 'news' ? 'news' : 'event',
    newsUrl: clip(body.newsUrl, 500),
    newsTitle: clip(body.newsTitle, 200),
    eventSnapshot: body.eventSnapshot && typeof body.eventSnapshot === 'object' ? body.eventSnapshot : null,
    members: Array.isArray(body.members) ? (body.members as unknown[]).map((m) => clip(m, 10)).slice(0, 7) : [],
    series: SERIES_KINDS.includes(clip(body.seriesKind, 10)) && clip(body.seriesName, 40)
      ? { kind: clip(body.seriesKind, 10), name: clip(body.seriesName, 40) } : undefined,
  };
  if (type === 'add' && !report.title) return '일정 이름을 적어 주세요';
  if (type === 'add' && !report.url && !report.message) return '근거 링크나 내용을 적어 주세요';
  if (type === 'news' && !report.title) return '어떤 소식인지 한 줄로 적어 주세요';
  if (type === 'news' && !report.url && !report.message) return '링크나 내용을 적어 주세요';
  const newsDelete = type === 'delete' && report.target === 'news';
  if (newsDelete && !/^https?:\/\//i.test(report.newsUrl)) return '지울 소식의 링크를 넣어 주세요';
  if (newsDelete) report.eventTitle = `소식 · ${report.newsTitle || report.newsUrl}`.slice(0, 200);
  if ((type === 'fix' || (type === 'delete' && !newsDelete)) && !report.eventId) return '기존 일정을 선택해 주세요';
  if (type === 'delete' && !report.reasonCode) return '삭제 요청 이유를 골라 주세요';
  if (report.url && !/^https?:\/\//i.test(report.url)) return '링크는 http로 시작해야 해요';

  return report;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals.runtime?.env ?? {}) as Env;
  if (!dbReady(env)) return json({ ok: false, error: '지금은 제보를 받을 수 없어요. 잠시 뒤에 다시 시도해 주세요' }, 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  }
  const bulk = Array.isArray(body);
  if (!bulk && (!body || typeof body !== 'object')) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  if (bulk) {
    const auth = request.headers.get('authorization') ?? '';
    if (!env.REPORT_BULK_TOKEN || auth !== `Bearer ${env.REPORT_BULK_TOKEN}`) return json({ ok: false, error: '여러 건 제보는 토큰이 있어야 해요' }, 401);
    if (!body.length || body.length > MAX_BULK) return json({ ok: false, error: `한 번에 1~${MAX_BULK}건까지 보낼 수 있어요` }, 400);
  } else if ((body as Record<string, unknown>).website) return json({ ok: true }); // 봇이 채우는 숨은 칸

  const items = (bulk ? body : [body]) as unknown[];
  const now = Date.now();
  const results: ({ ok: true; id: string } | { ok: false; error: string })[] = [];
  const rows: Record<string, unknown>[] = [];
  const ip = await sha(request.headers.get('cf-connecting-ip') ?? 'unknown');
  for (const [i, item] of items.entries()) {
    const report = item && typeof item === 'object' && !Array.isArray(item) ? parse(item as Record<string, unknown>) : '형식이 올바르지 않아요';
    if (typeof report === 'string') { results.push({ ok: false, error: report }); continue; }
    const id = newId() + (bulk ? i.toString(36) : '');
    // 같은 묶음 안에서도 순서가 지켜지도록 1ms씩 늦춘다
    rows.push({ ...reportToRow({ id, ...report, status: 'pending', createdAt: new Date(now + i).toISOString() }), ...(bulk ? {} : { ip_hash: ip }) });
    results.push({ ok: true, id });
  }
  if (!bulk && !rows.length) return json(results[0], 400);

  try {
    if (!bulk) {
      // 너무 잦은 제보 막기: 같은 IP에서 1분에 5건까지 (IP는 해시로만 저장)
      const since = new Date(now - 60_000).toISOString();
      const recent = await db(env, `reports?select=id&ip_hash=eq.${ip}&created_at=gte.${encodeURIComponent(since)}`, { prefer: 'count=exact' });
      if (Number(recent.headers.get('content-range')?.split('/')[1] ?? 0) >= 5) return json({ ok: false, error: '잠시 후 다시 보내 주세요' }, 429);
    }
    if (rows.length) await db(env, 'reports', { method: 'POST', body: JSON.stringify(rows), prefer: 'return=minimal' });
  } catch (err) {
    console.error('제보 저장 실패', (err as Error).message);
    return json({ ok: false, error: '지금은 제보를 저장하지 못했어요. 잠시 뒤에 다시 시도해 주세요' }, 503);
  }
  return bulk ? json({ ok: true, saved: rows.length, results }) : json(results[0]);
};
