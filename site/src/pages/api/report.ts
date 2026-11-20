/**
 * 제보 받기 (Astro API, Cloudflare에서 실행): POST /api/report
 * 받은 제보는 KV(REPORTS)에 저장한다. 공식 원문 대조를 통과한 추가·보완 제보는 수집기가 자동 승인하고,
 * 그 밖의 제보와 삭제 요청은 운영자가 확인한다.
 * 개인정보는 받지 않는다. 같은 IP에서 1분에 5번까지만 (IP는 해시로만 잠깐 쓴다).
 */
import type { APIRoute } from 'astro';
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env { REPORTS: KV }

const TYPES = ['add', 'delete', 'fix'] as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

async function sha(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals.runtime?.env ?? {}) as Env;
  if (!env.REPORTS) return json({ ok: false, error: '제보 저장소가 설정되지 않았어요' }, 503);
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  }
  if (body.website) return json({ ok: true }); // 봇이 채우는 숨은 칸
  const type = body.type as (typeof TYPES)[number];
  if (!TYPES.includes(type)) return json({ ok: false, error: '제보 종류를 골라 주세요' }, 400);
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
    eventSnapshot: body.eventSnapshot && typeof body.eventSnapshot === 'object' ? body.eventSnapshot : null,
    members: Array.isArray(body.members) ? (body.members as unknown[]).map((m) => clip(m, 10)).slice(0, 7) : [],
  };
  if (type === 'add' && !report.title) return json({ ok: false, error: '일정 이름을 적어 주세요' }, 400);
  if (type === 'add' && !report.url && !report.message) return json({ ok: false, error: '근거 링크나 내용을 적어 주세요' }, 400);
  if (type !== 'add' && !report.eventId) return json({ ok: false, error: '기존 일정을 선택해 주세요' }, 400);
  if (type === 'delete' && !report.reasonCode) return json({ ok: false, error: '삭제 요청 이유를 골라 주세요' }, 400);
  if (report.url && !/^https?:\/\//i.test(report.url)) return json({ ok: false, error: '링크는 http로 시작해야 해요' }, 400);

  // 너무 잦은 제보 막기
  const ip = await sha(request.headers.get('cf-connecting-ip') ?? 'unknown');
  const rateKey = `rate:${ip}:${Math.floor(Date.now() / 60000)}`;
  const count = Number((await env.REPORTS.get(rateKey)) ?? 0);
  if (count >= 5) return json({ ok: false, error: '잠시 후 다시 보내 주세요' }, 429);
  await env.REPORTS.put(rateKey, String(count + 1), { expirationTtl: 120 });

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await env.REPORTS.put(`report:${id}`, JSON.stringify({ id, ...report, status: 'pending', createdAt: new Date().toISOString() }));
  // 15·45분 예약 작업은 이 값의 존재만 보고 새 제보 검증을 깨운다.
  // 제보 내용은 넣지 않고, 새 제보가 처리 중 들어와도 구분할 수 있도록 마지막 id만 둔다.
  await env.REPORTS.put('pending-reports', id);
  return json({ ok: true, id });
};
