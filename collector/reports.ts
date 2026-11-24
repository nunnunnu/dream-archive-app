/**
 * 사이트 제보 확인·승인 (운영자용)
 *   STORE=pg npm run reports        대기 목록 보기 (Supabase reports 테이블)
 *   npm run reports -- --approve ID 승인: 추가 → 제보 처리(링크 읽기·AI), 삭제 → 숨기기, 보완 → 고치기 (config/overrides.json)
 *   npm run reports -- --reject ID  거절
 */
import './lib/env.ts';
import { loadOverrides, saveOverrides } from './lib/overrides.ts';
import { JsonRepo } from './lib/repo.ts';
import { addSubmission } from './lib/submissions.ts';

interface Report {
  id: string; type: 'add' | 'delete' | 'fix'; url: string; message: string; eventId: string; eventTitle: string;
  date: string; time: string; members: string[]; status: 'pending' | 'approved' | 'rejected'; createdAt: string;
}
const TYPE = { add: '추가 요청', delete: '삭제 요청', fix: '정보 보완 요청' };
const repo = new JsonRepo();
// 제보는 사이트가 Supabase reports 테이블에 바로 넣는다 (STORE=pg 로 실행하면 그 목록을 본다)
const local = await repo.getState<Record<string, Report>>('reports', {});

const arg = (name: string) => process.argv[process.argv.indexOf(`--${name}`) + 1];
const now = new Date();
if (process.argv.includes('--approve') || process.argv.includes('--reject')) {
  const id = arg(process.argv.includes('--approve') ? 'approve' : 'reject');
  const r = local[id];
  if (!r) throw new Error(`제보 ${id} 없음`);
  if (process.argv.includes('--approve')) {
    const o = loadOverrides();
    const target = { id: r.eventId, date: r.date || r.eventTitle.match(/(\d{1,2})\.\s*(\d{1,2})/)?.slice(1).join('-') || '', title: r.eventTitle, reason: r.message, reportId: r.id };
    if (r.type === 'add') {
      if (!r.url) throw new Error('링크 없는 추가 요청은 직접 일정으로 넣어 주세요 (npm run submit -- <링크> --text "...")');
      await addSubmission(repo, r.url, r.message || undefined, now, r.members.length ? `${r.members.join('·')} (제보)` : undefined);
      console.log('추가 요청 → 제보 처리 대기열에 넣음 (다음 수집 때 읽음)');
    } else if (r.type === 'delete') {
      o.hide.push(target);
      console.log('삭제 요청 → 숨기기에 추가');
    } else {
      o.patch.push({ ...target, set: { ...(r.date ? { date: r.date } : {}), ...(r.time ? { time: r.time } : {}), ...(r.members.length ? { members: r.members } : {}), ...(r.url ? { url: r.url } : {}) } });
      console.log('보완 요청 → 고치기에 추가');
    }
    saveOverrides(o);
    r.status = 'approved';
  } else r.status = 'rejected';
}
await repo.putState('reports', local);

const pending = Object.values(local).filter((r) => r.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
console.log(`\n대기 중인 제보 ${pending.length}개`);
for (const r of pending) {
  console.log(`- [${r.id}] ${TYPE[r.type]} · ${r.createdAt.slice(0, 16)}`);
  if (r.eventTitle) console.log(`    대상: ${r.eventTitle} (${r.eventId})`);
  if (r.date || r.time) console.log(`    날짜·시간: ${r.date} ${r.time}`);
  if (r.members.length) console.log(`    멤버: ${r.members.join('·')}`);
  if (r.url) console.log(`    링크: ${r.url}`);
  if (r.message) console.log(`    내용: ${r.message}`);
}
