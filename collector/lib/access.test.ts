// 어드민 로그인 확인 (site/src/lib/access.ts): Access 증명의 서명·aud·iss·만료
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearAccessCache, isAdminPath, tokenFrom, verifyAccess } from '../../site/src/lib/access.ts';

const cfg = { teamDomain: 'team.cloudflareaccess.com', aud: 'aud-123' };
const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');

async function setup() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' } as { kid: string; kty: string; n: string; e: string };
  const sign = async (payload: object, header: object = { alg: 'RS256', kid: 'k1' }, key = pair.privateKey) => {
    const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head)));
    return `${head}.${b64url(sig)}`;
  };
  return { sign, fetcher: async () => [jwk], pair };
}
const now = Date.parse('2026-11-22T00:00:00Z');
const good = { aud: ['aud-123'], iss: 'https://team.cloudflareaccess.com', exp: now / 1000 + 3600, email: 'admin@example.com' };

test('올바른 Access 증명만 통과한다', async () => {
  clearAccessCache();
  const { sign, fetcher } = await setup();
  assert.deepEqual(await verifyAccess(await sign(good), cfg, { fetcher, now }), { email: 'admin@example.com' });
  assert.equal(await verifyAccess(await sign({ ...good, aud: ['other-app'] }), cfg, { fetcher, now }), null, '다른 앱 aud');
  assert.equal(await verifyAccess(await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }), cfg, { fetcher, now }), null, '다른 팀');
  assert.equal(await verifyAccess(await sign({ ...good, exp: now / 1000 - 1 }), cfg, { fetcher, now }), null, '만료');
  assert.equal(await verifyAccess(await sign(good, { alg: 'none', kid: 'k1' }), cfg, { fetcher, now }), null, 'alg none');
  assert.equal(await verifyAccess(null, cfg, { fetcher, now }), null, '증명 없음');
  assert.equal(await verifyAccess(await sign(good), null, { fetcher, now }), null, '설정 없음');
});

test('다른 키로 서명했거나 내용을 바꾸면 막는다', async () => {
  clearAccessCache();
  const { sign, fetcher } = await setup();
  const other = await setup();
  assert.equal(await verifyAccess(await other.sign(good), cfg, { fetcher, now }), null, '다른 키');
  const [h, , s] = (await sign(good)).split('.');
  const forged = `${h}.${b64url(JSON.stringify({ ...good, email: 'x@example.com' }))}.${s}`;
  assert.equal(await verifyAccess(forged, cfg, { fetcher, now }), null, '내용 변조');
});

test('어드민 경로와 증명 위치', () => {
  assert.equal(isAdminPath('/admin'), true);
  assert.equal(isAdminPath('/admin/'), true);
  assert.equal(isAdminPath('/api/admin/reports'), true);
  assert.equal(isAdminPath('/administrator'), false);
  assert.equal(isAdminPath('/api/ask'), false);
  assert.equal(tokenFrom(new Request('https://x/', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } })), 'a.b.c');
  assert.equal(tokenFrom(new Request('https://x/', { headers: { cookie: 'x=1; CF_Authorization=d.e.f' } })), 'd.e.f');
});
