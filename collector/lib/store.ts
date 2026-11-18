/**
 * 저장 위치
 *  - data/state/   수집·처리 상태 (Git에 올림). 원문 본문은 넣지 않는다.
 *  - data/public/  사이트가 읽는 결과 (Git에 올림)
 *  - .cache/raw/   공지·기사 원문 본문 (저작권 때문에 Git에 올리지 않음. GitHub Actions에서는 캐시로 유지)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = join(ROOT, 'data');
export const CACHE_DIR = join(ROOT, '.cache', 'raw');

async function readJsonAt<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

async function writeAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** data/ 아래 JSON */
export const readJson = <T>(relPath: string, fallback: T) => readJsonAt(join(DATA_DIR, relPath), fallback);
export const writeJson = (relPath: string, value: unknown) => writeAt(join(DATA_DIR, relPath), JSON.stringify(value, null, 2) + '\n');
/** data/ 아래 텍스트 파일 (예: .ics) */
export const writeText = (relPath: string, text: string) => writeAt(join(DATA_DIR, relPath), text);

/** .cache/raw/ 아래 원문 본문 */
export async function readRaw(relPath: string): Promise<string | null> {
  try {
    return await readFile(join(CACHE_DIR, relPath), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export const writeRaw = (relPath: string, text: string) => writeAt(join(CACHE_DIR, relPath), text);
