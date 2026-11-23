/**
 * 삭제 제보 자동 판정.
 *  - 공식 출처(위버스 공지·공식 유튜브)가 있는 일정은 사람이 확인한다 (공지에 있으면 사실일 가능성이 높아서)
 *  - 그 밖의 일정은 AI(무료 Groq 작은 모델 → 막히면 nano)가 "드림 일정이 맞는지"와 제보 이유를 함께 보고 판정한다.
 *    제보 이유가 확실히 맞을 때만 자동 승인(숨기기), 애매하면 사람 확인으로 남긴다.
 *  - 일정이 이미 없어졌으면 승인 처리만 한다.
 * 숨기기는 report-overrides(앱 상태)에 저장되고, 같은 실행의 합치기부터 적용된다.
 */
import type { Budget } from './budget.ts';
import type { PublicEvent } from './consolidate.ts';
import { GROUP } from './group.ts';
import { callModel, hasLlmKey } from './llm.ts';
import type { Overrides } from './overrides.ts';
import type { Repo } from './repo.ts';
import { saveReport, type Report } from './reports.ts';

const REASONS: Record<string, string> = { unrelated: '드림 일정이 아님', duplicate: '중복', cancelled: '취소됨', wrong: '잘못된 정보' };
const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/** 제보한 일정 찾기: id가 같거나, 제보 당시 제목("11. 20 대상 · 단계")과 날짜가 같은 것 */
function findEvent(r: Report, events: PublicEvent[]): PublicEvent | undefined {
  const byId = events.find((e) => e.id === r.eventId);
  if (byId) return byId;
  const m = /^(\d{1,2})\.\s*(\d{1,2})\s+(.+?)(?:\s+·\s+(.+))?$/.exec(r.eventTitle.trim());
  if (!m) return undefined;
  const md = `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const title = sq(m[3].replace(/…$/, ''));
  const step = sq((m[4] ?? '').replace(/…$/, ''));
  return events.find((e) => e.date.slice(5) === md && sq(e.title).startsWith(title) && (!step || sq(e.step).startsWith(step)));
}

const isOfficial = (e: PublicEvent) =>
  e.sources.some((s) => s.type === 'weverse-notice' || (s.type === 'youtube' && GROUP.youtube.channels.some((c) => !c.guest && s.title.startsWith(c.name))));

export async function judgeDeleteReports(repo: Repo, reports: Record<string, Report>, events: PublicEvent[], budget: Budget, now: Date): Promise<string[]> {
  const todo = Object.values(reports).filter((r) => r.type === 'delete' && r.target !== 'news' && r.status === 'pending' && r.reviewMode !== 'manual');
  if (!todo.length) return [];
  const overrides = await repo.getState<Overrides>('report-overrides', { hide: [], patch: [] });
  const log: string[] = [];
  const done = (r: Report, reason: string) => { Object.assign(r, { status: 'approved', reviewedAt: now.toISOString(), reviewMode: 'auto', reviewReason: reason }); };
  for (const r of todo) {
    const e = findEvent(r, events);
    if (!e) { done(r, '이미 일정에서 빠져 있어요.'); log.push(`삭제 제보 ${r.id}: 이미 없음`); await saveReport(r); continue; }
    if (isOfficial(e)) { r.reviewReason = '공식 공지·공식 영상에 있는 일정이라 사람이 확인해요.'; continue; }
    if (!hasLlmKey() || !budget.canSpend()) { r.reviewReason = 'AI 판정을 기다려요.'; continue; }
    const res = await callModel({
      model: 'gpt-5-nano', effort: 'low',
      instructions: [
        `${GROUP.name} 팬 일정 사이트의 일정에 "지워 달라"는 제보가 왔다. 제보 이유가 맞는지 판정한다.`,
        `- 이 사이트의 일정: ${GROUP.name}(또는 멤버)가 직접 나오는 활동(방송·공연·행사·발매·촬영·공항 등)이나 팬이 참여하는 일(예매·응모·투표·사녹 등).`,
        '- 일정이 아닌 것: 차트·순위 발표, 시상 결과 기사, 다른 가수 일정, 기사 날짜를 일정으로 잘못 뽑은 것, 근거에 그룹·멤버 참여가 없는 것.',
        '- 제보 이유가 확실히 맞으면 agree=true, sure=true. 근거가 부족하거나 애매하면 sure=false.',
        '- reason은 한국어 한 문장 (예: "차트 순위 발표라 드림이 직접 하는 일정이 아님").',
      ].join('\n'),
      input: [
        `일정: ${e.date}${e.time ? ` ${e.time}` : ''} · ${e.kind} · ${e.title} · ${e.step}`,
        `근거: ${(e.evidence ?? '').slice(0, 400)}`,
        `출처: ${e.sources.slice(0, 5).map((s) => `${s.type} ${s.title}`).join(' / ')}`,
        `제보 이유: ${REASONS[r.reasonCode ?? ''] ?? r.reasonCode ?? ''} ${r.message}`,
      ].join('\n'),
      schema: { name: 'judge', schema: { type: 'object', additionalProperties: false, required: ['agree', 'sure', 'reason'], properties: { agree: { type: 'boolean' }, sure: { type: 'boolean' }, reason: { type: 'string' } } } },
    }).catch(() => null);
    if (!res) { r.reviewReason = 'AI 판정을 기다려요.'; continue; }
    budget.record(res.usage.costUsd);
    const v = JSON.parse(res.value) as { agree: boolean; sure: boolean; reason: string };
    if (v.agree && v.sure) {
      overrides.hide = overrides.hide.filter((h) => h.reportId !== r.id);
      overrides.hide.push({ id: e.id, date: e.date, title: `${e.title} ${e.step}`, reason: v.reason, reportId: r.id });
      done(r, `AI 판정으로 자동 삭제했어요: ${v.reason}`);
      log.push(`삭제 제보 ${r.id}: 자동 삭제 (${e.date} ${e.title}) ${v.reason}`);
      await saveReport(r);
    } else {
      r.reviewReason = `AI가 확실하지 않다고 봐서 사람이 확인해요: ${v.reason}`;
      log.push(`삭제 제보 ${r.id}: 사람 확인 (${v.reason})`);
    }
  }
  await repo.putState('report-overrides', overrides);
  await repo.putState('reports', reports);
  return log;
}
