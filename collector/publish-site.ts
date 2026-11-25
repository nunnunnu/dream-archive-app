/**
 * 사이트 데이터 올리기 (배포 없이 사이트에 반영): npm run publish:site
 *  - data/public 의 사이트용 파일 → Supabase Storage 공개 버킷 `site-data`
 *    파일 이름에 내용 지문을 붙여 올리고(events.3f2a9c1d.json, 바뀌지 않으니 오래 캐시해도 됨),
 *    manifest.json 에 "원래 이름 → 지문 이름"을 적는다. 사이트는 manifest 만 짧게 캐시하고 읽는다.
 *  - 질문 자료 묶음(공지·기사 원문 포함, 비공개) → Supabase Storage **비공개** 버킷 `ask-data` (index.json + version.txt, 공개 버킷에 올리지 않는다)
 *  - 물어보기 "오늘 기준 데이터" 통계(숫자뿐) → 공개 버킷 `site-data/ask-stats.json`
 * 바뀐 파일만 올리고, manifest 에 없는 지난 파일은 하루 뒤에 지운다.
 * 필요한 값(.env / Actions secrets): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 */
import './lib/env.ts';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadAskData } from './lib/ask.ts';
import { syncFanchant } from './lib/fanchant-publish.ts';
import { JsonRepo } from './lib/repo.ts';
import { ROOT } from './lib/store.ts';

const BUCKET = 'site-data';
const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 가 필요해요');
  process.exit(1);
}
const headers: Record<string, string> = key.startsWith('sb_secret_') ? { apikey: key } : { Authorization: `Bearer ${key}`, apikey: key };
const PUBLIC_DIR = join(ROOT, 'data', 'public');
// 사이트가 쓰는 파일만 (확인 대기·추측 목록 등 내부용은 올리지 않는다)
const INCLUDE = /^(events|feed|tags|meta|site|eras|series|discography|members)\.json$|^(eras|series|events|fanchant)\/[^/]+\.json$|^calendar\/.+\.ics$/;

const sha = (b: Buffer | string) => createHash('sha1').update(b).digest('hex').slice(0, 12);
const typeOf = (p: string) => (p.endsWith('.ics') ? 'text/calendar; charset=utf-8' : 'application/json; charset=utf-8');

async function ensurePublicBucket() {
  const res = await fetch(`${url}/storage/v1/bucket/${BUCKET}`, { headers });
  if (res.ok) return;
  const made = await fetch(`${url}/storage/v1/bucket`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }) });
  if (!made.ok) throw new Error(`공개 버킷 만들기 실패 ${made.status}: ${await made.text()}`);
  console.log(`공개 버킷 ${BUCKET} 을 만들었어요 (사이트용 데이터만)`);
}

async function upload(path: string, body: Buffer | string, type: string, cacheSeconds: number) {
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': type, 'x-upsert': 'true', 'cache-control': `max-age=${cacheSeconds}` },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`올리기 실패 ${path} ${res.status}: ${await res.text()}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [relative(PUBLIC_DIR, p).split('\\').join('/').normalize('NFC')];
  });
}

// Cloudflare (KV): 응원법 채보 읽기 (질문 자료는 아래 비공개 버킷으로)
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const toml = existsSync(join(ROOT, 'site', 'wrangler.toml')) ? readFileSync(join(ROOT, 'site', 'wrangler.toml'), 'utf8') : '';
const ns = process.env.CF_KV_REPORTS_ID ?? toml.match(/binding\s*=\s*"REPORTS"\s*\nid\s*=\s*"([0-9a-f]{32})"/)?.[1];

// 응원법 채보: 어드민에서 공개(verified)로 바꾼 것만 data/public/fanchant/ 로
if (account && token && ns) {
  const slugs = existsSync(join(PUBLIC_DIR, 'members.json')) ? ((JSON.parse(readFileSync(join(PUBLIC_DIR, 'members.json'), 'utf8')) as { members?: { slug: string }[] }).members ?? []).map((m) => m.slug) : [];
  for (const line of await syncFanchant(ROOT, { accountId: account, token, namespaceId: ns }, slugs)) console.log(line);
}

await ensurePublicBucket();
const prev = await fetch(`${url}/storage/v1/object/public/${BUCKET}/manifest.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { files: Record<string, string> } | null;
const files: Record<string, string> = {};
let uploaded = 0;
for (const rel of walk(PUBLIC_DIR).filter((p) => INCLUDE.test(p)).sort()) {
  const body = readFileSync(join(PUBLIC_DIR, rel));
  // 저장 이름은 영문·숫자만 (Supabase Storage는 한글 이름을 받지 않는다): 폴더/이름지문.내용지문.확장자
  const dot = rel.lastIndexOf('.');
  const slash = rel.lastIndexOf('/');
  const base = rel.slice(slash + 1, dot);
  const name = /^[\w.-]+$/.test(base) ? base : `n${sha(base)}`;
  const hashed = `${rel.slice(0, slash + 1)}${name}.${sha(body)}${rel.slice(dot)}`;
  files[rel] = hashed;
  if (prev?.files[rel] === hashed) continue;
  await upload(hashed, body, typeOf(rel), 31536000);
  uploaded++;
}
const version = sha(JSON.stringify(files));
const manifest = { version, updatedAt: new Date().toISOString(), files };
if (!prev || (prev as { version?: string }).version !== version) await upload('manifest.json', JSON.stringify(manifest), 'application/json; charset=utf-8', 30);
console.log(`사이트 데이터: 파일 ${Object.keys(files).length}개 중 ${uploaded}개 올림 (버전 ${version})`);

// 지난 파일 정리: manifest 에 없고 하루 넘은 것
const keep = new Set(['manifest.json', 'ask-stats.json', ...Object.values(files)]);
const old: string[] = [];
for (const prefix of ['', 'eras/', 'series/', 'calendar/', 'calendar/flows/']) {
  const res = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000 }) });
  if (!res.ok) continue;
  for (const o of (await res.json()) as { name: string; id: string | null; created_at?: string }[]) {
    const p = `${prefix}${o.name}`.normalize('NFC');
    if (!o.id || keep.has(p)) continue; // id 없음 = 폴더
    if (o.created_at && Date.now() - Date.parse(o.created_at) < 864e5) continue;
    old.push(p);
  }
}
for (let i = 0; i < old.length; i += 100) {
  await fetch(`${url}/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: old.slice(i, i + 100) }) });
}
if (old.length) console.log(`지난 파일 ${old.length}개 지움`);

// 질문 자료 묶음 → 비공개 버킷 (사이트 /api/ask 가 비밀 키로 읽고, 버전마다 Cloudflare 캐시에 둔다)
const ASK_BUCKET = 'ask-data';
{
  const data = await loadAskData(new JsonRepo(), { articleDays: Number(process.env.ASK_INDEX_ARTICLE_DAYS ?? 120) });
  const index = JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...data,
    events: data.events.map((e) => ({ id: e.id, date: e.date, time: e.time, endDate: e.endDate, title: e.title, step: e.step, kind: e.kind, members: e.members, timezone: e.timezone, kst: e.kst, abroad: e.abroad, evidence: e.evidence?.slice(0, 200), sources: e.sources.slice(0, 2).map((s) => ({ url: s.url, type: s.type })) })),
  });
  const ver = sha(index.replace(/"generatedAt":"[^"]+"/, ''));
  try {
    const got = await fetch(`${url}/storage/v1/bucket/${ASK_BUCKET}`, { headers });
    if (!got.ok) {
      const made = await fetch(`${url}/storage/v1/bucket`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: ASK_BUCKET, name: ASK_BUCKET, public: false }) });
      if (!made.ok) throw new Error(`비공개 버킷 만들기 실패 ${made.status}: ${await made.text()}`);
      console.log(`비공개 버킷 ${ASK_BUCKET} 을 만들었어요 (질문 자료, 원문 포함)`);
    }
    const put = async (path: string, body: string, type: string) => {
      const res = await fetch(`${url}/storage/v1/object/${ASK_BUCKET}/${path}`, { method: 'POST', headers: { ...headers, 'content-type': type, 'x-upsert': 'true' }, body });
      if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 120)}`);
    };
    const cur = await fetch(`${url}/storage/v1/object/${ASK_BUCKET}/version.txt?t=${Date.now()}`, { headers }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    if (cur.trim() !== ver) {
      // 묶음 먼저, 버전은 나중 (사이트가 새 버전을 보면 묶음도 이미 새것)
      await put('index.json', index, 'application/json; charset=utf-8');
      await put('version.txt', ver, 'text/plain; charset=utf-8');
      console.log(`질문 자료 묶음 → 비공개 버킷 (${(index.length / 1e6).toFixed(1)}MB, 버전 ${ver})`);
    } else console.log('질문 자료 묶음: 바뀐 것 없음');
  } catch (err) {
    // 사이트 데이터는 이미 올렸으니 실행은 실패시키지 않는다 (물어보기만 지난 자료로)
    console.warn(`질문 자료 올리기 실패: ${(err as Error).message} → 물어보기는 지난 자료로 답해요`);
  }
  // 물어보기 화면의 "오늘 기준 데이터" 카드 (마지막 수집 시각·자료 수·확인 대기 수): 숫자뿐이라 공개 버킷
  const count = (k: string) => data.docs.filter((d) => d.kind === k).length;
  const stats = {
    collectedAt: new Date().toISOString(), notices: count('notice'), articles: count('article'), videos: count('video'),
    events: data.events.length, review: data.events.filter((e) => e.status === 'needs-check').length,
    submissions: data.events.filter((e) => e.sources.some((x) => x.type === 'submission')).length,
  };
  await upload('ask-stats.json', JSON.stringify(stats), 'application/json; charset=utf-8', 60).catch((err) => console.log(`물어보기 통계 올리기 실패: ${(err as Error).message}`));
}
