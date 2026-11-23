import { ymd, type EraSummary, type SeriesSummary } from './data';

export const SERIES_CATEGORIES = [
  { id: 'external', name: '외부활동', types: ['외부활동', '고정 출연'] },
  { id: 'originals', name: '자체 콘텐츠', types: ['자체 콘텐츠 시리즈'] },
  { id: 'drama', name: '드라마', types: [] },
  { id: 'ads', name: '광고', types: ['광고'] },
  { id: 'radio', name: '라디오', types: ['라디오'] },
  { id: 'collections', name: '종류별 모아보기', types: ['종류별 모아보기'] },
  { id: 'recurring', name: '반복 활동', types: ['반복 활동'] },
];

export type SeriesCategory = (typeof SERIES_CATEGORIES)[number];
export const categoryHref = (id: string) => `/series/category/${id}/`;
export const seriesCountLabel = ({ count, type }: Pick<SeriesSummary, 'count' | 'type'>) =>
  `${count}${type === '반복 활동' ? '개 활동' : ['외부활동', '광고', '라디오'].includes(type) ? '건' : '편'}`;

export function seriesCategoryCards(category: SeriesCategory, series: SeriesSummary[], eras: EraSummary[]) {
  if (category.id === 'drama') {
    return eras.filter((e) => e.kind === '드라마').sort((a, b) => b.from.localeCompare(a.from)).map((e) => ({
      name: e.title, href: `/archive/${e.id}/`, thumb: e.thumb, meta: `${e.owner.label} · ${ymd(e.from).slice(0, 7)}`,
    }));
  }
  return series.filter((s) => category.types.includes(s.type)).map((s) => ({
    name: s.name, href: `/series/${s.id}/`, thumb: s.thumb, meta: `${seriesCountLabel(s)} · ${ymd(s.to).slice(0, 7)}`,
  }));
}
