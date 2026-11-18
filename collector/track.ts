/**
 * 고정 출연 직접 추적 목록에 올리기 / 보기
 *
 * 사용: npm run track -- "ENA 크래시2" --members 지성 --days 월,화 --time 22:00 --start 2026-11-16 [--episodes 12] [--end 2026-12-22]
 *       npm run track -- --list
 */
import { createHash } from 'node:crypto';
import { JsonRepo } from './lib/repo.ts';
import { addTracked, loadTracked } from './lib/tracked.ts';

const args = process.argv.slice(2);
const opt = (name: string) => (args.indexOf(`--${name}`) >= 0 ? args[args.indexOf(`--${name}`) + 1] : undefined);
const repo = new JsonRepo();

if (args.includes('--list')) {
  for (const t of await loadTracked(repo)) {
    console.log(`${t.status === 'active' ? '추적 중' : '끝남'} | ${t.title} | 매주 ${t.weekdays.join('·')} ${t.time ?? '시간?'} | ${t.startDate}부터${t.episodes ? ` ${t.episodes}부작` : ''}${t.endDate ? ` ~${t.endDate}` : ''} | ${t.members.join('·') || '단체'} | ${t.origin === 'auto' ? '자동' : '직접'}`);
  }
  process.exit(0);
}

const title = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const start = opt('start');
const days = opt('days')?.split(/[,·]/).map((d) => d.trim().replace('요일', ''));
if (!title || !start || !days?.length) {
  console.error('사용: npm run track -- "ENA 크래시2" --members 지성 --days 월,화 --time 22:00 --start 2026-11-16 [--episodes 12] [--end 2026-12-22]');
  process.exit(1);
}
const t = await addTracked(
  repo,
  {
    id: `manual-${createHash('sha1').update(title).digest('hex').slice(0, 8)}`,
    title,
    members: opt('members')?.split(/[,·]/).map((m) => m.trim()) ?? [],
    weekdays: days,
    time: opt('time') ?? null,
    startDate: start,
    episodes: opt('episodes') ? Number(opt('episodes')) : null,
    endDate: opt('end') ?? null,
  },
  new Date(),
);
console.log(`추적 목록에 올림: ${t.title} (매주 ${t.weekdays.join('·')} ${t.time ?? ''}, ${t.startDate}부터). 다음 수집 때 반영돼요.`);
