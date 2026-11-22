/**
 * 어드민 로그인 확인: Cloudflare Access가 붙여 주는 로그인 증명(JWT)을 서버에서 한 번 더 검사한다.
 *  - 누가 들어올 수 있는지는 Access 정책(허가 메일 목록) 한 곳에서만 정한다. 여기서는 "이 앱용으로 Access가 서명한 증명인가"만 본다
 *  - 서명(RS256, Access 공개키), aud(이 앱의 AUD 태그), iss(팀 도메인), 만료를 모두 확인한다
 *  - 설정(ACCESS_TEAM_DOMAIN·ACCESS_AUD)이 없으면 아무도 통과시키지 않는다
 */
export interface AccessConfig { teamDomain: string; aud: string }
export interface AccessUser { email: string }
interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }

const b64urlBytes = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** 공개키는 팀 도메인마다 잠깐 기억한다 (Access는 키를 몇 주마다 바꾼다) */
const certCache = new Map<string, { at: number; keys: Jwk[] }>();
export type CertFetcher = (url: string) => Promise<Jwk[]>;
const fetchCerts: CertFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Access 공개키 읽기 실패 ${res.status}`);
  return ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
};

async function keysFor(teamDomain: string, fetcher: CertFetcher, fresh = false): Promise<Jwk[]> {
  const hit = certCache.get(teamDomain);
  if (!fresh && hit && Date.now() - hit.at < 3600e3) return hit.keys;
  const keys = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  certCache.set(teamDomain, { at: Date.now(), keys });
  return keys;
}

export const accessConfig = (env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string } | undefined): AccessConfig | null => {
  const teamDomain = env?.ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = env?.ACCESS_AUD?.trim();
  return teamDomain && aud ? { teamDomain, aud } : null;
};

/** 요청에서 증명 꺼내기: Access가 붙이는 헤더, 없으면 브라우저 쿠키 */
export const tokenFrom = (req: Request): string | null =>
  req.headers.get('cf-access-jwt-assertion')
  ?? req.headers.get('cookie')?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1]
  ?? null;

export async function verifyAccess(token: string | null, cfg: AccessConfig | null, opts: { fetcher?: CertFetcher; now?: number } = {}): Promise<AccessUser | null> {
  if (!token || !cfg) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson<{ alg?: string; kid?: string }>(parts[0]);
    const payload = b64urlJson<{ aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string }>(parts[1]);
    if (header.alg !== 'RS256' || !header.kid) return null;
    const now = (opts.now ?? Date.now()) / 1000;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(cfg.aud)) return null;
    if (payload.iss !== `https://${cfg.teamDomain}`) return null;
    if (!payload.exp || payload.exp < now) return null;
    if (payload.nbf && payload.nbf > now + 60) return null;
    if (!payload.email) return null;
    const fetcher = opts.fetcher ?? fetchCerts;
    let jwk = (await keysFor(cfg.teamDomain, fetcher)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await keysFor(cfg.teamDomain, fetcher, true)).find((k) => k.kid === header.kid);
    if (!jwk || jwk.kty !== 'RSA') return null;
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok ? { email: payload.email } : null;
  } catch {
    return null;
  }
}

/** 테스트용: 캐시 비우기 */
export const clearAccessCache = () => certCache.clear();

/** 어드민 경로인가 (/admin, /admin/..., /api/admin/...) */
export const isAdminPath = (path: string) => /^\/(?:admin|api\/admin)(?:\/|$)/.test(path);
