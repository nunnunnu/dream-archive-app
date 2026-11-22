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
  const url = new URL(ctx.request.url);
  const path = url.pathname;
  if (!isAdminPath(path)) return next();
  const api = path.startsWith('/api/');
  // Access는 ADMIN_HOST(pages.dev 주소)에만 걸려 있다. 다른 주소(dreamlog.kro.kr 등)로 온 어드민 화면은 그쪽으로 넘긴다
  const adminHost = ctx.locals.runtime?.env?.ADMIN_HOST?.trim();
  if (adminHost && url.hostname !== adminHost && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    if (api) return deny(`어드민은 https://${adminHost}/admin 에서만 쓸 수 있어요`, api);
    return Response.redirect(`https://${adminHost}${path}${url.search}`, 302);
  }
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
