/**
 * 수집 데이터(data/ + 원문 캐시 .cache/)를 Supabase Storage 비공개 버킷과 주고받는다.
 * GitHub Actions는 매번 빈 컴퓨터에서 시작하므로: 실행 전 pull → 수집 → 실행 후 push.
 * 원문·AI 인용·커뮤니티 목록은 공개 레포에 올리면 안 되기 때문에 레포 밖에 둔다.
 *
 *   npm run sync -- pull           내려받아 풀기 (없으면 첫 실행으로 보고 건너뜀)
 *   npm run sync -- push           묶어서 올리기 (pull에 성공한 실행에서만)
 *   npm run sync -- push --seed    처음 한 번: 내 컴퓨터의 데이터를 올리기
 *
 * Supabase 무료 플랜은 내려받기(egress)가 월 5GB라 15분마다 받으면 넘는다.
 * → STATE_KEY 가 있으면 데이터를 암호화해 .state-cache/ 에 두고(Actions 캐시로 다음 실행에 전달),
 *   Supabase의 버전 표시(state.version, 수십 바이트)가 같으면 내려받지 않고 캐시를 쓴다.
 *   암호화하는 이유: 공개 레포의 Actions 캐시는 레포에서 돌아가는 다른 워크플로가 꺼내 볼 수 있다.
 *
 * 필요한 값(.env 또는 Actions secrets): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import './lib/env.ts';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/store.ts';

const BUCKET = process.env.SUPABASE_STATE_BUCKET ?? 'archive-state';
const OBJECT = 'state.tgz';
const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
// 값은 절대 출력하지 않는다. 형식만 확인해서 무엇이 잘못 들어갔는지 알려 준다
const kindOf = (v: string) =>
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(v) ? 'url'
  : v.startsWith('sb_secret_') ? 'secret'
  : v.startsWith('sb_publishable_') ? 'publishable'
  : /^eyJ/.test(v) ? (/"role"\s*:\s*"service_role"/.test(Buffer.from(v.split('.')[1] ?? '', 'base64url').toString()) ? 'service_role' : 'anon')
  : 'unknown';
const LABEL: Record<string, string> = { url: '프로젝트 주소', secret: '비밀 키', service_role: 'service_role 키', publishable: '공개용 키(publishable)', anon: '공개용 키(anon)', unknown: '알 수 없는 값' };
if (!url || !key) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 가 필요해요 (.env 또는 Actions secrets)');
  process.exit(1);
}
if (kindOf(url) !== 'url' || !['secret', 'service_role'].includes(kindOf(key))) {
  console.error(`Supabase 값 형식이 맞지 않아요: SUPABASE_URL=${LABEL[kindOf(url)]}, SUPABASE_SERVICE_ROLE_KEY=${LABEL[kindOf(key)]}`);
  console.error('  SUPABASE_URL 은 https://<프로젝트>.supabase.co, SUPABASE_SERVICE_ROLE_KEY 는 sb_secret_… (또는 예전 service_role 키)여야 해요');
  process.exit(1);
}
// 새 비밀 키(sb_secret_)는 apikey 헤더로만, 예전 service_role 키(JWT)는 Authorization에도
const headers: Record<string, string> = kindOf(key) === 'secret' ? { apikey: key } : { Authorization: `Bearer ${key}`, apikey: key };
const tmp = join(ROOT, 'tmp');
const archive = join(tmp, OBJECT);
const marker = join(ROOT, '.cache', 'sync-pulled');
const CACHE_DIR = join(ROOT, '.state-cache');
const stateKey = process.env.STATE_KEY ? createHash('sha256').update(process.env.STATE_KEY).digest() : null;
mkdirSync(tmp, { recursive: true });

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');
function encrypt(b: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', stateKey!, iv);
  const body = Buffer.concat([c.update(b), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function decrypt(b: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', stateKey!, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}
/** 다음 실행이 쓸 암호화 캐시 */
function writeCache(body: Buffer, version: string) {
  if (!stateKey) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, 'state.tgz.enc'), encrypt(body));
  writeFileSync(join(CACHE_DIR, 'state.version'), version);
}
function readCache(version: string): Buffer | null {
  if (!stateKey) return null;
  try {
    if (readFileSync(join(CACHE_DIR, 'state.version'), 'utf8').trim() !== version) return null;
    const body = decrypt(readFileSync(join(CACHE_DIR, 'state.tgz.enc')));
    return sha1(body) === version ? body : null;
  } catch {
    return null;
  }
}
async function remoteVersion(): Promise<string | null> {
  const res = await fetch(`${url}/storage/v1/object/authenticated/${BUCKET}/state.version`, { headers });
  return res.ok ? (await res.text()).trim() : null;
}

async function ensureBucket() {
  const res = await fetch(`${url}/storage/v1/bucket/${BUCKET}`, { headers });
  if (res.ok) {
    const b = (await res.json()) as { public?: boolean };
    if (b.public) throw new Error(`버킷 ${BUCKET} 이 공개로 되어 있어요. 비공개로 바꿔 주세요`);
    return;
  }
  const made = await fetch(`${url}/storage/v1/bucket`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) });
  if (!made.ok) throw new Error(`버킷 만들기 실패 ${made.status}: ${await made.text()}`);
  console.log(`비공개 버킷 ${BUCKET} 을 만들었어요`);
}

async function upload(path: string, body: Buffer, type = 'application/gzip') {
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': type, 'x-upsert': 'true' }, body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`올리기 실패 ${path} ${res.status}: ${await res.text()}`);
}

async function pull() {
  await ensureBucket();
  const version = await remoteVersion();
  const cached = version ? readCache(version) : null;
  if (cached) {
    writeFileSync(archive, cached);
    execFileSync('tar', ['-xzf', archive, '--exclude', '._*', '-C', ROOT]);
    console.log(`캐시의 데이터를 썼어요 (Supabase와 같은 버전이라 내려받지 않음, ${(cached.length / 1e6).toFixed(1)}MB)`);
  } else {
    const res = await fetch(`${url}/storage/v1/object/authenticated/${BUCKET}/${OBJECT}`, { headers });
    if (res.status === 400 || res.status === 404) {
      console.log('저장된 데이터가 없어요 (첫 실행). 빈 상태로 시작합니다');
    } else if (!res.ok) {
      throw new Error(`내려받기 실패 ${res.status}: ${await res.text()}`);
    } else {
      const body = Buffer.from(await res.arrayBuffer());
      writeFileSync(archive, body);
      execFileSync('tar', ['-xzf', archive, '--exclude', '._*', '-C', ROOT]);
      writeCache(body, sha1(body));
      console.log(`데이터를 내려받았어요 (${(body.length / 1e6).toFixed(1)}MB)`);
    }
  }
  mkdirSync(join(ROOT, '.cache'), { recursive: true });
  writeFileSync(marker, new Date().toISOString());
}

async function push(seed: boolean) {
  // 내려받기에 실패한 실행이 빈 데이터로 덮어쓰지 않게
  if (!seed && !existsSync(marker)) throw new Error('pull 하지 않은 상태라 올리지 않아요 (처음이면 --seed)');
  await ensureBucket();
  const paths = ['data', '.cache'].filter((p) => existsSync(join(ROOT, p)));
  // 맥 tar는 확장 속성을 ._이름 파일로 넣는다 → 리눅스(Actions)에서 풀면 JSON이 아닌 파일이 생기므로 넣지 않는다
  execFileSync('tar', ['-czf', archive, '--exclude', '.cache/sync-pulled', '--exclude', '._*', '-C', ROOT, ...paths], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const body = readFileSync(archive);
  await upload(OBJECT, body);
  await upload('state.version', Buffer.from(sha1(body)), 'text/plain');
  writeCache(body, sha1(body));
  // 하루 한 번 날짜별 사본 (잘못 덮어써도 되돌릴 수 있게)
  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const head = await fetch(`${url}/storage/v1/object/info/authenticated/${BUCKET}/backup/${day}.tgz`, { headers });
  if (!head.ok) await upload(`backup/${day}.tgz`, body);
  console.log(`데이터를 올렸어요 (${(body.length / 1e6).toFixed(1)}MB${head.ok ? '' : `, 날짜별 사본 backup/${day}.tgz`})`);
}

const cmd = process.argv[2];
if (cmd === 'pull') await pull();
else if (cmd === 'push') await push(process.argv.includes('--seed'));
else {
  console.error('사용: npm run sync -- pull | push [--seed]');
  process.exit(1);
}
