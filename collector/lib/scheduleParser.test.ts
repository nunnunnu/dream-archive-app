import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScheduleFromBody, parseScheduleFromTitle, shortNoticeTitle } from './scheduleParser.ts';

const pick = (events: ReturnType<typeof parseScheduleFromBody>) =>
  events.map(({ date, time, endDate, endTime, label, kind }) => ({ date, time, endDate, endTime, label, kind }));

test('뮤뱅 사전녹화 공지 (40926): 신청·당첨 발표·본인 확인·녹화', () => {
  const body = `[사전 녹화 정보]
■ 녹화 시간 : 2026. 11. 13 (금) 11:40AM
■ 본인 확인 시간 :
당첨 번호 1 ~ 150번 : 2026. 11. 13 (금) 09:00AM
당첨 번호 151 ~ 300번 : 2026. 11. 13 (금) 10:00AM

■ 모임 장소 : KBS 신관 공개홀 앞 (NCT DREAM 번호판 앞)

[사전 신청 정보]
■ 모집 인원 : 선착순 300명
■ 신청 기간 : 2026. 11. 11 (수) 7:00 PM 부터 ~ 7:10 PM 까지 (KST)
■ 신청 대상 : 참여 신청일 기준 만 15세 이상 "NCTzen DREAM" 멤버십 (GL) 회원 (2011.11.11 이전 출생)

❗️ 스케줄 참여 신청하신 분은 11월 12일 (목) 11AM 이후, ‘NCT DREAM 이벤트 신청 내역’에서 당첨 여부 및 입장 번호를 확인해주시기 바랍니다.

7.1.0-dev.11`;
  const events = pick(parseScheduleFromBody(body, '2026-11-11T15:55:00+09:00'));
  assert.deepEqual(events, [
    { date: '2026-11-13', time: '11:40', endDate: undefined, endTime: undefined, label: '녹화 시간', kind: '녹화' },
    { date: '2026-11-13', time: '09:00', endDate: undefined, endTime: undefined, label: '본인 확인 시간 · 당첨 번호 1 ~ 150번', kind: '본인 확인' },
    { date: '2026-11-13', time: '10:00', endDate: undefined, endTime: undefined, label: '본인 확인 시간 · 당첨 번호 151 ~ 300번', kind: '본인 확인' },
    { date: '2026-11-11', time: '19:00', endDate: undefined, endTime: '19:10', label: '신청 기간', kind: '신청' },
    { date: '2026-11-12', time: '11:00', endDate: undefined, endTime: undefined, label: '당첨 여부 확인', kind: '당첨 발표' },
  ]);
});

test('투어 일정 공지: 영어 날짜 범위, 도시·공연장을 이름으로, 종류는 공지 제목으로', () => {
  const body = `[SEOUL]
📍GOCHEOK SKY DOME
📅 May 02-04, 2024

[NAGOYA]
📍VANTELIN DOME NAGOYA
📅 June 02, 2024

[LATAM]
📅 August~September, 2024`;
  const events = pick(parseScheduleFromBody(body, '2024-02-20T12:00:00+09:00', '[공지/변경] 2024 NCT DREAM WORLD TOUR <THE DREAM SHOW 3> - 투어 일정 안내'));
  assert.deepEqual(events, [
    { date: '2024-05-02', time: undefined, endDate: '2024-05-04', endTime: undefined, label: 'SEOUL · GOCHEOK SKY DOME', kind: '행사' },
    { date: '2024-06-02', time: undefined, endDate: undefined, endTime: undefined, label: 'NAGOYA · VANTELIN DOME NAGOYA', kind: '행사' },
  ]);
});

test('날짜 뒤가 문장이면 공지 제목을 이름으로 (Harvest Day 40436)', () => {
  const body = `NCT DREAM 정규 6집 앨범 [DREAM AFTER DREAM] 발매를 기념하여, 팬 여러분을 위한 특별한 시간을 준비했습니다.
11월 12일 (목) 오후 8시, 큐브컨벤션센터에서 진행됩니다.`;
  const [e] = parseScheduleFromBody(body, '2026-11-02T14:00:00+09:00', '[공지] NCT DREAM: The Harvest Day – DREAM AFTER DREAM 진행 안내');
  assert.equal(e.date, '2026-11-12');
  assert.equal(e.time, '20:00');
  assert.equal(e.label, 'The Harvest Day – DREAM AFTER DREAM');
});

test('해외 공연은 현지 시간대를 남기고, 초 단위 마감 시간도 읽는다', () => {
  const [manila] = parseScheduleFromBody('- 공연일시 : 2024년 8월 10일 (토) 7PM (PHT)', '2024-04-26T12:00:00+09:00');
  assert.equal(manila.time, '19:00');
  assert.equal(manila.timezone, 'PHT');
  assert.equal(manila.kind, '행사');

  const [deadline] = parseScheduleFromBody('└ 2월 10일 (월) 5:59:59PM (KST)까지 팬클럽 사전 인증을 완료하신 분', '2025-02-01T12:00:00+09:00');
  assert.equal(deadline.time, '17:59');
  assert.equal(deadline.timezone, undefined);
  assert.equal(deadline.kind, '신청');
  assert.equal(deadline.label, '신청 마감');
});

test('음방 사전투표 공지 (40807): 한글 날짜 + AM/PM, 시간 없는 날짜', () => {
  const body = `1) 뮤직뱅크 사전투표 APP [coogoong] - 사전투표 시작 | 11월 15일(일) 3PM (KST)
📱iOS 다운로드

3) 인기가요 사전투표 APP [LinC] - 사전투표 시작 | 11월 9일(월)
📱iOS 다운로드`;
  const events = pick(parseScheduleFromBody(body, '2026-11-09T20:00:00+09:00'));
  assert.deepEqual(events, [
    { date: '2026-11-15', time: '15:00', endDate: undefined, endTime: undefined, label: '뮤직뱅크 사전투표 APP [coogoong] - 사전투표 시작', kind: '투표' },
    { date: '2026-11-09', time: undefined, endDate: undefined, endTime: undefined, label: '인기가요 사전투표 APP [LinC] - 사전투표 시작', kind: '투표' },
  ]);
});

test('시즌그리팅 판매 공지 (39951): 날짜가 바뀌는 기간, 앞 줄을 이름으로', () => {
  const body = `[2027 NCT DREAM SEASON’S GREETINGS]

📌Sales Notice
📅2026. 10. 13 (TUE) 15:00 ~ 10. 19 (MON) 23:59 [KST]
🔗https://linktr.ee/SMTOWN_merch`;
  const events = pick(parseScheduleFromBody(body, '2026-10-12T12:00:00+09:00'));
  assert.deepEqual(events, [
    { date: '2026-10-13', time: '15:00', endDate: '2026-10-19', endTime: '23:59', label: 'Sales Notice', kind: '판매' },
  ]);
});

test('시간만 다음 줄에 있는 경우, 한글 오후 표기', () => {
  const body = `📅 11월 20일 (금)
⏰ 오후 6시 30분`;
  const events = pick(parseScheduleFromBody(body, '2026-11-12T10:00:00+09:00'));
  assert.equal(events.length, 1);
  assert.equal(events[0].date, '2026-11-20');
  assert.equal(events[0].time, '18:30');
});

test('연말 공지의 내년 날짜', () => {
  const [ok] = parseScheduleFromBody('■ 공연 일시 : 1월 3일 (일) 5PM', '2026-12-20T10:00:00+09:00');
  assert.equal(ok.date, '2027-01-03');
  assert.equal(ok.uncertain, undefined);
  // 요일이 틀려도 1년 가까이 지난 날짜를 고르지 않고, 불확실로 표시한다
  const [typo] = parseScheduleFromBody('■ 공연 일시 : 1월 3일 (토) 5PM', '2026-12-20T10:00:00+09:00');
  assert.equal(typo.date, '2027-01-03');
  assert.equal(typo.uncertain, true);
});

test('공지 제목의 YYMMDD 날짜', () => {
  const title = '[공지] 261113 (금) NCT DREAM KBS 뮤직뱅크 <Boogie Woogie> 사전녹화 참여 안내';
  assert.equal(shortNoticeTitle(title), 'KBS 뮤직뱅크 <Boogie Woogie> 사전녹화 참여 안내');
  const e = parseScheduleFromTitle(title, '2026-11-11T15:55:00+09:00');
  assert.equal(e?.date, '2026-11-13');
  assert.equal(e?.kind, '방송');
  assert.equal(e?.uncertain, undefined);
  assert.equal(parseScheduleFromTitle("[공지] NCT DREAM 'Boogie Woogie' 음악방송 사전투표 안내", '2026-11-09T20:00:00+09:00'), null);
});

test('공지 제목의 M/D (요일) 날짜', () => {
  const title = '[공지] NCT DREAM “7/19 (토) MBC 쇼! 음악중심 ‘BTTF’ 사전녹화” 참여 안내';
  assert.equal(shortNoticeTitle(title), 'MBC 쇼! 음악중심 ‘BTTF’ 사전녹화 참여 안내');
  const e = parseScheduleFromTitle(title, '2025-07-17T17:45:00+09:00');
  assert.equal(e?.date, '2025-07-19');
  assert.equal(e?.kind, '방송');
  assert.equal(e?.uncertain, undefined);
});

test('※ 참고 문장의 날짜는 일정으로 보지 않는다', () => {
  const body = ['■ 녹화 시간 : 2026. 11. 21 (토) 11:10AM', '※ <DREAM AFTER DREAM> 팬 카드는 11월 23일 (월)부터 KWANGYA SEOUL에서 수령 가능합니다.'].join('\n');
  const dates = parseScheduleFromBody(body, '2026-11-18T06:00:00Z').map((e) => e.date);
  assert.ok(dates.includes('2026-11-21'));
  assert.ok(!dates.includes('2026-11-23'));
});
