/**
 * 링크 제보: 자동 수집이 못 잡는 글을 넣는다. 다음 수집 때 처리된다.
 *
 * 사용: npm run submit -- <링크>
 *       npm run submit -- <웨이보 링크> --text "글 내용 붙여 넣기"
 *       npm run submit -- <링크> --note "지성 추측"   (게스트 예고 등 추측 메모)
 */
import { JsonRepo } from './lib/repo.ts';
import { addSubmission } from './lib/submissions.ts';

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const textIdx = args.indexOf('--text');
const text = textIdx >= 0 ? args[textIdx + 1] : undefined;
const noteIdx = args.indexOf('--note');
const note = noteIdx >= 0 ? args[noteIdx + 1] : undefined;
if (!url) {
  console.error('사용: npm run submit -- <링크> [--text "글 내용"] [--note "지성 추측"]');
  process.exit(1);
}
const sub = await addSubmission(new JsonRepo(), url, text, new Date(), note);
console.log(`제보 추가: ${sub.url}${sub.text ? ' (글 내용 포함)' : ''}${sub.note ? ` (메모: ${sub.note})` : ''}. 다음 수집(npm run collect) 때 처리돼요.`);
if (/weibo\./.test(url) && !text) console.log('웨이보는 로그인 없이 못 읽어서, 글 내용을 --text 로 함께 넣어 주세요.');
