/**
 * 응원법 채보 공개: 어드민이 KV chart:<곡ID> 에 저장한 채보 중 verified 만
 * data/public/fanchant/<곡ID>.json 으로 쓰고 fanchant/index.json(곡 목록 + config/fanchant.json 설정)을 만든다.
 * publish:site 가 올리기 전에 부른다. KV를 못 읽으면 기존 파일을 그대로 둔다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkChart, FANCHANT_DEFAULTS, indexEntry, publicChart, type FanchantChart, type FanchantConfig } from '../../site/src/lib/fanchant.ts';

export interface KvAccess { accountId: string; token: string; namespaceId: string }

export function fanchantConfig(root: string): FanchantConfig {
  const p = join(root, 'config', 'fanchant.json');
  if (!existsSync(p)) return { ...FANCHANT_DEFAULTS };
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  const out = { ...FANCHANT_DEFAULTS } as Record<string, unknown>;
  for (const k of Object.keys(FANCHANT_DEFAULTS)) if (typeof raw[k] === typeof out[k]) out[k] = raw[k];
  return out as FanchantConfig;
}

/** 공개할 파일 내용 만들기 (순수 함수, 테스트 대상): 다시 검사해서 통과한 verified 채보만 */
export function buildFanchantFiles(charts: unknown[], config: FanchantConfig, memberSlugs: string[] = []): { files: Record<string, string>; log: string[] } {
  const log: string[] = [];
  const ok: FanchantChart[] = [];
  for (const raw of charts) {
    const id = (raw as { songId?: string })?.songId ?? '?';
    if ((raw as { verified?: boolean })?.verified !== true) continue;
    const { chart, errors } = checkChart(raw, { memberSlugs, minCueGapMs: config.minCueGapMs });
    if (!chart) { log.push(`채보 ${id}: 검사 통과 못 해서 공개 안 함 (${errors.join(' · ')})`); continue; }
    ok.push(chart);
  }
  ok.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  const files: Record<string, string> = {};
  for (const c of ok) files[`${c.songId}.json`] = `${JSON.stringify(publicChart(c), null, 2)}\n`;
  files['index.json'] = `${JSON.stringify({ config, songs: ok.map(indexEntry) }, null, 2)}\n`;
  return { files, log };
}

async function readCharts(c: KvAccess): Promise<unknown[]> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/storage/kv/namespaces/${c.namespaceId}`;
  const headers = { Authorization: `Bearer ${c.token}` };
  const names: string[] = [];
  let cursor = '';
  do {
    const res = await fetch(`${base}/keys?prefix=chart:&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers });
    if (!res.ok) throw new Error(`채보 목록 읽기 실패 ${res.status}`);
    const body = (await res.json()) as { result?: { name: string }[]; result_info?: { cursor?: string } };
    names.push(...(body.result ?? []).map((k) => k.name));
    cursor = body.result_info?.cursor ?? '';
  } while (cursor);
  return Promise.all(names.map(async (n) => {
    const res = await fetch(`${base}/values/${encodeURIComponent(n)}`, { headers });
    if (!res.ok) throw new Error(`채보 ${n} 읽기 실패 ${res.status}`);
    return res.json();
  }));
}

/** KV → data/public/fanchant/. 없어진(공개 취소·삭제) 곡 파일은 지운다 */
export async function syncFanchant(root: string, kv: KvAccess, memberSlugs: string[] = []): Promise<string[]> {
  let charts: unknown[];
  try {
    charts = await readCharts(kv);
  } catch (err) {
    return [`응원법 채보를 못 읽어서 기존 공개 파일을 그대로 둬요: ${(err as Error).message}`];
  }
  const { files, log } = buildFanchantFiles(charts, fanchantConfig(root), memberSlugs);
  const dir = join(root, 'data', 'public', 'fanchant');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && !(f in files)) rmSync(join(dir, f));
  for (const [f, body] of Object.entries(files)) {
    const p = join(dir, f);
    if (!existsSync(p) || readFileSync(p, 'utf8') !== body) writeFileSync(p, body);
  }
  log.push(`응원법 채보 공개 ${Object.keys(files).length - 1}곡 (전체 ${charts.length}곡)`);
  return log;
}
