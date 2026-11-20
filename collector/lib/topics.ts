/**
 * 소식 주제: 일정은 아니지만 소식으로는 보여 줄 것 (광고 모델·화보·브랜드, 공항)
 *  - 브랜드·화보 기사는 캘린더 일정에서 빼고 소식 화면에만 (팝업·팬사인회 같은 실제 행사는 일정으로 남김)
 */
// 팬이 낸 옥외·생일 광고는 브랜드 소식이 아니다. 매거진·잡지는 커버·화보일 때만
export const BRAND_RE = /(?<!옥외|생일|지하철|전광판|팬\s?)광고(?!판)|앰버서더|엠버서더|앰배서더|ambassador|모델\s*(발탁|선정|계약)|화보|브랜드\s*(모델|캠페인|홍보)|(매거진|잡지|magazine).{0,12}(커버|화보|cover)|커버\s*(공개|장식)/i;
export const AIRPORT_RE = /출국|입국|귀국|공항|airport/i;
// 소식 주제 나누기: 광고(모델·앰버서더·캠페인) / 브랜드·화보(화보·매거진 커버) / 차트(순위·판매량)
export const AD_RE = /(?<!옥외|생일|지하철|전광판|팬\s?)광고(?!판)|앰버서더|엠버서더|앰배서더|ambassador|모델\s*(발탁|선정|계약)|브랜드\s*(모델|캠페인|홍보)|캠페인/i;
export const CHART_RE = /차트|1위|정상|순위|판매량|초동|밀리언|한터|써클|빌보드|오리콘|멜론\s*TOP|아이튠즈|스포티파이/i;
export type FeedTopic = '공항' | '광고' | '브랜드·화보' | '차트';
export const topicOf = (title: string): FeedTopic | undefined =>
  AIRPORT_RE.test(title) ? '공항' : AD_RE.test(title) ? '광고' : BRAND_RE.test(title) ? '브랜드·화보' : CHART_RE.test(title) ? '차트' : undefined;

/**
 * 부정적인 기사(논란·가십): 사이트(소식·활동 기사 목록·물어보기 근거)에 올리지 않는다. 저장은 해 둔다.
 * 건강 문제로 인한 불참·활동 중단처럼 일정에 영향을 주는 소식은 팬이 알아야 해서 여기 넣지 않는다.
 */
export const NEGATIVE_RE = /논란|의혹|루머|열애|결별|악플|악성\s*댓글|비난|비판|저격|폭로|고소|피소|소송|법적\s*대응|사생|스토킹|협박|위협|불화|탈퇴설|학폭|갑질|표절|사과문|망언|태도\s*지적|혹평|과잉\s*경호|몸싸움|난동|성희롱|명예훼손|허위\s*사실/;
export const isNegative = (title: string) => NEGATIVE_RE.test(title);
