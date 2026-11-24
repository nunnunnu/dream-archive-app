/**
 * 어드민: 영상 주소로 제목·채널·썸네일 가져오기 (유튜브 공개 oEmbed, 키 없음)
 *  GET /api/admin/oembed?url=https://youtu.be/…
 */
import type { APIRoute } from 'astro';
import { youtubeIdOf } from '../../../lib/edits';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export const GET: APIRoute = async ({ url }) => {
  const target = url.searchParams.get('url') ?? '';
  const id = youtubeIdOf(target);
  if (!id) return json({ ok: false, error: '유튜브 주소만 가져올 수 있어요. 제목은 직접 적어 주세요' }, 400);
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`).catch(() => null);
  if (!res?.ok) return json({ ok: false, error: '영상 정보를 못 가져왔어요 (비공개·삭제된 영상일 수 있어요)' }, 404);
  const d = (await res.json()) as { title?: string; author_name?: string };
  return json({ ok: true, id, url: watch, title: d.title ?? '', channel: d.author_name ?? '', thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` });
};
