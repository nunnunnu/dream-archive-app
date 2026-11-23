import { ymd, type EraSummary, type SeriesSummary } from './data';

export const SERIES_CATEGORIES = [
  { id: 'originals', name: '자체 콘텐츠 시리즈', note: 'NCT DREAM의 자체 프로그램과 영상', types: ['자체 콘텐츠 시리즈'] },
  { id: 'nct', name: 'NCT 단체', note: '드림 멤버가 참여한 NCT 합동 콘텐츠', types: ['NCT 단체'] },
  { id: 'collections', name: '종류별 모아보기', note: '해마다 쌓이는 비하인드·안무·녹음', types: ['종류별 모아보기'] },
  { id: 'external', name: '외부활동', note: '다른 채널에서 출연한 프로그램', types: ['외부활동', '고정 출연'] },
  { id: 'recurring', name: '반복 활동', note: '생일·시상식·개인·유닛 활동 모음', types: ['반복 활동'] },
  { id: 'drama', name: '드라마', note: '작품별 출연·관련 영상', types: [] },
  { id: 'ads', name: '광고', note: '브랜드별 캠페인 기록', types: ['광고'] },
  { id: 'radio', name: '라디오', note: '프로그램별 방송 기록', types: ['라디오'] },
];

export type SeriesCategory = (typeof SERIES_CATEGORIES)[number];
export const categoryHref = (id: string) => `/series/category/${id}/`;
export const seriesCountLabel = ({ count, type }: Pick<SeriesSummary, 'count' | 'type'>) =>
  type === '반복 활동' ? `활동 ${count}개` : `${count}${['외부활동', '광고', '라디오'].includes(type) ? '건' : '편'}`;

export function seriesCategoryCards(category: SeriesCategory, series: SeriesSummary[], eras: EraSummary[]) {
  if (category.id === 'drama') {
    return eras.filter((e) => e.kind === '드라마').sort((a, b) => b.from.localeCompare(a.from)).map((e) => ({
      name: e.title, href: `/archive/${e.id}/`, thumb: e.thumb, badge: e.kind, meta: `${e.owner.label} · ${ymd(e.from).slice(0, 7)}`,
    }));
  }
  return series.filter((s) => category.types.includes(s.type)).map((s) => ({
    name: s.name, href: `/series/${s.id}/`, thumb: s.thumb, badge: s.type,
    meta: `${seriesCountLabel(s)} · ${ymd(s.from).slice(0, 7)} – ${ymd(s.to).slice(0, 7)}`,
  }));
}
