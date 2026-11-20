/**
 * 위버스 공지 본문 이미지 읽기. 일정표·포스터·상세 안내가 이미지로만 올라오는 공지가 많다.
 *  - 이미지를 브라우저로 열어 1600px씩 잘라 찍고 (긴 이미지는 그대로 넣으면 AI가 작게 줄여서 글을 못 읽는다)
 *  - AI(이미지 입력)로 이미지 속 글을 그대로 옮겨 적어 .cache/raw/notice-image/{id}.txt 에 둔다
 *  - 공지 해석은 "본문 + [이미지 속 글]"로 하고, 근거 문장 대조도 이 글 기준
 * 한 번 옮겨 적은 공지는 다시 부르지 않는다.
 */
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { Budget } from './budget.ts';
import { hasLlmKey, transcribeImages } from './llm.ts';
import type { NoticeRecord, Repo } from './repo.ts';

const WIDTH = 1414;
const TILE = 1600;
const MAX_TILES = 16;

/** 공지 해석에 쓰는 글과 그 해시 (이미지 글이 있으면 본문 뒤에 붙인다) */
export async function noticeSource(repo: Repo, n: NoticeRecord): Promise<{ body: string | null; hash: string }> {
  const body = await repo.getBody('notice', n.id);
  const img = await repo.getBody('notice-image', n.id);
  if (!img) return { body, hash: n.bodyHash };
  return { body: `${body ?? ''}\n\n[이미지 속 글]\n${img}`, hash: createHash('sha256').update(`${n.bodyHash}|${img}`).digest('hex').slice(0, 16) };
}

/** 이미지 한 장을 위에서부터 잘라 찍은 조각들 (JPEG base64) */
export async function captureTiles(page: Page, url: string, referer = 'https://weverse.io/'): Promise<string[]> {
  await page.setViewportSize({ width: WIDTH, height: TILE });
  await page.setExtraHTTPHeaders({ Referer: referer });
  await page.setContent(`<html><body style="margin:0;background:#fff"><img id="i" style="display:block;width:${WIDTH}px;height:auto"></body></html>`);
  await page.evaluate(`document.getElementById('i').src = ${JSON.stringify(url)}`);
  await page.waitForFunction(`(() => { const i = document.getElementById('i'); return i.complete && i.naturalWidth > 0; })()`, null, { timeout: 30_000 });
  const height = (await page.evaluate(`document.getElementById('i').getBoundingClientRect().height`)) as number;
  const tiles: string[] = [];
  for (let y = 0; y < height && tiles.length < MAX_TILES; y += TILE) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    tiles.push((await page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64'));
  }
  return tiles;
}

/** 이미지가 있고 아직 옮겨 적지 않은 공지를 처리한다 */
export async function transcribeNoticeImages(repo: Repo, page: Page, budget: Budget, notices: NoticeRecord[]): Promise<string[]> {
  const log: string[] = [];
  for (const n of notices) {
    if (!n.images?.length || (await repo.getBody('notice-image', n.id)) !== null) continue;
    if (!hasLlmKey() || !budget.canSpend()) break;
    try {
      const parts: string[] = [];
      for (const url of n.images) {
        const tiles = await captureTiles(page, url);
        const r = await transcribeImages(tiles, n.title);
        budget.record(r.usage.costUsd);
        parts.push(r.value);
      }
      await repo.putBody('notice-image', n.id, parts.join('\n\n'));
      log.push(`공지 ${n.id} 이미지 ${n.images.length}장 읽음 (${parts.join('').length}자)`);
    } catch (err) {
      log.push(`공지 ${n.id} 이미지 읽기 실패: ${(err as Error).message.slice(0, 80)}`);
    }
  }
  return log;
}
