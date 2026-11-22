/**
 * 어드민(/admin, /api/admin/*)은 Cloudflare Access 로그인을 거친 요청만 통과시킨다.
 * Access가 앞에서 막아 주지만, 설정이 빠지거나 틀려도 데이터가 열리지 않게 여기서 증명을 한 번 더 확인한다.
 */
import { defineMiddleware } from 'astro:middleware';
import { accessConfig, checkAccess, isAdminPath, tokenFrom } from './lib/access';

const deny = (msg: string, api: boolean) => api
  ? new Response(JSON.stringify({ ok: false, error: msg }), { status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } })
  : new Response(msg, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

export const onRequest = defineMiddleware(async (ctx, next) => {
  const path = new URL(ctx.request.url).pathname;
  if (!isAdminPath(path)) return next();
  const api = path.startsWith('/api/');
  const cfg = accessConfig(ctx.locals.runtime?.env);
  if (!cfg) return deny('어드민 로그인 설정(ACCESS_TEAM_DOMAIN·ACCESS_AUD)이 아직 없어요', api);
  const checked = await checkAccess(tokenFrom(ctx.request), cfg);
  if (!('email' in checked)) return deny(`로그인한 운영자만 볼 수 있어요 (${checked.reason})`, api);
  ctx.locals.admin = { email: checked.email };
  const res = await next();
  res.headers.set('cache-control', 'no-store');
  res.headers.set('x-robots-tag', 'noindex');
  return res;
});
