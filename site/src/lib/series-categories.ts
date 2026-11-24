import { ymd, type EraSummary, type SeriesSummary } from './data';

export const SERIES_CATEGORIES = [
  { id: 'originals', name: '자체 콘텐츠 시리즈', note: 'NCT DREAM의 자체 프로그램과 영상', types: ['자체 콘텐츠 시리즈'] },
  { id: 'nct', name: 'NCT 단체', note: '드림 멤버가 참여한 NCT 합동 콘텐츠', types: ['NCT 단체'] },
  { id: 'collections', name: '종류별 모아보기', note: '퍼포먼스·안무·녹음 등 영상 종류별 모음', types: ['종류별 모아보기'] },
  { id: 'concert-behind', name: '콘서트·팬미팅 비하인드', note: '공연별 비하인드와 리캡', types: ['콘서트·팬미팅 비하인드'] },
  { id: 'awards', name: '시상식·연말 무대', note: '시상식 기록과 연말 무대·안무·비하인드', types: ['시상식·연말 무대'] },
  { id: 'external', name: '외부활동', note: '다른 채널에서 출연한 프로그램', types: ['외부활동', '고정 출연'] },
  { id: 'recurring', name: '반복 활동', note: '생일·개인·유닛 활동 모음', types: ['반복 활동'] },
  { id: 'drama', name: '드라마', note: '작품별 출연·관련 영상', types: ['드라마'] },
  { id: 'ads', name: '광고', note: '브랜드별 캠페인 기록', types: ['광고'] },
  { id: 'pictorials', name: '화보', note: '매거진·브랜드별 화보 기록', types: ['화보'] },
  { id: 'radio', name: '라디오', note: '프로그램별 방송 기록', types: ['라디오'] },
];

export type SeriesCategory = (typeof SERIES_CATEGORIES)[number];
export const categoryHref = (id: string) => `/series/category/${id}/`;
export const seriesCountLabel = ({ id, count, type }: Pick<SeriesSummary, 'id' | 'count' | 'type'>) =>
  type === '반복 활동' || id === 'r-시상식' ? `활동 ${count}개` : `${count}${['외부활동', '광고', '화보', '드라마', '라디오'].includes(type) ? '건' : '편'}`;

export function seriesCategoryCards(category: SeriesCategory, series: SeriesSummary[], eras: EraSummary[]) {
  if (category.id === 'drama') {
    // 같은 이름의 드라마 시리즈(소식·제보 모음)가 있으면 그쪽 카드 하나만 (시리즈 페이지가 아카이브로 이어 줌)
    const key = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    const dramaSeries = series.filter((s) => s.type === '드라마');
    const named = new Set(dramaSeries.map((s) => key(s.name)));
    return [
      ...eras.filter((e) => e.kind === '드라마' && !named.has(key(e.title))).map((e) => ({
        name: e.title, href: `/archive/${e.id}/`, thumb: e.thumb, badge: e.kind, meta: `${e.owner.label} · ${ymd(e.from).slice(0, 7)}`, from: e.from,
      })),
      ...dramaSeries.map((s) => ({ name: s.name, href: `/series/${s.id}/`, thumb: s.thumb, badge: s.type, meta: `${seriesCountLabel(s)} · ${ymd(s.from).slice(0, 7)}`, from: s.from })),
    ].sort((a, b) => b.from.localeCompare(a.from)).map(({ from: _, ...card }) => card);
  }
  return series.filter((s) => category.types.includes(s.type))
    .sort((a, b) => b.to.localeCompare(a.to) || a.name.localeCompare(b.name, 'ko'))
    .map((s) => ({
      name: s.name, href: `/series/${s.id}/`, thumb: s.thumb, badge: s.type,
      meta: `${seriesCountLabel(s)} · ${ymd(s.from).slice(0, 7)} – ${ymd(s.to).slice(0, 7)}`,
    }));
}
