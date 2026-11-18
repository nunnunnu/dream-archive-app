import assert from 'node:assert/strict';
import { test } from 'node:test';
import { whoOfArticles, whoOfNotice } from './members.ts';

test('공지 제목으로 멤버·유닛·단체 판단', () => {
  assert.deepEqual(whoOfNotice('[공지] CHENLE “Lele’s Show 2” 예매 & 입장 주의사항'), { scope: '멤버', members: ['천러'], label: '천러' });
  assert.deepEqual(whoOfNotice('[공지] HAECHAN “9/14 (일) SBS 인기가요 ‘CRZY’ 사전녹화” 참여 안내'), { scope: '멤버', members: ['해찬'], label: '해찬' });
  assert.deepEqual(whoOfNotice('[공지] NCT JNJM “3/7 (토) MBC 쇼! 음악중심 ‘BOTH SIDES’ 사전녹화” 참여 안내'), {
    scope: '유닛', members: ['제노', '재민'], label: '제노·재민 (NCT JNJM)',
  });
  assert.deepEqual(whoOfNotice('[공지] 261113 (금) NCT DREAM KBS 뮤직뱅크 <Boogie Woogie> 사전녹화 참여 안내'), { scope: '단체', members: [], label: '단체' });
});

test('영어 이름은 단어 단위로만 (JENOSIDE 같은 단어는 제노가 아님)', () => {
  assert.equal(whoOfNotice('[알림] NCT DREAM JENOSIDE MARKET 안내').scope, '단체');
});

test('기사 여러 개: 절반 이상에 나온 멤버만', () => {
  const titles = [
    '[영상] NCT 지성, 첫 드라마에 복근 공개까지 "드림 형들이 엄청 놀려"(크래시 2) - MBC',
    '`25세` NCT 지성, 복근 공개 약속 지킨다…`크래시2` 첫 상탈',
    '박지성 "복근 공개, 부끄럽지만 소중한 장면…멤버들 정말 많이 놀려"',
    '마크 빠진 NCT DREAM, 6인조로 맞은 데뷔 10주년',
  ];
  assert.deepEqual(whoOfArticles(titles), { scope: '멤버', members: ['지성'], label: '지성' });
  assert.equal(whoOfArticles(['NCT 127·NCT 드림, 2027 코첼라 동반 출격', 'NCT, 2027 코첼라 무대 오른다']).scope, '단체');
});

test('마크 관련 글 숨김 (랜드마크·북마크·MARKET은 제외)', async () => {
  const { isHidden } = await import('./members.ts');
  assert.equal(isHidden("[공지] MARK '1999’ 응원법 안내!"), true);
  assert.equal(isHidden('[공지] 마크 전속계약 종료 관련 말씀드립니다.'), true);
  assert.equal(isHidden('마크 빠진 NCT DREAM, 6인조로 맞은 데뷔 10주년'), true);
  assert.equal(isHidden('[공지] <MARK LEE : EARLY BIRTHDAY LIVE> 진행 안내'), true);
  assert.equal(isHidden('서울 랜드마크에서 팝업 오픈'), false);
  assert.equal(isHidden('NCT DREAM POP-UP MARKET 안내'), false);
});

test('유튜브 출연 영상 판별: 리액션·플레이리스트는 빼고, 설명에만 나온 출연도 잡는다', async () => {
  const { isAppearance } = await import('./youtube.ts');
  assert.equal(isAppearance('[SUB] 믿는 드림에 발등 찍힌 양배추즈🥬.. | 빈집대성 ep.8 NCT DREAM', ''), true);
  // 팬덤 이름만으로는 후보가 아니고, 설명에 그룹 이름이 있으면 후보
  assert.equal(isAppearance('To. 지나가는 시즈니들아! 행복해라! | 🌓쩜오야', ''), false);
  assert.equal(isAppearance('To. 지나가는 시즈니들아! 행복해라! | 🌓쩜오야', '#쩜오야 #나나기획 #NCTDREAM #엔시티드림'), true);
  assert.equal(isAppearance("[ THAISUB ] NCT DREAM (엔시티 드림) | ' The Sun ' MV", ''), false);
  assert.equal(isAppearance('[SUB] 연기하겠습니다… | 빈집대성 ep.7 이선빈', '이선빈 편'), false);
  assert.equal(isAppearance("South African Reacts To NCT DREAM 'Boogie Woogie' MV!", ''), false);
  assert.equal(isAppearance('Playlist 파워업! K-POP 아이돌 노래 모음 | NCT DREAM', ''), false);
});

test('지난 방송을 다시 올린 하이라이트는 지금 일정이 아니다', async () => {
  const { isArchiveClip } = await import('./youtube.ts');
  assert.equal(isArchiveClip('[하이라이트] NCT DREAM 붐은 왔다✨ | #MBCRADIO | MBC 190731 방송', '', '2026-11-09T09:00:00Z'), true);
  assert.equal(isArchiveClip('NCT DREAM 출연 | MBC 261110 방송', '', '2026-11-11T09:00:00Z'), false);
  assert.equal(isArchiveClip('[리무진서비스] EP.242 엔시티 드림 런쥔', '', '2026-11-10T08:00:00Z'), false);
});

test('영상 제목에서 시리즈 이름 (모아보기 작품 태그)', async () => {
  const { seriesName } = await import('./tags.ts');
  assert.equal(seriesName('[EN/ID] 천연위고비아니고 다이어트고비가 왔숨돠 ｜ 모먹티비 EP.37 #엔시티드림'), '모먹티비');
  assert.equal(seriesName('하늘을 나는 자전거와 첫 바다낚시 | OFF TO DREAM in Mukho | EP.2'), 'OFF TO DREAM in Mukho');
  assert.equal(seriesName('Speechless | 이무진 &  NCT DREAM 런쥔 [리무진서비스 EP242]'), '리무진서비스');
  assert.equal(seriesName('꼬꼬무에 NCT DREAM 제노가 찾아왔어요'), null);
  assert.equal(seriesName('내기를 한 번 해볼까? | Ep.1 실탄 사격 | JUST DO IT:제대로 재밌게'), 'JUST DO IT:제대로 재밌게');
  assert.equal(seriesName('부산에서 재밌게 놀고 시즌3에서 봐요💚 | 천지의 이것저것 시즌2 Ep.15'), '천지의 이것저것 시즌2');
});

test('작은 예능 채널: 자체 프로그램 표시가 있으면 출연 후보, 팬 채널·팬 쇼츠는 제외', async () => {
  const { isSmallShowChannel } = await import('./youtube.ts');
  assert.equal(isSmallShowChannel('이번엔 NCT DREAM!💚 NCT 전원 회식하는 그날까지 | 해방토크 EP.31', 31200, '술 빚는 윤주모'), true);
  assert.equal(isSmallShowChannel('맛있는 한식 한 상에 막걸리?! #술빚는윤주모 #NCTDREAM #천러 #제노 #재민', 31200, '술 빚는 윤주모'), true);
  assert.equal(isSmallShowChannel('[NCT DREAM] 재민 웃음 모음 EP.3', 45000, '재민이네 꽃집'), false); // 채널 이름에 멤버
  assert.equal(isSmallShowChannel('kedip na kedip #jaemin #nctdream #kpop #제노', 41000, 'celoteh_kpop'), false); // 팬 쇼츠
  assert.equal(isSmallShowChannel('엔시티 드림이 ‘코첼라’ 나가는 이유', 54000, '연예다중계'), false); // 표시 없음
  assert.equal(isSmallShowChannel('NCT DREAM 재민 출연', 8000, '작은 채널'), false); // 구독자 1만 미만
});

test('지난 방송 클립은 원래 방송 날짜로, 예고·티저는 대표 링크 뒤로', async () => {
  const { originalAirDate } = await import('./youtube.ts');
  const { orderSources } = await import('./sourceOrder.ts');
  assert.equal(originalAirDate({ title: '[하이라이트] NCT DREAM 붐은 왔다✨ | #MBCRADIO | MBC 190731 방송', publishedAt: '2026-11-09T09:00:00Z' }), '2019-07-31');
  assert.equal(originalAirDate({ title: '[하이라이트] NCT DREAM Boogie Woogie | MBC 261108 방송', publishedAt: '2026-11-09T09:00:00Z' }), null);
  const e = { sources: [
    { type: 'youtube', url: 'a', title: '[예고] 크래시2 3회 예고편' },
    { type: 'youtube', url: 'b', title: '귀여운 장면 #크래시2 #지성 #쇼츠' },
    { type: 'youtube', url: 'c', title: '크래시2 3회 하이라이트 클립' },
    { type: 'youtube', url: 'd', title: '이번엔 NCT DREAM! | 해방토크 EP.31' },
  ] } as never as import('./consolidate.ts').PublicEvent;
  orderSources([e]);
  assert.deepEqual(e.sources.map((s) => s.url), ['d', 'c', 'b', 'a']);
});
