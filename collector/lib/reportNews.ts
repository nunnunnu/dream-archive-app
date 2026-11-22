/**
 * 소식 제보 판정: X·음반 판매처 공지처럼 자동으로 못 모으는 소식을 사이트에서 받는다.
 *  - 링크가 있으면 일정 제보처럼 원문을 읽어(queueReports → 제보 글) 날짜가 있는 일정은 일정에 들어간다
 *  - 소식 탭에는 AI(무료 Groq 작은 모델 → 막히면 nano)가 "드림·멤버 소식이 맞다"고 확실히 볼 때만 올린다.
 *    확실히 관련 없으면 거절, 애매하면 사람 확인으로 남긴다
 */
import type { Budget } from './budget.ts';
import { GROUP } from './group.ts';
import { callModel, hasLlmKey } from './llm.ts';
import type { FeedItem } from './publish.ts';
import type { Repo } from './repo.ts';
import { saveReport, type Report } from './reports.ts';
import { submissionId } from './submissions.ts';
import { topicOf } from './topics.ts';

export async function judgeNewsReports(repo: Repo, reports: Record<string, Report>, budget: Budget, now: Date): Promise<string[]> {
  const todo = Object.values(reports).filter((r) => r.type === 'news' && r.status === 'pending' && r.reviewMode !== 'manual');
  const log: string[] = [];
  for (const r of todo) {
    if (!hasLlmKey() || !budget.canSpend()) { r.reviewReason = 'AI 판정을 기다려요.'; continue; }
    const ext = r.url ? await repo.getExtraction('submission', submissionId(r.url)) : null;
    const res = await callModel({
      model: 'gpt-5-nano', effort: 'low',
      instructions: [
        `${GROUP.name} 팬 사이트에 "소식" 제보가 왔다. ${GROUP.name}(멤버: ${GROUP.members.map((m) => m.name).join(', ')}) 관련 소식이 맞는지 판정한다.`,
        '- 맞음: 그룹·멤버의 활동·출연·발매·행사·팬사인회·광고·화보·공항·SNS 소식 등.',
        '- 아님: 다른 가수 소식, 광고·스팸 링크, 내용 없는 글.',
        '- relevant: 관련 소식이면 true. sure: 확실하면 true, 애매하면 false. reason: 한국어 한 문장.',
      ].join('\n'),
      input: [`제보 제목: ${r.title ?? ''}`, `덧붙인 말: ${r.message}`, `링크: ${r.url || '없음'}`, ext ? `링크 원문 제목: ${ext.source.title}` : ''].filter(Boolean).join('\n'),
      schema: { name: 'judge', schema: { type: 'object', additionalProperties: false, required: ['relevant', 'sure', 'reason'], properties: { relevant: { type: 'boolean' }, sure: { type: 'boolean' }, reason: { type: 'string' } } } },
    }).catch(() => null);
    if (!res) { r.reviewReason = 'AI 판정을 기다려요.'; continue; }
    budget.record(res.usage.costUsd);
    const v = JSON.parse(res.value) as { relevant: boolean; sure: boolean; reason: string };
    if (v.sure) {
      Object.assign(r, { status: v.relevant ? 'approved' : 'rejected', reviewedAt: now.toISOString(), reviewMode: 'auto', reviewReason: `AI 판정: ${v.reason}` });
      await saveReport(r);
      log.push(`소식 제보 ${r.id}: ${v.relevant ? '소식 탭에 올림' : '거절'} (${v.reason})`);
    } else {
      r.reviewReason = `AI가 확실하지 않다고 봐서 사람이 확인해요: ${v.reason}`;
      log.push(`소식 제보 ${r.id}: 사람 확인 (${v.reason})`);
    }
  }
  if (todo.length) await repo.putState('reports', reports);
  return log;
}

/** 승인된 소식 제보 → 소식 탭 항목 (링크가 있는 것만) */
export function reportedFeed(reports: Record<string, Report>): FeedItem[] {
  return Object.values(reports)
    .filter((r) => r.type === 'news' && r.status === 'approved' && r.url)
    .map((r) => {
      let host = '';
      try { host = new URL(r.url).hostname.replace(/^(www|m|mobile)\./, ''); } catch { /* 잘못된 주소 */ }
      const topic = topicOf(r.title ?? '');
      return {
        type: 'sns' as const, title: r.title || r.message.slice(0, 80), url: r.url,
        publishedAt: r.date ? `${r.date}T03:00:00.000Z` : r.createdAt, publisher: `팬 제보 · ${host}`, members: r.members,
        reported: true, ...(topic ? { topic } : {}),
      };
    });
}
