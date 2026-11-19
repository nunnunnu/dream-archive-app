/**
 * 활동 주소(id) 고정: 활동 이름이 바뀌어도(부기우기 → DREAM AFTER DREAM) 한 번 쓴 주소는 유지한다 (공유한 링크가 깨지지 않게).
 * 상태 activities/ids: { 주소: 그 활동의 이름들 }. 이름이 하나라도 겹치고 시작일이 60일 안이면 같은 활동.
 */
import type { Activity } from './activities.ts';
import type { Repo } from './repo.ts';

const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
export async function stabilizeEraIds(repo: Repo, acts: Activity[]): Promise<number> {
  const prev = await repo.getState<Record<string, { keys: string[]; from: string }>>('activities/ids', {});
  // 겹치는 이름이 가장 많은 짝부터 정한다 (예능 활동이 이름 하나 겹친다고 주소를 가져가지 않게)
  const pairs: { a: Activity; id: string; score: number }[] = [];
  for (const a of acts) {
    const keys = new Set(a.keys.map(sq).filter((k) => k.length >= 3));
    for (const [id, p] of Object.entries(prev)) {
      const overlap = p.keys.filter((k) => keys.has(k)).length;
      const days = Math.abs(Date.parse(p.from) - Date.parse(a.from)) / 864e5;
      if (overlap > 0 && days <= 60) pairs.push({ a, id, score: overlap * 100 - days + (id === a.id ? 1000 : 0) });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const usedId = new Set<string>();
  const done = new Set<Activity>();
  let kept = 0;
  for (const { a, id } of pairs) {
    if (done.has(a) || usedId.has(id)) continue;
    // 예전 주소가 한글로만 돼 있고(기사의 한글 표기로 생김) 지금 이름으로 영문 주소가 나오면 영문으로 바꾼다 (2026-룸메이트 → 2026-roommate)
    if (/^\d{4}-[가-힣\d]+$/.test(id) && !/[가-힣]/.test(a.id) && !prev[a.id]) { delete prev[id]; done.add(a); usedId.add(a.id); continue; }
    if (a.id !== id) { a.id = id; kept++; }
    done.add(a);
    usedId.add(id);
  }
  // 짝이 없는 활동의 새 주소가 이미 쓰인 주소와 겹치지 않게
  for (const a of acts) if (!done.has(a) && usedId.has(a.id)) a.id = `${a.id}-2`;
  for (const a of acts) prev[a.id] = { keys: [...new Set([...(prev[a.id]?.keys ?? []), ...a.keys.map(sq).filter((k) => k.length >= 3)])], from: a.from };
  await repo.putState('activities/ids', prev);
  return kept;
}
