/**
 * 소식 주제: 일정은 아니지만 소식으로는 보여 줄 것 (광고 모델·화보·브랜드, 공항)
 *  - 브랜드·화보 기사는 캘린더 일정에서 빼고 소식 화면에만 (팝업·팬사인회 같은 실제 행사는 일정으로 남김)
 */
// 팬이 낸 옥외·생일 광고는 브랜드 소식이 아니다. 매거진·잡지는 커버·화보일 때만
// 잡지 이름만으로는 화보가 아니다 (제목 끝 "– 마리끌레르 코리아"처럼 매체 이름일 때가 많음): 화보·커버·촬영·표지·인터뷰와 함께일 때만
const MAGAZINES = '엘르|보그|하퍼스\\s*바자|바자|마리끌레르|코스모폴리탄|지큐|\\bGQ\\b|에스콰이어|아레나|더블유|데이즈드|앳스타일|싱글즈|얼루어|노블레스|퍼스트룩|하이컷|인스타일|그라치아|로피시엘|Vogue|ELLE|Harper|Dazed|Allure|Esquire|bnt';
export const BRAND_RE = new RegExp(`(?<!옥외|생일|지하철|전광판|팬\\s?)광고(?!판)|앰버서더|엠버서더|앰배서더|ambassador|모델\\s*(발탁|선정|계약)|화보|룩북|패션\\s*필름|표지|B컷|브랜드\\s*(모델|캠페인|홍보)|(매거진|잡지|magazine).{0,12}(커버|화보|cover|캠페인)|커버\\s*(공개|장식|모델|스타)|(${MAGAZINES}).{0,15}(화보|커버|촬영|표지|인터뷰)`, 'i');
export const AIRPORT_RE = /출국|입국|귀국|공항|airport/i;
// 소식 주제 나누기: 광고(모델·앰버서더·캠페인) / 브랜드·화보(화보·매거진 커버) / 차트(순위·판매량)
export const AD_RE = /(?<!옥외|생일|지하철|전광판|팬\s?)광고(?!판)|앰버서더|엠버서더|앰배서더|ambassador|모델\s*(발탁|선정|계약)|브랜드\s*(모델|캠페인|홍보)|캠페인/i;
export const CHART_RE = /차트|1위|정상|순위|판매량|초동|밀리언|한터|써클|빌보드|오리콘|멜론\s*TOP|아이튠즈|스포티파이/i;
export type FeedTopic = '공항' | '광고' | '브랜드·화보' | '차트';
/** 제목 끝의 " – 매체 이름"은 빼고 본다 */
const stripOutlet = (t: string) => t.replace(/\s+[–-]\s+[^–-]{1,24}$/, '');
export const topicOf = (raw: string): FeedTopic | undefined => {
  const title = stripOutlet(raw);
  return AIRPORT_RE.test(title) ? '공항' : AD_RE.test(title) ? '광고' : BRAND_RE.test(title) ? '브랜드·화보' : CHART_RE.test(title) ? '차트' : undefined;
};

/**
 * 소식 탭에서 뺄 잡다한 기사 (일정·활동 기사 목록에는 영향 없음, 소식 탭 비중 조절용)
 *  - 라인업 기사: 출연 일정은 캘린더에 이미 있음
 *  - 한 매체만 쓴 SNS·외모 근황 기사 (셀카·비주얼·근황·[포토] 잘생겼다). 티저·콘셉트·무대·인터뷰·포스터는 남김
 * 드림·멤버 이름이 없는 기사는 publish.ts가 그룹·멤버 이름으로 따로 뺀다.
 */
export const LINEUP_RE = /라인업/;
export const FILLER_RE = /근황|셀카|셀피|SNS|인스타|외모|비주얼|미모|자태|잘생|넘사벽|조각|꽃미남|훈남|심쿵|미소/;
const FILLER_KEEP_RE = /티저|콘셉트|컨셉|무대|일문일답|인터뷰|쇼케이스|뮤직비디오|MV|발매|출연|캐스팅|포스터/;
export function isFillerArticle(title: string, outlets: number, topic?: FeedTopic): boolean {
  if (LINEUP_RE.test(title)) return true;
  if (topic) return false;
  return outlets <= 1 && FILLER_RE.test(title) && !FILLER_KEEP_RE.test(title);
}

/**
 * 부정적인 기사(논란·가십)와 주가·실적 기사: 사이트(소식·활동 기사 목록·물어보기 근거)에 올리지 않는다. 저장은 해 둔다.
 * 건강 문제로 인한 불참·활동 중단처럼 일정에 영향을 주는 소식은 팬이 알아야 해서 여기 넣지 않는다.
 */
export const NEGATIVE_RE = /논란|의혹|루머|열애|결별|악플|악성\s*댓글|비난|비판|저격|폭로|고소|피소|소송|법적\s*대응|사생|스토킹|협박|위협|불화|탈퇴설|학폭|갑질|표절|사과문|망언|태도\s*지적|혹평|과잉\s*경호|몸싸움|난동|성희롱|명예훼손|허위\s*사실/;
/** 주가·증권·실적 기사 (팬 소식이 아님): 부정적인 기사와 똑같이 소식·활동 기사·물어보기 근거에서 뺀다 */
export const FINANCE_RE = /주가|주식|증권|목표\s*주가|목표가|시가총액|시총|투자의견|투자\s*포인트|영업이익|순이익|매출|실적\s*(발표|전망|개선|부진|호조|시즌)|어닝|공시|코스닥|코스피|주주|배당|애널리스트|엔터주|신고가|순매수|순매도|매수\s*(의견|추천)/;
export const isNegative = (title: string) => NEGATIVE_RE.test(title) || FINANCE_RE.test(title);
