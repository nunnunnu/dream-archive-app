/**
 * 소식 주제: 일정은 아니지만 소식으로는 보여 줄 것 (광고 모델·화보·브랜드, 공항)
 *  - 브랜드·화보 기사는 캘린더 일정에서 빼고 소식 화면에만 (팝업·팬사인회 같은 실제 행사는 일정으로 남김)
 */
// 팬이 낸 옥외·생일 광고는 브랜드 소식이 아니다. 매거진·잡지는 커버·화보일 때만
export const BRAND_RE = /(?<!옥외|생일|지하철|전광판|팬\s?)광고(?!판)|앰버서더|엠버서더|앰배서더|ambassador|모델\s*(발탁|선정|계약)|화보|브랜드\s*(모델|캠페인|홍보)|(매거진|잡지|magazine).{0,12}(커버|화보|cover)|커버\s*(공개|장식)/i;
export const AIRPORT_RE = /출국|입국|귀국|공항|airport/i;
export type FeedTopic = '공항' | '브랜드·화보';
export const topicOf = (title: string): FeedTopic | undefined => (AIRPORT_RE.test(title) ? '공항' : BRAND_RE.test(title) ? '브랜드·화보' : undefined);
