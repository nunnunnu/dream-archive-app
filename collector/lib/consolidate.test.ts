import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidate as consolidateWithBroadcasts, type ExtractedItem, type SourceRef } from './consolidate.ts';

const src = (type: SourceRef['type'], id: string): SourceRef => ({ type, id, url: `https://x/${id}`, title: id, publishedAt: '2026-11-12T00:00:00Z' });
const consolidate = (items: ExtractedItem[], opts: Parameters<typeof consolidateWithBroadcasts>[1]) =>
  consolidateWithBroadcasts(items, { broadcastEpisodes: [], ...opts });
const consolidateLoose = (items: ExtractedItem[], opts: Parameters<typeof consolidate>[1]) => consolidate(items, { ...opts, corroborate: false });
const item = (p: Partial<ExtractedItem> & { source: SourceRef }): ExtractedItem => ({
  date: '2026-11-12', time: null, end_date: null, end_time: null, timezone: null,
  target: '', step: '', kind: '방송', members: [], evidence: 'e', verified: true, problems: [], by: 'ai', ...p,
});

test('공식 회차가 등록된 방송은 추정 회차 대신 등록된 날짜만 쓴다', () => {
  const { events } = consolidateLoose(
    [item({ target: '테스트 예능', step: '첫 방송', source: src('news', 'a') })],
    {
      today: '2026-11-12',
      broadcastEpisodes: [{
        title: '테스트 예능', members: ['지성'], publisher: '방송사',
        source: 'https://example.com/episodes', dates: ['2026-11-13', '2026-11-20'],
      }],
    },
  );
  assert.deepEqual(events.map(({ date, step }) => [date, step]), [
    ['2026-11-13', '1회 (첫 방송)'], ['2026-11-20', '2회 (마지막 회)'],
  ]);
});

test('기사 두 곳의 같은 출연은 하나로, 시간은 있는 쪽으로 채운다', () => {
  const { events } = consolidateLoose(
    [
      item({ target: 'SBS 꼬리에 꼬리를 무는 그날 이야기', step: '제노 출연', members: ['제노'], time: '22:20', source: src('news', 'a') }),
      item({ target: '꼬리에 꼬리를 무는 그날 이야기', step: '출연', members: ['제노'], source: src('news', 'b') }),
    ],
    { today: '2026-11-12' },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].time, '22:20');
  assert.equal(events[0].sources.length, 2);
});

test('같은 공지 안의 다른 시간 일정은 합치지 않는다', () => {
  const { events } = consolidateLoose(
    [
      item({ target: 'KBS 뮤직뱅크 사전녹화', step: '본인 확인 1~150번', kind: '본인 확인', time: '09:00', source: src('weverse-notice', '40926') }),
      item({ target: 'KBS 뮤직뱅크 사전녹화', step: '본인 확인 151~300번', kind: '본인 확인', time: '10:00', source: src('weverse-notice', '40926') }),
    ],
    { today: '2026-11-12' },
  );
  assert.equal(events.length, 2);
});

test('공지와 기사가 같은 일정이면 공지 이름을 쓴다', () => {
  const { events } = consolidateLoose(
    [
      item({ target: 'NCT DREAM: The Harvest Day', step: '공연', kind: '행사', time: '20:00', source: src('news', 'n') }),
      item({ target: 'The Harvest Day – DREAM AFTER DREAM', step: '행사', kind: '행사', time: '20:00', source: src('weverse-notice', '40436') }),
    ],
    { today: '2026-11-12' },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'The Harvest Day – DREAM AFTER DREAM');
  assert.equal(events[0].sources[0].type, 'weverse-notice');
});

test('반복 방송은 회차별로 펼친다 (월화, 4부작)', () => {
  const { events } = consolidateLoose(
    [
      item({
        date: '2026-11-16', time: '22:00', target: 'ENA 크래시2', step: '첫 방송', members: ['지성'], source: src('news', 'c'),
        recurrence: { weekdays: ['월', '화'], episodes: 4, end_date: null },
      }),
    ],
    { today: '2026-11-12' },
  );
  assert.deepEqual(events.map((e) => [e.date, e.time, e.step]), [
    ['2026-11-16', '22:00', '1회 (첫 방송)'],
    ['2026-11-17', '22:00', '2회'],
    ['2026-11-23', '22:00', '3회'],
    ['2026-11-24', '22:00', '4회 (마지막 회)'],
  ]);
});

test('날짜 미정 소식은 따로, 같은 대상의 날짜 있는 일정이 생기면 빠진다', () => {
  const undated = item({ date: null, when_text: '2027년', target: '코첼라 2027', step: '출연 확정', kind: '행사', source: src('news', 'k') });
  assert.equal(consolidateLoose([undated], { today: '2026-11-12' }).pending.length, 1);
  const withDate = item({ date: '2027-04-10', target: '코첼라 2027', step: '공연', kind: '행사', source: src('news', 'k2') });
  assert.equal(consolidateLoose([undated, withDate], { today: '2026-11-12' }).pending.length, 0);
});

test('같은 날 영상 공개 시각으로 빈 시간을 채운다', () => {
  const { events } = consolidateLoose([item({ target: "유튜브 '전과자' (ootb STUDIO 공식 유튜브 채널)", step: '재민 출연 회 공개', members: ['재민'], source: src('news', 'j') })], {
    today: '2026-11-12',
    videos: [{ title: '[전과자] 방사선학과 편 | 카이·재민', url: 'https://youtu.be/x', channel: 'ootb STUDIO', publishedAt: '2026-11-12T09:00:00Z' }],
  });
  assert.equal(events[0].time, '18:00');
  assert.equal(events[0].sources.at(-1)?.type, 'youtube');
});

test('보기·참여 구분, 사녹 묶음에서 당첨자만 가는 단계', () => {
  const n = src('weverse-notice', '40926');
  const { events } = consolidateLoose(
    [
      item({ target: '뮤뱅 사녹', step: '참여 신청', kind: '신청', date: '2026-11-11', time: '19:00', source: n }),
      item({ target: '뮤뱅 사녹', step: '당첨 확인', kind: '당첨 발표', date: '2026-11-12', time: '11:00', source: n }),
      item({ target: '뮤뱅 사녹', step: '본인 확인', kind: '본인 확인', date: '2026-11-13', time: '09:00', source: n }),
      item({ target: '뮤뱅 사녹', step: '녹화', kind: '녹화', date: '2026-11-13', time: '11:40', source: n }),
      item({ target: 'SBS 꼬꼬무', step: '제노 출연', kind: '방송', date: '2026-11-12', time: '22:20', members: ['제노'], source: src('news', 'k') }),
    ],
    { today: '2026-11-12' },
  );
  const by = (step: string) => events.find((e) => e.step === step)!;
  assert.equal(by('제노 출연').category, '공식');
  assert.equal(by('참여 신청').category, '참여');
  assert.deepEqual(['참여 신청', '당첨 확인', '본인 확인', '녹화'].map((s) => by(s).audience), ['all', 'all', 'winners', 'winners']);
  assert.equal(by('녹화').flowId, 'notice-40926');
  assert.equal(by('제노 출연').flowId, undefined);
});

test('연도·영문 이름이 달라도 같은 행사, 방송/행사 분류가 달라도 합친다', () => {
  const { events } = consolidateLoose(
    [
      item({ date: '2027-04-10', target: '2027 코첼라', step: 'NCT 드림 출연', kind: '행사', source: src('news', 'a') }),
      item({ date: '2027-04-10', target: 'Coachella Valley Music and Arts Festival (코첼라)', step: '공연', kind: '행사', source: src('news', 'b') }),
      item({ date: '2026-11-14', time: '17:00', target: '멜론·웨이브 2026 멜론뮤직어워드(MMA2026)', step: '레드카펫 생중계', kind: '방송', source: src('news', 'c') }),
      item({ date: '2026-11-14', time: '17:00', target: 'MMA2026', step: '레드카펫 시작', kind: '행사', source: src('news', 'd') }),
    ],
    { today: '2026-11-12' },
  );
  assert.equal(events.length, 2);
});

test('날짜 미정 잡음 거르기: 지난 해, 시기 정보 없음', async () => {
  const { usefulWhen } = await import('./consolidate.ts');
  assert.equal(usefulWhen('2027년 4월', '2026-11-12'), true);
  assert.equal(usefulWhen('내년 상반기', '2026-11-12'), true);
  assert.equal(usefulWhen('2024-08~09', '2026-11-12'), false);
  assert.equal(usefulWhen('앨범 발매를 기념해', '2026-11-12'), false);
});

test('시기 표현에 날짜가 있으면 날짜 일정으로, Coachella = 코첼라로 합친다', async () => {
  const { datesFromWhen } = await import('./consolidate.ts');
  assert.deepEqual(datesFromWhen('2027년 4월 10일과 17일', '2026-11-12'), ['2027-04-10', '2027-04-17']);
  assert.deepEqual(datesFromWhen('2027년 4월', '2026-11-12'), []);
  const { events, pending } = consolidateLoose(
    [
      item({ date: '2027-04-10', target: '2027 코첼라', step: 'NCT 드림 출연', kind: '행사', source: src('news', 'a') }),
      item({ date: '2027-04-17', target: '2027 코첼라', step: 'NCT 드림 출연', kind: '행사', source: src('news', 'a') }),
      item({ date: null, when_text: '2027년 4월 10일과 17일', target: 'Coachella 2027 - NCT 컬래버레이션 무대', step: '컬래버레이션 무대 예고', kind: '행사', source: src('news', 'n') }),
    ],
    { today: '2026-11-12' },
  );
  assert.equal(pending.length, 0);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.sources.length === 2));
});

test('예고 일정은 영상이 올라오면 링크·실제 공개 시각으로 채워진다', () => {
  const teaser = item({ date: '2026-11-13', time: '18:30', target: '셀폰KODE', step: '게스트 예고 (미공개) (추측: 지성)', kind: '방송', source: src('submission', 'x') });
  const before = consolidateLoose([teaser], { today: '2026-11-12' });
  assert.equal(before.events.length, 0);
  assert.equal(before.rumors.length, 1);
  const video = item({ date: '2026-11-13', time: '18:31', target: '유튜브 KODE코드', step: '셀폰KODE EP.20 지성 공개', kind: '발매', members: ['지성'], source: src('youtube', 'v') });
  const after = consolidateLoose([teaser, video], { today: '2026-11-12' }).events;
  assert.equal(after.length, 1);
  assert.equal(after[0].time, '18:31');
  assert.ok(after[0].sources.some((s) => s.type === 'youtube'));
});

test('결방이면 그날 회차를 빼고 번호를 민다', () => {
  const { events } = consolidateLoose(
    [
      item({ date: '2026-11-16', time: '22:00', target: 'ENA 크래시2', step: '첫 방송', members: ['지성'], source: src('news', 'c'), recurrence: { weekdays: ['월', '화'], episodes: 4, end_date: null } }),
      item({ date: '2026-11-17', target: 'ENA 크래시2', step: '결방', members: ['지성'], source: src('news', 'x'), evidence: '17일은 결방한다' }),
    ],
    { today: '2026-11-12' },
  );
  const eps = events.filter((e) => e.seriesId).map((e) => [e.date, e.step]);
  assert.deepEqual(eps, [
    ['2026-11-16', '1회 (첫 방송)'],
    ['2026-11-23', '2회'],
    ['2026-11-24', '3회'],
    ['2026-11-30', '4회 (마지막 회)'],
  ]);
  assert.ok(events.some((e) => e.date === '2026-11-17' && e.step === '결방'));
});

test('기사의 예고 날짜와 실제 영상 공개가 하루 어긋나면 실제 공개로 합친다 (전과자)', () => {
  const { events } = consolidateLoose(
    [
      item({ date: '2026-11-12', target: "유튜브 '전과자' (ootb STUDIO 공식 유튜브 채널)", step: '재민 출연 공개', members: ['재민'], source: src('news', 'n') }),
      item({ date: '2026-11-11', time: '21:25', target: '유튜브 ootb STUDIO 전과자', step: '가천대 방사선학과 편 재민 출연분 공개', kind: '발매', members: ['재민'], source: src('youtube', 'v') }),
    ],
    { today: '2026-11-12' },
  );
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].date, events[0].time], ['2026-11-11', '21:25']);
  assert.equal(events[0].sources.length, 2);
});

test('추측·예고는 일정이 아니라 따로, 영상으로 확인되면 일정으로', () => {
  const teaser = item({ date: '2026-11-13', time: '18:30', target: '셀폰KODE', step: '게스트 예고 (미공개) (추측: 지성)', kind: '방송', source: src('submission', 'x') });
  const before = consolidateLoose([teaser], { today: '2026-11-12' });
  assert.equal(before.events.length, 0);
  assert.deepEqual(before.rumors.map((r) => [r.step, r.guessMembers]), [['게스트 예고 (미공개)', ['지성']]]);
  const video = item({ date: '2026-11-13', time: '18:31', target: '유튜브 KODE코드 셀폰KODE', step: '지성 출연분 공개', kind: '발매', members: ['지성'], source: src('youtube', 'v') });
  const after = consolidateLoose([teaser, video], { today: '2026-11-12' });
  assert.equal(after.rumors.length, 0);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].step, '지성 출연분 공개');
});

test('투표 시작과 마감이 따로 오면 기간 하나로 합친다', () => {
  const { events } = consolidateLoose(
    [
      item({ date: '2026-10-30', time: '12:00', target: 'MMA2026 팬 투표', step: '팬 투표 시작', kind: '투표', source: src('news', 'a') }),
      item({ date: '2026-11-13', target: 'MMA2026 부문별 팬 투표', step: '팬 투표 마감', kind: '투표', source: src('news', 'b') }),
      item({ date: '2026-11-15', time: '15:00', target: '뮤직뱅크 사전투표', step: '사전투표 시작', kind: '투표', source: src('weverse-notice', 'n') }),
    ],
    { today: '2026-11-12' },
  );
  const mma = events.find((e) => e.title.includes('MMA'))!;
  assert.deepEqual([mma.date, mma.time, mma.endDate, mma.step], ['2026-10-30', '12:00', '2026-11-13', '팬 투표']);
  assert.equal(mma.sources.length, 2);
  assert.equal(events.filter((e) => e.title.includes('MMA')).length, 1);
  // 짝이 없는 시작은 그대로
  assert.equal(events.find((e) => e.title.includes('뮤직뱅크'))!.endDate, null);
});

test('채널만 같은 다른 영상에는 예고 일정을 합치지 않는다 (전과자 vs CT 촬영)', () => {
  const { events } = consolidateLoose(
    [
      item({ date: '2026-11-12', target: "유튜브 '전과자' (ootb STUDIO 공식 유튜브 채널)", step: '재민 출연 공개', kind: '발매', members: ['재민'], source: src('news', 'n') }),
      { ...item({ date: '2026-11-11', time: '21:25', target: '유튜브 ootb STUDIO', step: '재민 CT 촬영 영상 공개', kind: '발매', members: ['재민'], source: src('youtube', 'v') }), source: { ...src('youtube', 'v'), title: 'NCT랑 CT 촬영하러 감 (feat. NCT DREAM 재민)' } },
    ],
    { today: '2026-11-12' },
  );
  assert.equal(events.length, 2);
});

test('신뢰 단계: 기사는 한 곳이어도 일정, 작은 채널 영상 하나뿐이면 확인 대기, 공지는 바로 일정', () => {
  const news = (id: string, publisher: string, extra: Partial<ExtractedItem> = {}) =>
    item({ date: '2026-11-20', time: '20:00', target: 'tvN 놀라운 토요일', step: '해찬 출연', kind: '방송', members: ['해찬'], source: { ...src('news', id), publisher }, ...extra });
  // 기사는 한 곳뿐이어도 캘린더에
  const one = consolidate([news('a', '스포츠월드')], { today: '2026-11-13' });
  assert.equal(one.events.length, 1);
  assert.equal(one.review.length, 0);
  // 작은 채널 영상 하나뿐이면 확인 대기
  const vid = consolidate([item({ date: '2026-11-20', time: '18:00', target: '유튜브 어떤채널', step: '해찬 출연분 공개', kind: '발매', members: ['해찬'], source: { ...src('youtube', 'v'), publisher: '어떤채널' } })], { today: '2026-11-13' });
  assert.equal(vid.events.length, 0);
  assert.equal(vid.review.length, 1);
  const two = consolidate([news('a', '스포츠월드'), news('b', '텐아시아')], { today: '2026-11-13' });
  assert.equal(two.events.length, 1);
  assert.equal(two.review.length, 0);
  const notice = consolidate([item({ date: '2026-11-21', target: '팬미팅', step: '예매', kind: '판매', source: src('weverse-notice', 'n') })], { today: '2026-11-13' });
  assert.equal(notice.events.length, 1);
  // 그룹이 안 나오는 관련 기사(채우기 전용)만으로는 일정이 생기지 않는다
  const fill = consolidate([{ ...news('c', '매일경제'), fillOnly: true }], { today: '2026-11-13' });
  assert.equal(fill.events.length + fill.review.length, 0);
});

test('기사에 시간이 없는 영상 공개는 그날 공식 채널 영상의 공개 시각으로 채운다 (트레일러 자정 공개)', () => {
  const { events } = consolidateLoose(
    [item({ date: '2026-11-03', target: "유튜브 NCT DREAM 정규 6집 'DREAM AFTER DREAM' 첫 번째 트레일러", step: '첫 번째 트레일러 영상 공개', kind: '발매', source: src('news', 'n') })],
    { today: '2026-11-13', videos: [{ title: 'NCT DREAM 엔시티 드림 EP.1 WE’RE DREAM AFTER SERVICE!', url: 'https://youtu.be/t', channel: 'NCT DREAM', publishedAt: '2026-11-02T15:00:00Z' }] },
  );
  assert.equal(events[0].time, '00:00');
  assert.ok(events[0].sources.some((s) => s.url === 'https://youtu.be/t'));
});

test('"매주 화요일 저녁 8시" 정기 공개는 다음 화요일 날짜·시간으로', async () => {
  const { weeklyFromWhen } = await import('./consolidate.ts');
  assert.deepEqual(weeklyFromWhen('매주 화요일 저녁 8시 Mnet Plus 공개', '2026-11-13T02:13:00Z'), { date: '2026-11-17', time: '20:00', recurrence: { weekdays: ['화'], episodes: null, end_date: null } });
});
