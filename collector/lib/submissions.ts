/**
 * 링크 제보: 자동 수집이 못 잡는 글(웨이보, 개별 X 글, 기타 사이트)을 직접 넣는 창구.
 *  - X(트위터): 공개 oEmbed로 본문·작성일을 가져온다 (무료, 키 없음)
 *  - 유튜브: 공식 API로 제목·설명·공개 시각 (키 있을 때)
 *  - 웨이보: 로그인 없이 못 읽어서, 제보할 때 글 내용을 함께 붙여 넣어야 한다
 *  - 그 밖의 사이트: 브라우저로 열어 본문을 읽는다
 * 가져온 글은 기사와 같은 방식(AI 추출 → 원문 대조)으로 일정이 된다.
 */
import type { Page } from 'playwright';
import { createHash } from 'node:crypto';
import { openArticle } from './articleBody.ts';
import type { Budget } from './budget.ts';
import type { SourceRef } from './consolidate.ts';
import { decodeEntities } from './googleNews.ts';
import { ARTICLE_PROMPT_VERSION, checkAgainstSource, extractArticleEvents, hasLlmKey, LLM_MODEL } from './llm.ts';
import type { Repo } from './repo.ts';

export interface Submission {
  id: string;
  url: string;
  /** 직접 붙여 넣은 글 (웨이보 등 못 읽는 곳) */
  text?: string;
  /** 제보 메모 (예: "지성 추측") */
  note?: string;
  addedAt: string;
  status: 'pending' | 'processed' | 'needs-text' | 'failed';
}

export const submissionId = (url: string) => createHash('sha1').update(url.split('?')[0]).digest('hex').slice(0, 12);

export async function addSubmission(repo: Repo, url: string, text: string | undefined, now: Date, note?: string): Promise<Submission> {
  const list = await repo.getState<Submission[]>('submissions', []);
  const id = submissionId(url);
  const existing = list.find((s) => s.id === id);
  const sub: Submission = { id, url, text: text ?? existing?.text, note: note ?? existing?.note, addedAt: existing?.addedAt ?? now.toISOString(), status: 'pending' };
  await repo.putState('submissions', [...list.filter((s) => s.id !== id), sub]);
  return sub;
}

/** X 글: oEmbed HTML에서 본문과 작성일 ("— 이름 (@id) November 11, 2026") */
async function fetchX(url: string): Promise<{ title: string; text: string; publishedAt: string } | null> {
  const res = await fetch(`https://publish.x.com/oembed?url=${encodeURIComponent(url.split('?')[0])}&omit_script=1`);
  if (!res.ok) return null;
  const d = (await res.json()) as { author_name: string; html: string };
  const plain = decodeEntities(d.html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
  const date = plain.match(/(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/)?.[0];
  return { title: `${d.author_name}의 X 글`, text: plain, publishedAt: date ? new Date(`${date} 12:00 GMT+0900`).toISOString() : new Date().toISOString() };
}

async function fetchYouTube(url: string): Promise<{ title: string; text: string; publishedAt: string } | null> {
  const id = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1];
  const key = process.env.YOUTUBE_API_KEY;
  if (!id || !key) return null;
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${key}`);
  if (!res.ok) return null;
  const s = ((await res.json()) as { items: { snippet: { title: string; description: string; publishedAt: string; channelTitle: string } }[] }).items[0]?.snippet;
  return s ? { title: `${s.channelTitle}: ${s.title}`, text: `${s.title}\n${s.description}`, publishedAt: s.publishedAt } : null;
}

export async function processSubmissions(repo: Repo, page: Page, budget: Budget, now: Date): Promise<string[]> {
  const list = await repo.getState<Submission[]>('submissions', []);
  const log: string[] = [];
  for (const sub of list.filter((s) => s.status === 'pending')) {
    if (!hasLlmKey() || !budget.canSpend()) break;
    let doc: { title: string; text: string; publishedAt: string } | null = null;
    if (sub.text) doc = { title: sub.url, text: sub.text, publishedAt: sub.addedAt };
    else if (/(^|\/\/)(x|twitter)\.com\//.test(sub.url)) doc = await fetchX(sub.url);
    else if (/youtu\.?be/.test(sub.url)) doc = await fetchYouTube(sub.url);
    else if (/weibo\./.test(sub.url)) {
      Object.assign(sub, { status: 'needs-text' });
      continue;
    } else {
      const opened = await openArticle(page, sub.url).catch(() => null);
      if (opened) doc = { title: sub.url, text: opened.text, publishedAt: sub.addedAt };
    }
    if (!doc) {
      Object.assign(sub, { status: 'failed' });
      continue;
    }
    try {
      const r = await extractArticleEvents({ title: doc.title, publishedAt: doc.publishedAt, body: doc.text }, undefined, { note: sub.note });
      budget.record(r.usage.costUsd);
      const { kept, dropped } = checkAgainstSource(r.value, `${doc.title}\n${doc.text}`, doc.publishedAt);
      const source: SourceRef = { type: 'submission', id: sub.id, url: sub.url, title: doc.title, publishedAt: doc.publishedAt };
      await repo.putExtraction({
        docType: 'submission', docId: sub.id, model: LLM_MODEL, promptVersion: ARTICLE_PROMPT_VERSION,
        contentHash: createHash('sha256').update(doc.text).digest('hex').slice(0, 16),
        events: r.value, checked: kept, dropped, source, usage: r.usage, createdAt: now.toISOString(),
      });
      Object.assign(sub, { status: 'processed' });
      log.push(`제보 ${sub.url.slice(0, 50)}: 일정 ${kept.length}개`);
    } catch (err) {
      Object.assign(sub, { status: 'failed' });
      log.push(`제보 ${sub.url.slice(0, 50)} 실패: ${(err as Error).message.slice(0, 100)}`);
    }
  }
  await repo.putState('submissions', list);
  return log;
}
