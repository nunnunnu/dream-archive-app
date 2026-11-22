/**
 * 위버스 공지 수집
 *  1. (주) highlight: 최신 공지 4개 중 처음 보는 제목을 눌러 본문을 읽는다. 팬 글은 화제 키워드에만 쓴다(저장 안 함).
 *  2. (대체) 번호 직접 확인: highlight를 못 읽었을 때만. 공지 번호는 위버스 전체에서 순서대로 매겨진다.
 *  3. (보조) 구글 뉴스 RSS: 위 두 방법이 놓친 공지.
 *  4. 작성 후 3일 안의 공지는 매번 다시 읽어 수정 사항을 반영한다.
 * 공지 목록(본문 제외)은 저장소에, 본문은 원문 캐시에 둔다.
 */
import type { Page } from 'playwright';
import {
  BACKFILL_FROM,
  GAP_RECHECK_HOURS,
  MAX_FRONTIER_MISSES,
  MAX_GAP_RECHECKS_PER_RUN,
  MAX_PROBES_PER_RUN,
  NAV_DELAY_MS,
  NOTICE_TITLE_RE,
  RECENT_WINDOW,
  RECHECK_DAYS,
  WEVERSE_COMMUNITY,
  WEVERSE_QUERIES,
} from '../config.ts';
import { googleNewsBlocked, searchGoogleNews, type NewsItem } from './googleNews.ts';
import { openHighlightNotice, readHighlight } from './highlight.ts';
import type { NoticeRecord, Repo } from './repo.ts';
import { sleep } from './time.ts';
import { noticeUrl, probeNotice, readNotice, readOpenNotice, resolveGoogleNewsLink, type NoticeContent, type NoticeRef } from './weverse.ts';

type ResolvedCache = Record<string, string | null>;
interface ProbeState {
  nextId: number;
  gaps: Record<string, string>;
}

export interface WeverseResult {
  /** 새로 생기거나 본문이 바뀐 공지 번호 */
  changed: string[];
  /** highlight 팬 글 본문 (화제 키워드용, 저장하지 않음) */
  fanPostTexts: string[];
  log: string[];
}

function monthWindows(from: string, until: Date): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const endY = until.getUTCFullYear();
  const endM = until.getUTCMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    out.push(`after:${y}-${String(m).padStart(2, '0')}-01 before:${ny}-${String(nm).padStart(2, '0')}-01`);
    [y, m] = [ny, nm];
  }
  return out;
}

export async function collectWeverse(repo: Repo, page: Page, now: Date, opts: { backfill?: boolean } = {}): Promise<WeverseResult> {
  const nowIso = now.toISOString();
  const recheckSince = now.getTime() - RECHECK_DAYS * 24 * 60 * 60 * 1000;
  const notices = new Map((await repo.listNotices()).map((n) => [n.id, n]));
  const resolved = await repo.getState<ResolvedCache>('weverse/resolved', {});
  let probe = await repo.getState<ProbeState | null>('weverse/probe', null);
  const changed: string[] = [];
  const log: string[] = [];
  const stats = { probed: 0, failed: 0 };

  async function upsert(ref: NoticeRef, content: NoticeContent, via: string) {
    const existing = notices.get(ref.id);
    if (existing && existing.bodyHash === content.bodyHash && existing.title === content.title) {
      // 본문은 그대로지만 이미지 주소를 처음 확인한 경우
      if (!existing.images && content.images.length) notices.set(ref.id, { ...existing, images: content.images });
      return;
    }
    const rec: NoticeRecord = {
      id: ref.id,
      community: ref.community,
      url: noticeUrl(ref),
      title: content.title,
      postedAt: content.postedAt,
      bodyHash: content.bodyHash,
      firstFetchedAt: existing?.firstFetchedAt ?? nowIso,
      lastChangedAt: nowIso,
      images: content.images,
    };
    notices.set(ref.id, rec);
    await repo.putBody('notice', ref.id, content.body);
    changed.push(ref.id);
    log.push(`${existing ? '~ 수정' : '+ 새 공지'} ${ref.id} ${content.title} (${via})`);
  }

  try {
    // 3) 구글 뉴스: 공지로 보이는 글 → 공지 번호 (결과 캐시)
    const windows = opts.backfill ? monthWindows(BACKFILL_FROM, now) : [RECENT_WINDOW];
    const candidates = new Map<string, NewsItem>();
    // 구글이 쉬는 중이면 이 보조 방법은 통째로 건너뛴다 (공지 목록·하이라이트로 찾은 공지는 그대로)
    for (const q of googleNewsBlocked() ? [] : WEVERSE_QUERIES) {
      for (const w of windows) {
        if (googleNewsBlocked()) break;
        // 구글 뉴스가 막히면(429) 이 방법만 건너뛰고 하이라이트·공지 목록으로 찾은 공지는 그대로 처리한다
        const found = await searchGoogleNews(`${q} ${w}`).catch((err) => { log.push(`구글 뉴스로 공지 찾기 건너뜀: ${(err as Error).message.slice(0, 60)}`); return [] as NewsItem[]; });
        for (const it of found) if (NOTICE_TITLE_RE.test(it.title) && !candidates.has(it.guid)) candidates.set(it.guid, it);
        if (windows.length > 1) await sleep(NAV_DELAY_MS);
      }
    }
    const googleTargets = new Map<string, { ref: NoticeRef; reference: Date }>();
    for (const item of candidates.values()) {
      if (!(item.guid in resolved)) {
        try {
          const ref = await resolveGoogleNewsLink(page, item.link);
          resolved[item.guid] = ref ? `${ref.community}/${ref.id}` : null;
        } catch {
          continue;
        } finally {
          await sleep(NAV_DELAY_MS);
        }
      }
      const key = resolved[item.guid];
      if (!key) continue;
      const [community, id] = key.split('/');
      if (community !== WEVERSE_COMMUNITY) continue;
      const prev = googleTargets.get(id);
      if (!prev || item.publishedAt < prev.reference) googleTargets.set(id, { ref: { community, id }, reference: item.publishedAt });
    }

    let fanPostTexts: string[] = [];
    if (!opts.backfill) {
      // 1) highlight
      let highlightOk = false;
      try {
        const hl = await readHighlight(page, WEVERSE_COMMUNITY);
        fanPostTexts = hl.fanPostTexts;
        const known = new Set([...notices.values()].map((n) => n.title));
        for (const title of hl.noticeTitles) {
          if (known.has(title)) continue;
          try {
            const ref = await openHighlightNotice(page, WEVERSE_COMMUNITY, title);
            if (ref?.community === WEVERSE_COMMUNITY) await upsert(ref, await readOpenNotice(page, now), 'highlight');
          } catch (err) {
            stats.failed++;
            log.push(`highlight 공지 열기 실패: ${title} (${(err as Error).message})`);
          }
          await sleep(NAV_DELAY_MS);
        }
        highlightOk = hl.noticeTitles.length > 0;
      } catch (err) {
        log.push(`highlight 읽기 실패 → 번호 직접 확인으로 대신함 (${(err as Error).message})`);
      }

      // 2) 번호 직접 확인 (highlight 실패 시)
      const ids = [...notices.keys(), ...Object.values(resolved).flatMap((v) => (v ? [v.split('/')[1]] : []))].map(Number);
      const knownMax = ids.length ? Math.max(...ids) : 0;
      probe ??= { nextId: knownMax + 1, gaps: {} };
      if (highlightOk) {
        probe.nextId = Math.max(probe.nextId, knownMax + 1);
      } else {
        const gapExpiry = now.getTime() - GAP_RECHECK_HOURS * 3600 * 1000;
        for (const [g, at] of Object.entries(probe.gaps)) if (Date.parse(at) < gapExpiry) delete probe.gaps[g];
        const probeOne = async (id: number) => {
          stats.probed++;
          const r = await probeNotice(page, WEVERSE_COMMUNITY, id);
          if (r.status === 'notfound') return false;
          if (r.community === WEVERSE_COMMUNITY) await upsert({ community: WEVERSE_COMMUNITY, id: String(id) }, await readOpenNotice(page, now), '번호 확인');
          return true;
        };
        for (const g of Object.keys(probe.gaps).slice(0, MAX_GAP_RECHECKS_PER_RUN)) {
          if (await probeOne(Number(g)).catch(() => false)) delete probe.gaps[g];
          await sleep(NAV_DELAY_MS);
        }
        let id = probe.nextId;
        let misses: number[] = [];
        for (let n = 0; n < MAX_PROBES_PER_RUN; n++) {
          if (misses.length >= MAX_FRONTIER_MISSES && id > knownMax) break;
          let found: boolean;
          try {
            found = await probeOne(id);
          } catch {
            stats.failed++;
            break;
          }
          if (found) {
            for (const m of misses) probe.gaps[String(m)] = nowIso;
            misses = [];
            probe.nextId = id + 1;
          } else misses.push(id);
          id++;
          await sleep(NAV_DELAY_MS);
        }
      }
    }

    // 구글 뉴스로만 잡힌 공지 + 최근 공지 다시 읽기
    const toRead = new Map(googleTargets);
    for (const n of notices.values()) {
      if (Date.parse(n.postedAt) >= recheckSince && !toRead.has(n.id)) toRead.set(n.id, { ref: { community: n.community, id: n.id }, reference: new Date(n.postedAt) });
    }
    for (const { ref, reference } of toRead.values()) {
      const existing = notices.get(ref.id);
      if (existing && (Date.parse(existing.postedAt) < recheckSince || changed.includes(ref.id))) continue;
      try {
        await upsert(ref, await readNotice(page, ref, reference), '구글 뉴스·재확인');
      } catch (err) {
        stats.failed++;
        log.push(`공지 읽기 실패: ${noticeUrl(ref)} (${(err as Error).message})`);
      }
      await sleep(NAV_DELAY_MS);
    }
    return { changed, fanPostTexts, log };
  } finally {
    await repo.putNotices([...notices.values()]);
    await repo.putState('weverse/resolved', Object.fromEntries(Object.entries(resolved).sort(([a], [b]) => a.localeCompare(b))));
    if (probe) await repo.putState('weverse/probe', probe);
  }
}
