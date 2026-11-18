import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractKeywords } from './fanKeywords.ts';

test('흔한 영어 단어(앨범명의 After 등)는 화제 단어로 쓰지 않는다', () => {
  assert.deepEqual(extractKeywords('This album has much more to tell. Dream After Dream was made in Stockholm'), ['Stockholm']);
});

test('짧은 반응 글에서 화제 단어만 남긴다', () => {
  assert.deepEqual(extractKeywords('으엥 드림 코첼라?????'), ['코첼라']);
});

test('조사를 떼고, 멤버·팬덤 이름과 동사는 버린다', () => {
  assert.deepEqual(extractKeywords('드림이들 코첼라가 진짜 나간다고?? 재민이 전과자 출연했네'), ['코첼라', '전과자', '출연']);
});

test('ㅋㅋ, 이모지, 링크, 해시태그 기호는 무시한다', () => {
  assert.deepEqual(extractKeywords('ㅋㅋㅋㅋ 🎉 https://x.com/a 뮤뱅 1위!! #NCTDREAM_BoogieWoogie'), ['뮤뱅', 'BoogieWoogie']);
});

test('영어는 대문자로 시작하는 고유명사만', () => {
  assert.deepEqual(extractKeywords('see you at Coachella this year with the boys'), ['Coachella']);
});

test('일본어 등 띄어쓰기로 단어를 나눌 수 없는 글은 건너뛴다', () => {
  assert.deepEqual(extractKeywords('こんばんは。仕事終わって帰宅後寝落ちてまして'), []);
});
