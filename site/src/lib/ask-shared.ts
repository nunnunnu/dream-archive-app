/** 물어보기 API 공용: 질문 묶기 열쇠, 카테고리, 개인정보 가리기, KV 형태 */
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(opts: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

export async function sha(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** 같은 질문 묶기 열쇠: 띄어쓰기·기호·물음표 차이는 같은 질문 */
export const questionKey = (q: string) => sha(q.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));

/** 질문 카테고리 (화면 표시·이어서 물어볼 질문용). 앞에서부터 먼저 맞는 것 */
export const CATEGORIES = ['사녹·방송', '예매·응모', '앨범·MD', '소식', '오늘·이번주', '기타'] as const;
export type Category = (typeof CATEGORIES)[number];
export function categoryOf(q: string): Category {
  if (/사녹|사전\s*녹화|음중|음악중심|뮤뱅|뮤직뱅크|인가|인기가요|엠카|쇼챔|더쇼|방송|녹화|라디오|예능|드라마|어디서\s*(봐|볼)/.test(q)) return '사녹·방송';
  if (/예매|티켓|응모|팬싸|팬사인|영통|영상\s*통화|당첨|추첨|신청|콘서트|팬미팅|이벤트/.test(q)) return '예매·응모';
  if (/앨범|미공포|포카|포토\s*카드|특전|MD|굿즈|판매|구매|시그|팝업/i.test(q)) return '앨범·MD';
  if (/출국|입국|귀국|공항|광고|화보|앰버서더|소식|근황/.test(q)) return '소식';
  if (/오늘|내일|모레|이번\s*주|다음\s*주|주말|[월화수목금토일]요일|일정/.test(q)) return '오늘·이번주';
  return '기타';
}

/** 질문에 섞인 개인정보 가리기 (전화번호·이메일·카드·계좌 같은 긴 숫자). 날짜·시간은 그대로 */
export const maskPersonal = (t: string) => t
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '(이메일)')
  .replace(/\b01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}\b/g, '(전화번호)')
  .replace(/\d[\d-\s]{9,}\d/g, '(숫자)');
