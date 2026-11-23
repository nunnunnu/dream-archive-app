/**
 * 사이트 제보 자동 검증.
 * - 추가·보완: 공식 출처를 AI가 읽고 원문 대조를 통과한 경우만 자동 승인
 * - 삭제: reportDelete.ts가 판정한다 (공식 출처가 있는 일정은 사람 확인, 그 밖에는 AI가 확실히 맞다고 볼 때만 자동 삭제)
 * - 판정과 자동 보완은 data/state에 저장해 다음 GitHub Actions 실행에도 유지한다
 */
import { GROUP } from './group.ts';
import type { ExtractionRecord, Repo } from './repo.ts';
import { submissionId, addSubmission, type Submission } from './submissions.ts';
import type { OverrideTarget, Overrides } from './overrides.ts';
import { hideEntry, isNewsDelete, NEWS_HIDE_STATE, type NewsHide } from './newsHide.ts';

export interface Report {
  id: string;
  /** news: 소식 제보 (일정이 아닌 소식도. reportNews.ts가 판정해 소식 탭에) */
  type: 'add' | 'delete' | 'fix' | 'news';
  title?: string;
  url: string;
  message: string;
  eventId: string;
  eventTitle: string;
  /** 삭제 요청 대상: 없으면 일정, 'news'면 소식 (newsUrl 로 찾는다, newsHide.ts) */
  target?: 'event' | 'news';
  newsUrl?: string;
  newsTitle?: string;
  date: string;
  time: string;
  endDate?: string;
  endTime?: string;
  reasonCode?: string;
  eventSnapshot?: object | null;
  members: string[];
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  reviewMode?: 'auto' | 'manual';
  reviewReason?: string;
}

interface KvConfig { accountId: string; token: string; namespaceId: string }

const config = (): KvConfig | null => {
  const accountId = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  const namespaceId = process.env.CF_KV_REPORTS_ID;
  return accountId && token && namespaceId ? { accountId, token, namespaceId } : null;
};

const kv = (c: KvConfig, path: string, init?: RequestInit) => fetch(
  `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/storage/kv/namespaces/${c.namespaceId}${path}`,
  { ...init, headers: { Authorization: `Bearer ${c.token}`, ...(init?.headers ?? {}) } },
);

/** 판정한 제보 상태를 사이트(KV)에도 저장 (설정이 없으면 건너뜀) */
export async function saveReport(r: Report) {
  const c = config();
  if (c) await saveRemote(c, r);
}

/** 대기 중인 제보의 판정 이유가 바뀌면 사이트(KV)에도 저장 (어드민 화면에서 "AI가 넘긴 이유"로 보인다) */
const remoteReason = new Map<string, string>();
export async function pushPendingReasons(reports: Record<string, Report>): Promise<number> {
  const c = config();
  if (!c) return 0;
  let n = 0;
  for (const r of Object.values(reports)) {
    if (r.status !== 'pending' || !r.reviewReason || remoteReason.get(r.id) === r.reviewReason) continue;
    await saveRemote(c, r).catch(() => {});
    remoteReason.set(r.id, r.reviewReason);
    n++;
  }
  return n;
}

async function saveRemote(c: KvConfig, r: Report) {
  const res = await kv(c, `/values/${encodeURIComponent(`report:${r.id}`)}`, { method: 'PUT', body: JSON.stringify(r) });
  if (!res.ok) throw new Error(`제보 상태 저장 실패 ${res.status}`);
}

export async function pullReports(repo: Repo): Promise<{ reports: Record<string, Report>; fetched: number }> {
  const reports = await repo.getState<Record<string, Report>>('reports', {});
  const c = config();
  if (!c) return { reports, fetched: 0 };
  const res = await kv(c, '/keys?prefix=report:');
  if (!res.ok) throw new Error(`제보 목록 읽기 실패 ${res.status}`);
  const keys = ((await res.json()) as { result?: { name: string }[] }).result ?? [];
  let fetched = 0;
  for (const k of keys) {
    const id = k.name.slice('report:'.length);
    // 처음 보는 제보이거나 아직 판정 전인 것만 가져온다 (전에는 처음 보는 제보를 건너뛰어서 새 제보가 하나도 안 들어왔다)
    if (reports[id] && reports[id].status !== 'pending') continue;
    const value = await kv(c, `/values/${encodeURIComponent(k.name)}`);
    if (!value.ok) continue;
    const incoming = await value.json() as Report;
    // 원격 pending 상태는 로컬에서 이미 끝낸 판정을 되돌리지 않는다.
    if (!reports[id] || reports[id].status === 'pending') reports[id] = incoming;
    remoteReason.set(id, incoming.reviewReason ?? '');
    fetched++;
  }
  await repo.putState('reports', reports);
  return { reports, fetched };
}

/** 공식 출처가 필요한 제보를 기존 제보 추출 파이프라인에 넣는다. */
export async function queueReports(repo: Repo, reports: Record<string, Report>, now: Date): Promise<number> {
  const submissions = await repo.getState<Submission[]>('submissions', []);
  const known = new Set(submissions.map((s) => s.id));
  let queued = 0;
  for (const r of Object.values(reports)) {
    if (r.status !== 'pending' || r.type === 'delete' || !r.url) continue;
    if (known.has(submissionId(r.url))) continue;
    await addSubmission(repo, r.url, undefined, now, `[자동 검증 ${r.id}] ${r.title ?? ''} ${r.message}`.trim());
    known.add(submissionId(r.url));
    queued++;
  }
  return queued;
}

const ownChannels = new Set(GROUP.youtube.channels.map((c) => c.name));
export function isOfficialReportSource(ext: ExtractionRecord): boolean {
  try {
    const host = new URL(ext.source.url).hostname.replace(/^www\./, '');
    if (host === 'weverse.io' || host.endsWith('.weverse.io')) return true;
    if (host === 'youtube.com' || host === 'youtu.be') {
      // fetchYouTube가 저장한 제목은 "채널명: 영상명" 형식이다.
      return [...ownChannels].some((name) => ext.source.title.startsWith(`${name}:`));
    }
  } catch { /* 잘못된 URL은 공식 출처가 아니다. */ }
  return false;
}

const sameMembers = (claimed: string[], actual: string[]) => claimed.every((m) => actual.includes(m));
const matching = (r: Report, ext: ExtractionRecord) => ext.checked.filter((e) =>
  (!r.date || e.date === r.date)
  && (!r.time || e.time === r.time)
  && (!r.members.length || sameMembers(r.members, e.members)),
);

export async function finalizeReports(repo: Repo, reports: Record<string, Report>, now: Date): Promise<{ approved: number; pending: number }> {
  const c = config();
  const stateOverrides = await repo.getState<Overrides>('report-overrides', { hide: [], patch: [] });
  let approved = 0;
  for (const r of Object.values(reports)) {
    if (r.status !== 'pending') continue;
    if (r.type === 'news') continue; // 소식 제보는 합칠 때 판정한다 (reportNews.ts)
    if (r.type === 'delete') {
      continue; // 삭제는 합칠 때 일정을 보고 판정한다 (reportDelete.ts)
    }
    if (!r.url) {
      r.reviewReason = '자동 검증할 원문 링크가 없어요.';
      continue;
    }
    const ext = await repo.getExtraction('submission', submissionId(r.url));
    if (!ext) {
      r.reviewReason = '원문을 아직 읽지 못했어요.';
      continue;
    }
    if (!isOfficialReportSource(ext)) {
      r.reviewReason = '등록된 공식 출처가 아니라 수동 확인이 필요해요.';
      continue;
    }
    const found = matching(r, ext);
    if (!found.length) {
      r.reviewReason = '제보한 날짜·시간·멤버를 원문에서 확인하지 못했어요.';
      continue;
    }
    if (r.type === 'fix') {
      const target = { id: r.eventId, date: r.date, title: r.eventTitle, reason: r.message, reportId: r.id };
      stateOverrides.patch = stateOverrides.patch.filter((p) => p.reportId !== r.id);
      stateOverrides.patch.push({ ...target, set: { ...(r.date ? { date: r.date } : {}), ...(r.time ? { time: r.time } : {}), ...(r.members.length ? { members: r.members } : {}), url: r.url } });
    }
    Object.assign(r, { status: 'approved', reviewedAt: now.toISOString(), reviewMode: 'auto', reviewReason: '공식 원문 대조를 통과해 자동 승인했어요.' });
    approved++;
    if (c) await saveRemote(c, r);
  }
  await repo.putState('report-overrides', stateOverrides);
  await repo.putState('reports', reports);
  return { approved, pending: Object.values(reports).filter((r) => r.status === 'pending').length };
}

/** 어드민에서 내린 운영자 결정 (사이트 KV report-decision:<id>) */
export interface ReportDecision { action: 'approve' | 'reject'; note?: string; at: string; by?: string }

/** 제보가 가리키는 일정: 제보할 때 함께 온 일정 정보 → 없으면 "11. 20 대상 · 단계" 제목에서 */
export function reportTarget(r: Report, year: string): OverrideTarget {
  const snap = (r.eventSnapshot ?? {}) as { id?: string; date?: string; title?: string; step?: string };
  if (snap.date && snap.title) return { id: snap.id ?? r.eventId, date: snap.date, title: `${snap.title} ${snap.step ?? ''}`.trim(), reason: r.message, reportId: r.id };
  const m = /^(\d{1,2})\.\s*(\d{1,2})\s+(.+)$/.exec(r.eventTitle.trim());
  const date = r.date || (m ? `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '');
  return { id: r.eventId, date, title: (m?.[3] ?? r.eventTitle).replace(/…/g, '').replace(/\s+·\s+/, ' ').trim(), reason: r.message, reportId: r.id };
}

/**
 * 운영자 결정 하나를 적용한다 (덮어쓰기는 overrides에 직접 반영, 저장은 부르는 쪽에서).
 *  승인: 삭제 → 숨기기(소식이면 소식 탭에서 빼기), 보완 → 고치기, 추가 → 링크를 제보 처리 대기열에(submit), 소식 → 소식 탭에 (reportedFeed가 approved를 읽음)
 *  거절: 상태만 바꾼다
 *  링크 없는 추가 요청은 자동으로 넣을 수 없어서 대기로 두고 이유를 남긴다
 */
export function decideReport(r: Report, d: ReportDecision, overrides: Overrides, now: Date, newsHidden: NewsHide[] = []): { applied: boolean; submit?: string; message: string } {
  const by = d.note ? ` (메모: ${d.note})` : '';
  if (d.action === 'reject') {
    Object.assign(r, { status: 'rejected', reviewedAt: now.toISOString(), reviewMode: 'manual', reviewReason: `운영자가 거절했어요${by}` });
    return { applied: true, message: `제보 ${r.id}: 운영자 거절` };
  }
  let submit: string | undefined;
  if (r.type === 'add') {
    if (!r.url) {
      r.reviewReason = `운영자가 승인했지만 링크가 없어 자동으로 넣지 못했어요. npm run submit 으로 직접 넣어 주세요${by}`;
      return { applied: false, message: `제보 ${r.id}: 링크 없는 추가 요청이라 직접 넣어야 함` };
    }
    submit = r.url;
  } else if (isNewsDelete(r)) {
    const kept = newsHidden.filter((h) => h.reportId !== r.id);
    newsHidden.length = 0;
    newsHidden.push(...kept, hideEntry(r, undefined, `운영자 승인${by}`, now));
  } else if (r.type === 'delete') {
    const t = reportTarget(r, now.toISOString().slice(0, 4));
    overrides.hide = overrides.hide.filter((h) => h.reportId !== r.id);
    overrides.hide.push(t);
  } else if (r.type === 'fix') {
    const t = reportTarget(r, now.toISOString().slice(0, 4));
    overrides.patch = overrides.patch.filter((p) => p.reportId !== r.id);
    overrides.patch.push({ ...t, set: { ...(r.date ? { date: r.date } : {}), ...(r.time ? { time: r.time } : {}), ...(r.members.length ? { members: r.members } : {}), ...(r.url ? { url: r.url } : {}) } });
  }
  Object.assign(r, { status: 'approved', reviewedAt: now.toISOString(), reviewMode: 'manual', reviewReason: `운영자가 승인했어요${by}` });
  return { applied: true, submit, message: `제보 ${r.id}: 운영자 승인 (${r.type})` };
}

/** 어드민 결정 가져와 적용: 적용한 결정은 KV에서 지운다. 수집 실행마다 pullReports 바로 뒤에 부른다 */
export async function applyReportDecisions(repo: Repo, reports: Record<string, Report>, now: Date): Promise<string[]> {
  const c = config();
  if (!c) return [];
  const res = await kv(c, '/keys?prefix=report-decision:');
  if (!res.ok) return [`어드민 결정 읽기 실패 ${res.status}`];
  const keys = ((await res.json()) as { result?: { name: string }[] }).result ?? [];
  if (!keys.length) return [];
  const overrides = await repo.getState<Overrides>('report-overrides', { hide: [], patch: [] });
  const newsHidden = await repo.getState<NewsHide[]>(NEWS_HIDE_STATE, []);
  const log: string[] = [];
  for (const k of keys) {
    const id = k.name.slice('report-decision:'.length);
    const value = await kv(c, `/values/${encodeURIComponent(k.name)}`);
    const d = value.ok ? (await value.json().catch(() => null)) as ReportDecision | null : null;
    const r = reports[id];
    const drop = () => kv(c, `/values/${encodeURIComponent(k.name)}`, { method: 'DELETE' });
    if (!d || !r || r.status !== 'pending') {
      log.push(`어드민 결정 ${id}: ${!r ? '제보를 못 찾음' : !d ? '읽지 못함' : '이미 처리된 제보'} → 지움`);
      await drop();
      continue;
    }
    const out = decideReport(r, d, overrides, now, newsHidden);
    // 자동 검증 때 이미 대기열에 들어간 링크는 다시 읽지 않는다 (addSubmission은 처리 상태를 처음으로 되돌린다)
    if (out.submit && !(await repo.getState<Submission[]>('submissions', [])).some((s) => s.id === submissionId(out.submit!))) {
      await addSubmission(repo, out.submit, undefined, now, `[운영자 승인 ${r.id}] ${r.title ?? ''} ${r.message}`.trim());
    }
    await saveRemote(c, r);
    remoteReason.set(r.id, r.reviewReason ?? '');
    await drop();
    log.push(out.message);
  }
  await repo.putState('report-overrides', overrides);
  await repo.putState(NEWS_HIDE_STATE, newsHidden);
  await repo.putState('reports', reports);
  return log;
}
