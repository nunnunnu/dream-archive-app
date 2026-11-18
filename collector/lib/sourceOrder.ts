/**
 * 일정 출처 순서 정리: 화면·질문 답변은 첫 출처를 대표 링크로 쓴다.
 * 공지 > 기사 > SNS > 본편 영상(EP·풀영상) > 클립 > 쇼츠 > 예고·티저·선공개 > 링크 없는 출처
 */
import type { PublicEvent } from './consolidate.ts';

const TYPE_RANK: Record<string, number> = { 'weverse-notice': 0, notice: 0, news: 1, sns: 2, youtube: 3, submission: 3 };
const videoRank = (title = '') => {
  // 예고·티저·선공개는 맨 뒤: 본방·본편이 올라오면 그쪽이 대표 링크·썸네일이 된다
  if (/예고|티저|teaser|선공개|preview|trailer|미리\s*보기|스포일러|coming\s*soon|커밍\s*순/i.test(title.normalize('NFKC'))) return 3;
  if (/\bEP\.?\s*\d+|풀영상|full\s*(vod|ver)|본편|\d+\s*회\b/i.test(title)) return 0;
  const tags = (title.match(/#\S+/g) ?? []).length;
  return tags >= 2 || /shorts|쇼츠/i.test(title) ? 2 : 1;
};
export function orderSources(events: PublicEvent[], durationOf: (url: string) => number | undefined = () => undefined): void {
  for (const e of events) {
    const vr = (s: PublicEvent['sources'][number]) => {
      const r = videoRank(s.title);
      const d = durationOf(s.url);
      return r === 3 ? 3 : d !== undefined ? (d <= 60 ? 2 : r === 2 ? 1 : r) : r; // 길이를 알면 1분 이하만 쇼츠
    };
    // 유튜브 주소면 SNS·제보로 들어왔어도 영상으로 본다 (예고 영상이 SNS 출처로 들어와 대표가 되는 일 방지)
    const isYt = (s: PublicEvent['sources'][number]) => s.type === 'youtube' || /youtu\.?be/.test(s.url);
    const rank = (s: PublicEvent['sources'][number]) => (s.url ? 0 : 100) + (isYt(s) ? TYPE_RANK.youtube : TYPE_RANK[s.type] ?? 5) * 10 + (isYt(s) ? vr(s) : 0);
    e.sources = e.sources.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
  }
}
