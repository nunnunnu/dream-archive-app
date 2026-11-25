/**
 * 문서 처리: 공지 본문, 대표 기사 본문, 제보 글 → AI 일정 추출 → 원문 대조 → 저장
 * 이미 처리한 문서(본문 해시·프롬프트 버전이 같음)는 다시 부르지 않는다.
 */
import { AiHttpError } from './ai-provider.ts';
import type { Page } from 'playwright';
import { openArticle } from './articleBody.ts';
import type { Budget } from './budget.ts';
import { clusterArticles, looksLikeSchedule, type Cluster } from './cluster.ts';
import type { SourceRef } from './consolidate.ts';
import { ARTICLE_PROMPT_VERSION, checkAgainstSource, extractArticleEvents, extractNoticeEvents, extractVideoEvents, hasLlmKey, LLM_MODEL, NOTICE_PROMPT_VERSION, VIDEO_PROMPT_VERSION, videoSourceText } from './llm.ts';
import { noticeSource } from './noticeImages.ts';
import { fillVideoDetails, isAppearance, isArchiveClip, loadRecentVideos } from './youtube.ts';
import { GROUP_NAME_RE } from './group.ts';
import { isHidden } from './members.ts';
import { topicOf } from './topics.ts';
import type { ArticleRecord, Repo } from './repo.ts';
import { createHash } from 'node:crypto';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export async function processNotices(repo: Repo, budget: Budget, now: Date, opts: { sinceDays: number }): Promise<string[]> {
  const log: string[] = [];
  const since = new Date(now.getTime() - opts.sinceDays * 24 * 3600 * 1000).toISOString();
  const notices = (await repo.listNotices()).filter((n) => !isHidden(n.title) && n.postedAt >= since).sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  for (const n of notices) {
    const ext = await repo.getExtraction('notice', n.id);
    const { body, hash: contentHash } = await noticeSource(repo, n);
    if (ext && ext.contentHash === contentHash && ext.promptVersion === NOTICE_PROMPT_VERSION) continue;
    if (!hasLlmKey() || !budget.canSpend()) break;
    if (!body) continue;
    try {
      const r = await extractNoticeEvents({ title: n.title, postedAt: n.postedAt, body });
      budget.record(r.usage.costUsd);
      const { kept, dropped } = checkAgainstSource(r.value, `${n.title}\n${body}`);
      const source: SourceRef = { type: 'weverse-notice', id: n.id, url: n.url, title: n.title, publishedAt: n.postedAt };
      await repo.putExtraction({
        docType: 'notice', docId: n.id, model: LLM_MODEL, promptVersion: NOTICE_PROMPT_VERSION, contentHash,
        events: r.value, checked: kept, dropped, source, usage: r.usage, createdAt: now.toISOString(),
      });
      log.push(`공지 ${n.id}: 일정 ${kept.length}개`);
    } catch (err) {
      log.push(`공지 ${n.id} AI 실패: ${(err as Error).message}`);
    }
  }
  return log;
}

/**
 * 기사: 같은 소식끼리 묶고, 일정과 관계있어 보이는 묶음만 대표 기사 하나의 본문을 읽어 AI로 해석한다.
 * 본문을 못 읽으면 같은 묶음의 다음 기사를 시도한다 (최대 3개). 묶음 여러 개를 동시에 처리한다.
 */
export async function processArticles(
  repo: Repo,
  newPage: () => Promise<Page>,
  budget: Budget,
  now: Date,
  opts: { windowDays: number; concurrency?: number; deadline?: number },
): Promise<string[]> {
  const log: string[] = [];
  const articles = await repo.listArticles(new Date(now.getTime() - opts.windowDays * 24 * 3600 * 1000).toISOString());
  const clusters = clusterArticles(articles).sort(
    (a, b) => Math.max(...b.articles.map((x) => Date.parse(x.publishedAt))) - Math.max(...a.articles.map((x) => Date.parse(x.publishedAt))),
  );

  // 처리할 묶음 고르기
  const queue: { c: Cluster; pending: ArticleRecord[] }[] = [];
  for (const c of clusters) {
    const done = c.articles.find((a) => a.status === 'processed');
    if (done) {
      for (const a of c.articles) if (a.status === 'pending' || !a.status) Object.assign(a, { status: 'skipped', note: `같은 소식: ${done.guid}` });
      const stale: ArticleRecord[] = [];
      for (const a of c.articles.filter((x) => x.status === 'processed')) {
        const ext = await repo.getExtraction('article', a.guid);
        if (!ext || ext.promptVersion !== ARTICLE_PROMPT_VERSION) stale.push(a);
      }
      if (stale.length) queue.push({ c, pending: stale });
      continue;
    }
    // 예전 기준으로 "일정과 무관"이라 건너뛴 묶음도 지금 기준으로 다시 본다
    // 본문을 못 읽어 실패한 것(Actions에서 구글 뉴스 링크가 원문으로 안 넘어감)과 예전 타이틀곡 채우기에서 목록용으로만 둔 "지난 기사"도 다시 본다
    const pending = c.articles.filter((a) => a.status === 'pending' || !a.status || (a.status === 'skipped' && (a.note === '일정과 무관해 보임' || a.note?.startsWith('지난 기사'))) || (a.status === 'failed' && (a.note === '본문을 못 읽음' || /^AI 실패: (Groq|OpenAI) 요청 실패 429/.test(a.note ?? ''))));
    if (!pending.length) continue;
    if (!looksLikeSchedule(c) && !c.articles.some((a) => a.origin === 'followup')) {
      for (const a of pending) Object.assign(a, { status: 'skipped', note: '일정과 무관해 보임' });
      continue;
    }
    queue.push({ c, pending });
  }

  async function handle(page: Page, c: Cluster, pending: ArticleRecord[]) {
    // 대표 기사: 빈칸 채우기 검색으로 찾은 것 → 먼저 나온 것 순서
    const reps = [...pending].sort((a, b) => Number(b.origin === 'followup') - Number(a.origin === 'followup') || a.publishedAt.localeCompare(b.publishedAt)).slice(0, 3);
    for (const rep of reps) {
      let body = await repo.getBody('article', rep.guid);
      let url = rep.link;
      if (!body) {
        const opened = await openArticle(page, rep.link).catch(() => null);
        if (opened) {
          body = opened.text;
          url = opened.url;
          rep.originalUrl = opened.url;
          rep.image = opened.image;
          rep.imageCheckedAt = now.toISOString();
          if (opened.publishedAt) rep.pagePublishedAt = opened.publishedAt;
          await repo.putBody('article', rep.guid, body);
        } else if (rep === reps.at(-1) || reps.length === 1) {
          // 원문을 못 열면(데이터센터 IP에서 구글 뉴스가 원문으로 안 넘겨 줌 — 우회하지 않음) 제목과 게시일만으로 뽑는다.
          // 본문으로 저장하지 않아서 나중에 원문을 읽을 수 있으면 다시 처리된다
          body = `(본문을 열지 못해 제목만 있음) ${rep.title}`;
        } else {
          Object.assign(rep, { status: 'failed', note: '본문을 못 읽음' });
          continue;
        }
      }
      // 구글 뉴스 날짜보다 기사 주소 속 날짜 → 기사 페이지 날짜를 믿는다 (옛 기사가 새 날짜로 다시 올라오는 경우:
      //  조선일보 2016년 기사가 사이트 이전 때문에 2020-07로 나옴 → "오늘 데뷔 곡 MV 공개"가 2020년 일정이 됐음)
      const byUrl = urlDateOf(rep.originalUrl ?? url);
      if (byUrl && Math.abs(Date.parse(byUrl) - Date.parse(rep.publishedAt.slice(0, 10))) > 3 * 864e5) rep.publishedAt = `${byUrl}T03:00:00.000Z`;
      const writtenAt = byUrl && Math.abs(Date.parse(byUrl) - Date.parse((rep.pagePublishedAt ?? rep.publishedAt).slice(0, 10))) > 3 * 864e5 ? rep.publishedAt : rep.pagePublishedAt ?? rep.publishedAt;
      try {
        const r = await extractArticleEvents({ title: rep.title, publishedAt: writtenAt, body }, rep.focus);
        budget.record(r.usage.costUsd);
        const { kept, dropped } = checkAgainstSource(r.value, `${rep.title}\n${body}`, writtenAt);
        const source: SourceRef = { type: 'news', id: rep.guid, url, title: rep.title, publisher: rep.source, publishedAt: writtenAt };
        await repo.putExtraction({
          docType: 'article', docId: rep.guid, model: LLM_MODEL, promptVersion: ARTICLE_PROMPT_VERSION, contentHash: hash(body),
          events: r.value, checked: kept, dropped, source, usage: r.usage, createdAt: now.toISOString(),
        });
        Object.assign(rep, { status: 'processed', note: `일정 ${kept.length}개` });
        for (const a of c.articles) if (a !== rep && (a.status === 'pending' || !a.status)) Object.assign(a, { status: 'skipped', note: `같은 소식: ${rep.guid}` });
        log.push(`기사 "${rep.title.slice(0, 40)}"${c.articles.length > 1 ? ` 외 ${c.articles.length - 1}개` : ''}: 일정 ${kept.length}개`);
      } catch (err) {
        // AI 한도·잔액(429)은 기사 탓이 아니라서 그대로 두고 다음 실행에 다시 (실패로 적으면 다시 읽지 않는다)
        if (err instanceof AiHttpError && err.status === 429) return;
        Object.assign(rep, { status: 'failed', note: `AI 실패: ${(err as Error).message.slice(0, 80)}` });
      }
      return;
    }
  }

  const workers = Array.from({ length: opts.concurrency ?? 4 }, async () => {
    const page = await newPage();
    try {
      while (queue.length && hasLlmKey() && budget.canSpend() && (!opts.deadline || Date.now() < opts.deadline)) {
        const { c, pending } = queue.shift()!;
        await handle(page, c, pending);
      }
    } finally {
      await page.close();
    }
  });
  await Promise.all(workers);
  if (queue.length) log.push(`이번 실행 한도로 남은 기사 묶음 ${queue.length}개는 다음 실행 때 처리`);

  // 일정이 아니라서 AI 해석에서 빠지는 화보·공항 기사도 카드 사진과 정상 원문 링크만 확인한다.
  // 막힌 사이트는 우회하지 않고, 실행마다 최근 항목 몇 개만 재시도한다.
  const visual = articles
    .filter((a) => topicOf(a.title) && (!a.imageCheckedAt || Date.now() - Date.parse(a.imageCheckedAt) > 7 * 864e5))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 8);
  if (visual.length) {
    const page = await newPage();
    try {
      for (const article of visual) {
        const opened = await openArticle(page, article.link).catch(() => null);
        article.imageCheckedAt = now.toISOString();
        if (!opened) continue;
        article.originalUrl = opened.url;
        article.image = opened.image;
      }
    } finally { await page.close(); }
  }

  // 묶음 번호(clusterId)와 처리 상태를 저장
  await repo.putArticles(articles);
  return log;
}

/** 출연 탐색으로 찾은 영상: 제목·설명·공개 시각을 AI가 해석 (출연분 공개인지, 행사 취재인지) */
export async function processVideos(repo: Repo, budget: Budget, now: Date): Promise<string[]> {
  const log: string[] = [];
  const videos = (await loadRecentVideos(now, 2)).filter((v) => v.guest && isAppearance(v.title, v.description ?? '') && !isArchiveClip(v.title, v.description ?? '', v.publishedAt));
  const todo: typeof videos = [];
  for (const v of videos) {
    const ext = await repo.getExtraction('video', v.videoId);
    if (!ext || ext.promptVersion !== VIDEO_PROMPT_VERSION || ext.contentHash !== hash(videoSourceText(v))) todo.push(v);
  }
  if (!todo.length) return log;
  await fillVideoDetails(todo).catch((err) => log.push(`영상 설명 가져오기 실패: ${(err as Error).message}`));
  // 영상은 서로 독립이라 여러 개를 동시에 해석한다
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      if (!hasLlmKey() || !budget.canSpend()) break;
      const v = queue.shift()!;
      try {
        const r = await extractVideoEvents(v);
        budget.record(r.usage.costUsd);
        const text = videoSourceText(v);
        const checked = checkAgainstSource(r.value, text);
        // 멤버가 비어 있는 일정(단체)은 제목·설명에 그룹 이름이 직접 있을 때만 (다른 팀 영상 오인 방지)
        const groupNamed = GROUP_NAME_RE.test(`${v.title}\n${v.description ?? ''}`);
        // 티저·예고 영상은 본편 공개 일정만 의미가 있다: 티저 자체의 공개 시각으로 만든 일정은 버린다
        const teaser = /teaser|티저|예고|coming\s*soon/i.test(v.title.normalize('NFKC'));
        const kept = checked.kept.filter((e) => (e.members.length || groupNamed) && !(teaser && /영상 공개 시각/.test(e.evidence)));
        const dropped = [...checked.dropped, ...checked.kept.filter((e) => !kept.includes(e)).map((event) => ({ event, reason: '그룹·멤버 언급 없음' }))];
        const source: SourceRef = { type: 'youtube', id: v.videoId, url: v.url, title: v.title, publisher: v.channel, publishedAt: v.publishedAt };
        await repo.putExtraction({
          docType: 'video', docId: v.videoId, model: LLM_MODEL, promptVersion: VIDEO_PROMPT_VERSION, contentHash: hash(text),
          events: r.value, checked: kept, dropped, source, usage: r.usage, createdAt: now.toISOString(),
        });
        log.push(`영상 "${v.title.slice(0, 40)}" (${v.channel}): 일정 ${kept.length}개`);
      } catch (err) {
        log.push(`영상 ${v.videoId} AI 실패: ${(err as Error).message.slice(0, 80)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  return log;
}

/** 기사 주소 속 날짜 ("/2016/08/24/", "/20160824…"). 없으면 null */
export function urlDateOf(url?: string): string | null {
  if (!url) return null;
  let path = '';
  try { path = new URL(url).pathname; } catch { return null; }
  const m = /\/(20\d{2})[\/-]?(0[1-9]|1[0-2])[\/-]?(0[1-9]|[12]\d|3[01])(?=\/|\d|\.|$)/.exec(path);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
