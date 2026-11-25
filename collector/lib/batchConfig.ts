/** 배치 설정 (lib/batch.ts 와 바로 처리하는 쪽이 같이 쓴다) */
/** 이보다 오래된 소식(기사 묶음의 가장 새 기사, 소식 제보의 소식 날짜)은 하루 한 번 배치로 */
export const BATCH_AGE_DAYS = 7;
export const BATCH_MODEL = process.env.BATCH_MODEL ?? process.env.OPENAI_FALLBACK_MODEL ?? 'gpt-5-mini';
/** 소식 제보 판정은 바로 할 때도 nano 라서 배치도 nano */
export const BATCH_JUDGE_MODEL = 'gpt-5-nano';
/** OPENAI 키가 있고 BATCH_OLD_ARTICLES=0 이 아니면 켜짐 */
export const batchEnabled = () => Boolean(process.env.OPENAI_API_KEY) && process.env.BATCH_OLD_ARTICLES !== '0';
export const BATCH_WAIT_REASON = '오래된 소식이라 하루 한 번 배치로 AI가 판정해요.';
