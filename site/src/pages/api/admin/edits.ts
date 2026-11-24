/**
 * 어드민 "데이터 고치기" (로그인한 운영자만, middleware.ts가 확인)
 *  GET  /api/admin/edits                     수정 목록 (KV edits)
 *  POST /api/admin/edits {action:'save', edit, rev?}   같은 대상의 수정이 있으면 바꾸고, 없으면 더한다
 *  POST /api/admin/edits {action:'delete', id, rev?}   수정 되돌리기
 * 사이트는 데이터를 읽을 때 이 목록을 덧씌우고(lib/data.ts), 수집기도 다음 수집 때 결과에 넣는다.
 */
import type { APIRoute } from 'astro';
import { loadRaw } from '../../../lib/data';
import { EDITS_KEY, EVENT_KINDS, linkKey, normalizeEvent, normUrl, type Edit, type EditKind, type EditOp, type EditsDoc } from '../../../lib/edits';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const KINDS: EditKind[] = ['event', 'feed', 'series', 'era'];
const OPS: EditOp[] = ['add', 'patch', 'hide'];
const SERIES_TYPES = ['자체 콘텐츠 시리즈', 'NCT 단체', '종류별 모아보기', '고정 출연', '반복 활동', '외부활동', '광고', '라디오', '콘서트·팬미팅 비하인드', '시상식·연말 무대'];
const FEED_TYPES = ['news', 'youtube', 'sns', 'weverse-notice'];
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const time = (v: unknown) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : '');
const url = (v: unknown) => { const s = str(v, 1000); if (!s) return undefined; try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.toString() : undefined; } catch { return undefined; } };
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

/** 대상이 같은 수정 (한 대상에는 수정 하나) */
const sameTarget = (a: Edit, b: Edit) => a.kind === b.kind && (
  a.kind === 'event' ? Boolean(a.target.id && a.target.id === b.target.id) :
  a.kind === 'feed' ? Boolean(a.target.url && normUrl(a.target.url) === normUrl(b.target.url)) :
  Boolean(a.target.id && a.target.id === b.target.id));

function cleanVideos(list: unknown) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 200).map((v) => {
    const u = url(v?.url);
    if (!u) return null;
    const id = linkKey(u);
    return {
      id, url: u, title: str(v.title, 200) || u, thumb: url(v.thumb) ?? (/^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''),
      date: date(v.date) ?? new Date().toISOString().slice(0, 10), members: Array.isArray(v.members) ? v.members.filter((m: unknown) => typeof m === 'string').slice(0, 10) : [],
      ...(['official', 'own', 'related'].includes(v.to) ? { to: v.to } : {}), ...(str(v.group, 40) ? { group: str(v.group, 40) } : {}),
    };
  }).filter(Boolean);
}

async function clean(locals: App.Locals, raw: any, id: string, now: string): Promise<Edit | string> {
  const kind = KINDS.includes(raw?.kind) ? raw.kind as EditKind : null;
  const op = OPS.includes(raw?.op) ? raw.op as EditOp : null;
  if (!kind || !op) return '형식이 올바르지 않아요';
  const t = raw.target ?? {};
  const target = { id: str(t.id, 120), date: date(t.date), title: str(t.title, 300), step: str(t.step, 300), url: url(t.url) };
  const base: Edit = { id, kind, op, target: Object.fromEntries(Object.entries(target).filter(([, v]) => v !== undefined)), note: str(raw.note, 300), at: now, by: locals.admin?.email ?? '' };
  if (kind !== 'feed' && op !== 'add' && !base.target.id && !(kind === 'event' && base.target.date && base.target.title)) return '고칠 항목을 찾지 못했어요';
  if (kind === 'feed' && op !== 'add' && !base.target.url) return '고칠 소식 주소가 없어요';
  if (op === 'hide') return base;
  const d = raw.data ?? {};
  if (kind === 'event') {
    if (!date(d.date) || !str(d.title)) return '날짜와 제목은 꼭 적어 주세요';
    if (!EVENT_KINDS.includes(d.kind)) return '종류를 골라 주세요';
    const members = await loadRaw<{ members?: { name: string }[] }>(locals, 'members.json', {}).catch(() => ({ members: [] }));
    const names = new Set((members.members ?? []).map((m) => m.name));
    const memberCount = Math.max(names.size, 1);
    const prev = op === 'patch' && raw.base && typeof raw.base === 'object' ? raw.base : undefined;
    base.data = normalizeEvent({
      date: date(d.date), time: time(d.time), endDate: date(d.endDate) ?? '', endTime: time(d.endTime), title: str(d.title, 200), step: str(d.step, 200) ?? '', kind: d.kind,
      members: (Array.isArray(d.members) ? d.members : []).filter((m: unknown) => typeof m === 'string' && (!names.size || names.has(m))), url: url(d.url),
    }, prev, memberCount, id, now);
    return base;
  }
  if (kind === 'feed') {
    const u = url(d.url);
    if (!u || !str(d.title)) return '제목과 링크는 꼭 적어 주세요';
    const at = typeof d.publishedAt === 'string' && !Number.isNaN(Date.parse(d.publishedAt)) ? new Date(d.publishedAt).toISOString() : now;
    const prev = op === 'patch' && raw.base && typeof raw.base === 'object' ? raw.base : {};
    base.data = {
      ...prev, type: FEED_TYPES.includes(d.type) ? d.type : 'news', title: str(d.title, 300), url: u, publishedAt: at, publisher: str(d.publisher, 80) || undefined,
      members: (Array.isArray(d.members) ? d.members : []).filter((m: unknown) => typeof m === 'string').slice(0, 10), image: url(d.image),
    };
    return base;
  }
  // 시리즈·아카이브: 바꿀 값만
  const data: Record<string, unknown> = {};
  if (kind === 'series') {
    if (str(d.name, 80)) data.name = str(d.name, 80);
    if (SERIES_TYPES.includes(d.type)) data.type = d.type;
    if (op === 'add') {
      if (!data.name) return '시리즈 이름을 적어 주세요';
      data.id = base.target.id ?? `m-${id}`;
      data.type ??= '외부활동';
      base.target = { id: data.id as string };
    }
  } else {
    if (op === 'add') return '아카이브는 새로 만들 수 없어요 (수집기가 활동을 만들어요)';
    for (const k of ['title', 'subtitle'] as const) if (typeof d[k] === 'string') data[k] = str(d[k], 120);
    for (const k of ['from', 'to'] as const) if (date(d[k])) data[k] = date(d[k]);
  }
  if (url(d.thumb)) data.thumb = url(d.thumb);
  if (Array.isArray(d.removeVideos)) data.removeVideos = d.removeVideos.filter((x: unknown) => typeof x === 'string').slice(0, 500);
  const added = cleanVideos(d.addVideos);
  if (added) data.addVideos = added;
  base.data = data;
  return base;
}

export const GET: APIRoute = async ({ locals }) => {
  const kv = locals.runtime?.env?.REPORTS;
  if (!kv) return json({ ok: false, error: 'KV가 없어요' }, 503);
  const doc = (await kv.get<EditsDoc>(EDITS_KEY, 'json')) ?? { rev: 0, items: [] };
  return json({ ok: true, ...doc, seriesTypes: SERIES_TYPES, eventKinds: EVENT_KINDS, feedTypes: FEED_TYPES });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const kv = locals.runtime?.env?.REPORTS;
  if (!kv) return json({ ok: false, error: 'KV가 없어요' }, 503);
  let b: any;
  try { b = await request.json(); } catch { return json({ ok: false, error: '형식이 올바르지 않아요' }, 400); }
  const doc = (await kv.get<EditsDoc>(EDITS_KEY, 'json')) ?? { rev: 0, items: [] };
  if (typeof b.rev === 'number' && b.rev !== doc.rev) return json({ ok: false, error: '다른 곳에서 먼저 고쳤어요. 새로고침한 뒤 다시 해 주세요', conflict: true }, 409);
  const now = new Date().toISOString();
  if (b.action === 'delete') {
    const items = doc.items.filter((x) => x.id !== b.id);
    if (items.length === doc.items.length) return json({ ok: false, error: '없는 수정이에요' }, 404);
    const next = { rev: doc.rev + 1, items };
    await kv.put(EDITS_KEY, JSON.stringify(next));
    return json({ ok: true, ...next });
  }
  if (b.action !== 'save') return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  const existing = typeof b.edit?.id === 'string' ? doc.items.find((x) => x.id === b.edit.id) : undefined;
  const edit = await clean(locals, b.edit, existing?.id ?? rid(), now);
  if (typeof edit === 'string') return json({ ok: false, error: edit }, 400);
  const items = doc.items.filter((x) => x.id !== edit.id && !sameTarget(x, edit));
  // 손으로 만든 일정·소식을 숨기면 만든 것 자체를 지운다
  const made = doc.items.find((x) => x.op === 'add' && ((edit.kind === 'event' && x.data?.id === edit.target.id) || (edit.kind === 'feed' && x.data?.url && normUrl(x.data.url) === normUrl(edit.target.url ?? '')) || ((edit.kind === 'series') && x.data?.id === edit.target.id)));
  if (made && edit.op === 'hide') {
    const next = { rev: doc.rev + 1, items: items.filter((x) => x.id !== made.id) };
    await kv.put(EDITS_KEY, JSON.stringify(next));
    return json({ ok: true, ...next });
  }
  // 손으로 만든 것을 고치면 만든 수정을 그대로 바꾼다 (원래 항목이 없으니 add 유지)
  if (made && edit.op === 'patch') {
    if (edit.kind === 'series') edit.data = { ...made.data, ...edit.data, id: made.data.id };
    if (edit.kind === 'event') edit.data.id = made.data.id;
    Object.assign(edit, { id: made.id, op: 'add', target: made.target });
  }
  const next = { rev: doc.rev + 1, items: [...items.filter((x) => x.id !== edit.id), edit] };
  if (JSON.stringify(next).length > 5_000_000) return json({ ok: false, error: '수정이 너무 많아요' }, 413);
  await kv.put(EDITS_KEY, JSON.stringify(next));
  return json({ ok: true, ...next, edit });
};
