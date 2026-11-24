/**
 * 소식 제보 판정: X·음반 판매처 공지처럼 자동으로 못 모으는 소식을 사이트에서 받는다.
 *  - 링크가 있으면 일정 제보처럼 원문을 읽어(queueReports → 제보 글) 날짜가 있는 일정은 일정에 들어간다
 *  - 소식 탭에는 AI(무료 Groq 작은 모델 → 막히면 nano)가 "드림·멤버 소식이 맞다"고 확실히 볼 때만 올린다.
 *    확실히 관련 없으면 거절, 애매하면 사람 확인으로 남긴다
 */
import type { Budget } from './budget.ts';
import { GROUP, GROUP_NAME_RE } from './group.ts';
import { callModel, hasLlmKey } from './llm.ts';
import { mentionedMembers } from './members.ts';
import type { FeedItem } from './publish.ts';
import type { Repo } from './repo.ts';
import { SERIES_HINT_KINDS, type Report } from './reports.ts';
import { submissionId } from './submissions.ts';
import { topicOf } from './topics.ts';

/** 제보 제목·덧붙인 말에 그룹·멤버·유닛 이름이 있는지 (있으면 AI 혼자 거절하지 않는다) */
export function namesGroup(r: Pick<Report, 'title' | 'message'>): boolean {
  const text = `${r.title ?? ''} ${r.message ?? ''}`;
  const m = mentionedMembers(text);
  return GROUP_NAME_RE.test(text) || m.members.length > 0 || !!m.unit;
}

/** 받침에 맞는 조사 (해찬은/런쥔이/재민이 → 받침 있으면 앞, 없으면 뒤) */
const josa = (w: string, withB: string, without: string) => {
  const c = w.charCodeAt(w.length - 1);
  return w + (c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? withB : without);
};
/** 제보 심사 프롬프트: 멤버·유닛·별칭·탈퇴 멤버는 config/group.json에서 채운다 */
export function judgePrompt(today: string): string {
  const G = GROUP.name;
  const names = GROUP.members.map((m) => `${m.name}(${m.aliases.filter((a) => a !== m.name && /^[A-Za-z]+$/.test(a)).join('·') || m.name})`).join(', ');
  const aliases = [...GROUP.nameVariants, ...GROUP.nicknames.filter((n) => n.length > 2), ...GROUP.fandom.map((f) => `${f}(팬덤)`),
    ...GROUP.members.flatMap((m) => [...m.aliases, ...(m.nicknames ?? [])].filter((a) => a !== m.name && !/^[A-Za-z]+$/.test(a)))];
  const units = GROUP.units.map((u) => `${u.name}(${u.members.join('·')})`).join(', ');
  const former = GROUP.formerMembers.filter((f) => f.hide).map((f) => f.name);
  const ex = GROUP.members[0]?.name ?? '';
  const dual = GROUP.members.filter((m) => m.otherGroups?.length);
  return [
    `너는 ${G} 팬 아카이브 사이트의 제보 심사관이다.`,
    `제보(제목, 링크, 덧붙인 말)를 보고 ${G} 관련 소식인지 판정한다. 오늘은 ${today}이다.`,
    '',
    `${G} 멤버(이 ${GROUP.members.length}명만): ${names}`,
    ...(units ? [`${G} 유닛: ${units}. 유닛 활동도 ${G} 소식이다.`] : []),
    `별칭도 같은 뜻: ${aliases.join(', ')}`,
    '',
    '[가장 중요한 규칙]',
    `- 위 명단이 정답이다. 이름이 명단에 있으면 ${G} 멤버로 본다. 네가 아는 아이돌 정보로 "다른 그룹 멤버"라고 판단하지 않는다.`,
    `- 멤버 이름이 나오면 다른 그룹 이름이 같이 있어도 아래 기준대로 판단한다.`,
    ...dual.map((m) => `- ${josa(m.name, '은', '는')} ${m.otherGroups!.join('·')} 멤버이기도 하다. ${m.otherGroups!.join('·')} 단체 활동(컴백·콘서트·단체 출연)은 ${josa(m.name, '이', '가')} 나와도 false. ${m.name} 개인 활동(개인 출연·화보·광고·솔로·SNS)은 true.`),
    `- 네가 모르는 행사·시상식·프로그램·연도도 실제로 있는 것이다. "가상", "존재하지 않음", "미래"라는 이유로 false라고 하지 않는다.`,
    '- reason은 제보와 위 명단에 있는 말로만 쓴다. 지식으로 사실을 지어내지 않는다.',
    '',
    'relevant = true (관련 있음):',
    '- 그룹이나 멤버 1명 이상이 나오는 모든 활동: 방송·예능·유튜브·라디오 출연, 드라마·영화, 음원·앨범 발매, 콘서트·팬미팅·팬사인회·행사, 광고·브랜드 모델·앰배서더, 화보·매거진, 공항, 음악방송 무대·직캠·1위, 차트 성적, 공식 MD 판매 공지',
    '- 다른 프로그램·채널에 멤버가 출연한 것 (웹예능 클립, 다른 가수 유튜브 등)',
    '- 멤버 본인이나 공식 계정의 SNS 게시물(X, 인스타그램, 웨이보, 도우인, 버블, 위버스)',
    `- 다른 가수의 챌린지·콘텐츠라도 멤버가 함께 나오면 true (예: "TWS 챌린지 with ${ex}")`,
    `- NCT 전체·NCT U·SMTOWN 활동이라도 위 멤버가 참여하면 true${dual.length ? ` (단 ${[...new Set(dual.flatMap((m) => m.otherGroups!))].join('·')} 단체 활동은 위 규칙대로 false)` : ''}`,
    '- 중국어·일본어·영어 소식도 내용이 맞으면 true',
    '',
    'relevant = false (관련 없음):',
    '- 위 멤버가 안 나오는 다른 가수 소식 (NCT 127, WayV, NCT WISH 단독 소식 포함)',
    ...(former.length ? [`- 탈퇴한 멤버(${former.join(', ')})만 나오는 소식`] : []),
    '- 멤버 이름과 상관없는 동명이인 (예: 축구 선수 박지성, 일반 단어 "드림")',
    '- 개인 간 굿즈·티켓 양도·판매·교환, 홍보·스팸·도박·성인 링크',
    '- 내용 없는 글, 테스트, 의미 없는 문자',
    '',
    'sure:',
    '- true: 제목이나 내용에 멤버·그룹 이름이 분명히 있고 위 기준에 확실히 맞음',
    '- false: 멤버 언급이 불분명함, 링크만 있고 내용을 알 수 없음, 동명이인일 수 있음',
    '- 애매하면 relevant를 추측하지 말고 sure=false로 둔다',
    '',
    '출력: {"relevant": true/false, "sure": true/false, "reason": "한국어 한 문장"}',
    '',
    '예시:',
    `제보: "TWS '내 이름을 불러줘' 챌린지 with ${ex}"`,
    `{"relevant": true, "sure": true, "reason": "${josa(ex, '이', '가')} 다른 가수 챌린지에 출연한 소식이다."}`,
    ...(GROUP.units[0] ? [`제보: "${GROUP.units[0].name}, 브랜드 행사 참석"`, `{"relevant": true, "sure": true, "reason": "${GROUP.units[0].members.join('·')} 유닛의 행사 소식이다."}`] : []),
    '제보: "MMA2026 무대 영상"',
    `{"relevant": false, "sure": false, "reason": "어느 가수의 무대인지 제목에 없어 알 수 없다."}`,
    ...dual.slice(0, 1).flatMap((m) => [
      `제보: "${m.otherGroups![0]} 정규 7집 컴백 확정, ${m.name} 참여"`,
      `{"relevant": false, "sure": true, "reason": "${m.otherGroups![0]} 단체 활동이라 ${josa(m.name, '이', '가')} 나와도 드림 소식이 아니다."}`,
      `제보: "${m.name}, 패션 매거진 단독 화보 공개"`,
      `{"relevant": true, "sure": true, "reason": "${m.name} 개인 화보 소식이다."}`,
    ]),
    '제보: "드림 콘서트 티켓 양도합니다"',
    '{"relevant": false, "sure": true, "reason": "개인 간 티켓 양도 글이라 소식이 아니다."}',
    '제보: 링크만 있고 제목이 "ㅇㅇ"',
    '{"relevant": false, "sure": false, "reason": "내용이 없어 관련 여부를 알 수 없다."}',
  ].join('\n');
}

export async function judgeNewsReports(repo: Repo, reports: Record<string, Report>, budget: Budget, now: Date): Promise<string[]> {
  const log: string[] = [];
  // 예전 판정이 멤버·유닛 이름이 있는데도 AI 혼자 거절한 것("재민은 다른 그룹 멤버" 같은 지어낸 이유)은 다시 판정한다
  for (const r of Object.values(reports)) {
    if (r.type === 'news' && r.status === 'rejected' && r.reviewMode === 'auto' && namesGroup(r)) {
      Object.assign(r, { status: 'pending', reviewMode: undefined, reviewedAt: undefined, reviewReason: undefined });
      log.push(`소식 제보 ${r.id}: 멤버·유닛 이름이 있는데 AI가 거절한 것이라 다시 판정`);
    }
  }
  const todo = Object.values(reports).filter((r) => r.type === 'news' && r.status === 'pending' && r.reviewMode !== 'manual');
  for (const r of todo) {
    if (!hasLlmKey() || !budget.canSpend()) { r.reviewReason = 'AI 판정을 기다려요.'; continue; }
    const ext = r.url ? await repo.getExtraction('submission', submissionId(r.url)) : null;
    const res = await callModel({
      model: 'gpt-5-nano', effort: 'low',
      instructions: judgePrompt(now.toISOString().slice(0, 10)),
      input: [`제보 제목: ${r.title ?? ''}`, `덧붙인 말: ${r.message}`, `링크: ${r.url || '없음'}`, ext ? `링크 원문 제목: ${ext.source.title}` : ''].filter(Boolean).join('\n'),
      schema: { name: 'judge', schema: { type: 'object', additionalProperties: false, required: ['relevant', 'sure', 'reason'], properties: { relevant: { type: 'boolean' }, sure: { type: 'boolean' }, reason: { type: 'string' } } } },
    }).catch(() => null);
    if (!res) { r.reviewReason = 'AI 판정을 기다려요.'; continue; }
    budget.record(res.usage.costUsd);
    const v = JSON.parse(res.value) as { relevant: boolean; sure: boolean; reason: string };
    // 멤버·유닛 이름이 있는 제보는 AI가 "아님"이라고 해도 혼자 거절하지 않고 사람이 확인한다
    if (!v.relevant && namesGroup(r)) {
      r.reviewReason = `멤버·유닛 이름이 있어 사람이 확인해요 (AI 의견: ${v.reason})`;
      log.push(`소식 제보 ${r.id}: 사람 확인 (이름 있음, AI 의견: ${v.reason})`);
      continue;
    }
    if (v.sure) {
      Object.assign(r, { status: v.relevant ? 'approved' : 'rejected', reviewedAt: now.toISOString(), reviewMode: 'auto', reviewReason: `AI 판정: ${v.reason}` });
      log.push(`소식 제보 ${r.id}: ${v.relevant ? '소식 탭에 올림' : '거절'} (${v.reason})`);
    } else {
      r.reviewReason = `AI가 확실하지 않다고 봐서 사람이 확인해요: ${v.reason}`;
      log.push(`소식 제보 ${r.id}: 사람 확인 (${v.reason})`);
    }
  }
  if (todo.length || log.length) await repo.putState('reports', reports);
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
        ...(r.series && SERIES_HINT_KINDS.includes(r.series.kind) && r.series.name ? { series: { kind: r.series.kind, name: r.series.name.trim() } } : {}),
      };
    });
}
