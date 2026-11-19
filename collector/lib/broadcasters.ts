/**
 * 프로그램 이름 앞의 방송사·플랫폼 이름 떼기 (한 곳에서만 정의한다).
 * 한글·영어가 섞여 온다: "Mnet Plus IDOL'S TABLE" = "엠넷플러스 IDOL'S TABLE"
 */
const LATIN = 'Mnet\\s*Plus|KBS\\s*2|KBS|MBC\\s*every1|MBC|SBS|JTBC|ENA|tvN|Mnet|MBN|Netflix|TVING|wavve';
const KOREAN = '엠넷\\s*플러스|케이비에스|엠비씨|에스비에스|엠넷|TV조선|채널A|유튜브|웹예능|넷플릭스|티빙|쿠팡플레이|웨이브';
/** 영어 방송사는 뒤에 띄어쓰기가 있을 때만, 한글은 붙어 있어도 */
export const BROADCASTER_PREFIX_RE = new RegExp(`^(?:(?:${LATIN})\\s+|(?:${KOREAN})\\s*)`, 'i');
/** 방송사 이름을 뗀 프로그램 이름 ("KBS2 Mnet Plus …"처럼 두 번 붙은 것도) */
export const stripBroadcaster = (t: string) => t.normalize('NFKC').replace(BROADCASTER_PREFIX_RE, '').replace(BROADCASTER_PREFIX_RE, '').trim();
