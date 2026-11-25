/**
 * AI(Groq 무료 우선, OpenAI 예비)로 문서에서 일정 뽑기 + 원문 대조 검증
 *
 * 해석은 AI가, 검증은 규칙이:
 *  - AI가 낸 근거 문장(evidence)이 원문에 있어야 한다
 *  - 날짜의 "일" 숫자, 시간의 "시" 숫자가 근거에 있어야 확정. 없으면 "확인 필요"
 *  - 기사가 지난 일을 다시 언급한 것(기사 날짜보다 이틀 이상 전)은 일정으로 쓰지 않는다
 *
 * 키: 프로젝트 루트 .env 의 GROQ_API_KEY, 예비 OPENAI_API_KEY
 */
import './env.ts';
import { callAi, hasAiKey, primaryModel } from './ai-provider.ts';
import { GROUP, GROUP_NAME_RE } from './group.ts';
import { MEMBERS, mentionedMembers } from './members.ts';
import type { EventKind } from './scheduleParser.ts';
import { kstDate, toKstParts } from './time.ts';

/** 쓸 모델. 비교에서 가장 정확했던 gpt-5-mini가 기본. LLM_MODEL 환경변수로 바꾼다. */
export const LLM_MODEL = process.env.LLM_MODEL ?? primaryModel(process.env);
/** 추론 정도. LLM_EFFORT 환경변수로 바꾼다 (low / medium …) */
export const LLM_EFFORT = (process.env.LLM_EFFORT ?? 'medium') as 'low' | 'medium' | 'high';
/** 프롬프트를 바꾸면 올린다 (저장해 둔 AI 결과를 다시 만들기 위해). 공지와 기사는 따로 센다. */
export const NOTICE_PROMPT_VERSION = 2;
export const ARTICLE_PROMPT_VERSION = 2;
export const VIDEO_PROMPT_VERSION = 5; // 결방 안내 추가는 새 기사에만 적용 (예전 결과는 그대로 사용)
/** @deprecated 공지 버전. 예전 코드 호환용 */
export const PROMPT_VERSION = NOTICE_PROMPT_VERSION;

export const hasLlmKey = () => hasAiKey(process.env);

export const KINDS: EventKind[] = ['신청', '당첨 발표', '본인 확인', '녹화', '방송', '발매', '투표', '판매', '행사', '모임', '기타'];
const MEMBER_NAMES = MEMBERS.map((m) => m.name);
const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

export interface Recurrence {
  /** 방송 요일 ("월", "화" …) */
  weekdays: string[];
  /** 회차 수 (모르면 null) */
  episodes: number | null;
  /** 종영일 YYYY-MM-DD (모르면 null) */
  end_date: string | null;
}

export interface LlmEvent {
  /** 날짜를 모르면 null (예: "2027 코첼라 출연 확정") */
  date: string | null;
  time: string | null;
  end_date: string | null;
  end_time: string | null;
  /** 한국 시간이 아니면 현지 시간대 (예: "PHT") */
  timezone: string | null;
  /** 무엇의 일정인지 (예: "KBS 뮤직뱅크 사전녹화", "SBS 꼬꼬무", "MMA 2026") */
  target: string;
  /** 그 안의 단계 (예: "참여 신청", "제노 출연", "1차 티켓 예매", "첫 방송") */
  step: string;
  kind: EventKind;
  /** 관련 멤버. 비어 있으면 단체 */
  members: string[];
  /** 원문에서 그대로 옮긴 근거 문장 */
  evidence: string;
  /** 날짜를 모를 때 원문의 시기 표현 (예: "2027년 4월", "내년") */
  when_text?: string | null;
  /** 매주 방송되는 고정 출연(드라마·예능)이면 반복 정보 */
  recurrence?: Recurrence | null;
  /** 그룹(멤버)이 이 일정에 직접 나온다는 원문 문장 (기사·영상). 없으면 null */
  participation?: string | null;
}

const nullable = (type: string) => ({ type: [type, 'null'] });
const BASE_EVENT_PROPS = {
  time: { ...nullable('string'), description: 'HH:MM (24시간). 없으면 null' },
  end_date: { ...nullable('string'), description: '기간의 끝 날짜 YYYY-MM-DD. 하루면 null' },
  end_time: { ...nullable('string'), description: '끝 시간 HH:MM. 없으면 null' },
  timezone: { ...nullable('string'), description: '한국 시간이 아닐 때만 시간대 약어 (예: PHT). 한국이면 null' },
  target: { type: 'string' },
  step: { type: 'string' },
  kind: { type: 'string', enum: KINDS },
  members: { type: 'array', items: { type: 'string', enum: MEMBER_NAMES } },
  evidence: { type: 'string' },
};
const BASE_REQUIRED = ['date', 'time', 'end_date', 'end_time', 'timezone', 'target', 'step', 'kind', 'members', 'evidence'];

const schemaOf = (item: object) => ({
  type: 'object',
  properties: { events: { type: 'array', items: item } },
  required: ['events'],
  additionalProperties: false,
});

/** 공지용 (예전과 같아서 저장해 둔 공지 결과를 그대로 쓸 수 있다) */
const NOTICE_SCHEMA = schemaOf({
  type: 'object',
  properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, ...BASE_EVENT_PROPS },
  required: BASE_REQUIRED,
  additionalProperties: false,
});

/** 기사·제보용: 날짜 미정, 반복 방송까지 */
const ARTICLE_SCHEMA = schemaOf({
  type: 'object',
  properties: {
    date: { ...nullable('string'), description: 'YYYY-MM-DD. 날짜가 아직 없으면 null' },
    ...BASE_EVENT_PROPS,
    when_text: { ...nullable('string'), description: '날짜가 null일 때 원문의 시기 표현 (예: "2027년 4월"). 아니면 null' },
    participation: { ...nullable('string'), description: '그룹 또는 멤버가 이 일정에 직접 나오거나 한다는 것을 보여 주는 원문 문장 (글자 그대로). 없으면 null' },
    recurrence: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            weekdays: { type: 'array', items: { type: 'string', enum: WEEKDAY_NAMES } },
            episodes: nullable('integer'),
            end_date: nullable('string'),
          },
          required: ['weekdays', 'episodes', 'end_date'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: [...BASE_REQUIRED, 'when_text', 'recurrence', 'participation'],
  additionalProperties: false,
});

const NOTICE_INSTRUCTIONS = `너는 K-pop 그룹 NCT DREAM의 위버스 공지에서 팬이 챙겨야 할 일정을 뽑는다.

규칙:
- 공지에 실제로 적힌 일정만 뽑는다. 추측하거나 지어내지 않는다.
- 날짜·시간이 적힌 줄은 각각 따로 하나의 일정이다. 여러 줄을 하나로 합치지 않는다.
  예) "■ 녹화 시간 : 2026. 11. 13 (금) 11:40AM", "당첨 번호 1 ~ 150번 : 2026. 11. 13 (금) 09:00AM", "■ 신청 기간 : … 7:00 PM 부터 ~ 7:10 PM 까지",
      "11월 12일 (목) 11AM 이후 … 당첨 여부 … 확인" → 일정 4개 (녹화, 본인 확인 1~150번, 참여 신청, 당첨 확인)
- 연도가 없으면 공지 작성일 기준으로 가장 가까운 날짜로 정한다. 모든 시간은 24시간 HH:MM. AM/PM, 오전/오후를 반드시 변환한다.
- "8~9월", "October~November"처럼 '일'이 없는 날짜는 일정으로 만들지 않는다.
- 시간대가 KST가 아닌 해외 공연 시간(예: 7PM (PHT))은 시간은 그대로 두고 timezone에 약어를 적는다. 한국 시간이면 null.
- "부터 ~ 까지" 기간은 시작을 date/time, 끝을 end_date/end_time에 넣는다. 끝 시간의 초(59초)는 버린다.
- target: 무엇의 일정인지 짧게. 공지 제목에서 가져온다 (예: "KBS 뮤직뱅크 사전녹화", "Lele's Show 2", "2027 시즌그리팅").
- step: 그 일정 안의 단계 (예: "참여 신청", "당첨 확인", "본인 확인 1~150번", "녹화", "팬클럽 선예매", "일반예매", "공연").
- kind 뜻: 신청(참여 신청·응모·사전 인증), 당첨 발표(당첨 여부 확인), 본인 확인(현장 본인 확인 시간), 녹화(사전녹화),
  방송(방송 출연·생방송), 발매(음원·앨범·영상 공개), 투표(사전투표 시작·마감), 판매(예매·티켓·상품 판매, 선예매·일반예매 포함),
  행사(공연·팬미팅·팝업·쇼케이스 당일), 모임(현장 재모임), 기타.
- members: 공지 제목에 멤버 이름(영문 CHENLE·HAECHAN·RENJUN·JENO·JAEMIN·JISUNG 포함)이 있으면 그 멤버(${MEMBER_NAMES.join(', ')} 중), NCT JNJM이면 제노·재민, 그룹 전체면 빈 배열. 마크는 넣지 않는다.
- evidence: 날짜·시간이 적힌 원문 한 줄을 글자 그대로 복사한다. 줄을 합치거나, 기호를 더하거나, 고쳐 쓰지 않는다.
- 일정이 아닌 숫자는 무시한다: 생년월일 조건(예: 2011.11.11 이전 출생), 앱 버전, 인원수, 신청 화면 예시 속 날짜.
- 공지 제목의 "261113 (금)" 같은 날짜는 방송·행사 당일이다. 그날의 녹화·공연 시간이 본문에 따로 있으면 그것으로 충분하고, 없을 때만 time null로 하나 넣는다.`;

const ARTICLE_INSTRUCTIONS = `너는 K-pop 그룹 NCT DREAM(멤버: ${MEMBER_NAMES.join(', ')})에 관한 기사·글에서 팬이 챙겨야 할 일정을 뽑는다.

규칙:
- 글에 실제로 적힌 일정만 뽑는다. 추측하지 않는다.
- NCT DREAM 또는 멤버가 직접 나오거나 하는 일정만: 방송·예능·드라마·유튜브 출연, 영상·음원 공개, 공연·시상식·페스티벌 출연, 팬미팅, 라이브 등.
  다른 가수만의 일정은 뺀다.
- 일정마다 participation에 "NCT DREAM(또는 멤버)이 이 일정에 나온다/한다"를 보여 주는 원문 문장을 글자 그대로 넣는다.
  그 문장에는 그룹 이름이나 멤버 이름이 있어야 한다. 그런 문장이 없으면 participation은 null이다.
- 여러 날 열리는 행사(시상식·페스티벌)는 NCT DREAM이 나오는 날만 일정으로 만든다. 출연 날이 안 적혀 있으면 날짜를 정하지 말고 when_text에 적는다.
- 주최 측 부대 이벤트(채팅 이벤트·경품·추첨·본방사수 이벤트), 생중계 채널 안내, 행사 전체 일정 소개는 따로 일정으로 만들지 않는다.
  레드카펫·본식 시작 시간은 NCT DREAM이 나오는 날의 일정에만 쓴다.
- "관련 대상"이 주어진 글이면 그 대상의 티켓 예매·투표 일정과 방송 시간도 뽑는다. 이때 그룹이 안 나오는 글이면 participation은 null로 둔다.
- 이미 지난 일을 다시 언급한 것(예: "지난 9일 컴백한")은 뽑지 않는다.
- 날짜: "오늘", "내일", "12일", "내달 16일" 같은 표현은 글 작성일 기준으로 YYYY-MM-DD로 바꾼다.
  날짜(일)가 아직 없는 확정 소식(예: "2027 코첼라 출연 확정")은 date를 null로 하고 when_text에 시기 표현을 적는다.
- 시간: 24시간 HH:MM ("밤 10시 20분" → 22:20). 없으면 null.
- 매주 방송되는 드라마·예능에 멤버가 고정 출연하면, 첫 방송(또는 이번 회) 일정 하나만 넣고 recurrence에 방송 요일(예: 월화드라마 → ["월","화"]),
  회차 수(N부작), 종영일을 적는다. 모르는 값은 null. 반복이 아니면 recurrence는 null.
- 결방(방송 쉬는 날)이나 방송 시간 변경 소식도 그 날짜의 일정으로 뽑는다. step에 "결방" 또는 "방송 시간 변경"을 쓴다.
- target: 프로그램·작품·행사 이름. 방송사·채널이 있으면 앞에 붙인다 (예: "SBS 꼬꼬무", "ENA 크래시2", "유튜브 가짜 김효연", "MMA 2026").
- step: 무엇을 하는지 (예: "제노 출연", "재민 출연 회 공개", "첫 방송", "OST 'Smash It' 발매", "1차 티켓 예매").
  영상·음원 공개면 기사에 나온 영상·곡 제목을 따옴표로 넣는다 (예: "첫 번째 트레일러 'WE’RE DREAM AFTER SERVICE!' 공개").
- kind: 방송(TV·웹예능·드라마·유튜브 출연분 방영), 발매(음원·영상 공개), 행사(공연·시상식·팬미팅·페스티벌), 판매(예매·티켓), 투표, 기타.
- members: 관련 멤버. 그룹 전체면 빈 배열. 마크는 넣지 않는다.
- evidence: 날짜(와 시간)가 적힌 원문 문장을 글자 그대로 복사한다.
- 이미 지난 일을 다시 언급한 것은 뽑지 않는다.`;

export interface LlmResult<T> {
  value: T;
  usage: { input: number; output: number; costUsd: number };
}

async function callJson<T>(instructions: string, input: string, schemaName: string, schema: object, fallbackModel?: string): Promise<LlmResult<T>> {
  const res = await callAi(process.env, { instructions, input, schema: { name: schemaName, schema }, effort: LLM_EFFORT, maxOutputTokens: 16000, fallbackModel: fallbackModel ?? process.env.LLM_FALLBACK_MODEL ?? 'gpt-5-mini' });
  return { value: JSON.parse(res.value) as T, usage: res.usage };
}

const kstStamp = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

export async function extractNoticeEvents(notice: { title: string; postedAt: string; body: string }): Promise<LlmResult<LlmEvent[]>> {
  const input = `공지 작성일: ${notice.postedAt.slice(0, 16).replace('T', ' ')} (KST)\n공지 제목: ${notice.title}\n\n공지 본문:\n${notice.body}`;
  const r = await callJson<{ events: LlmEvent[] }>(NOTICE_INSTRUCTIONS, input, 'notice_events', NOTICE_SCHEMA);
  return { value: r.value.events, usage: r.usage };
}

/** 팬이 직접 제보한 글에만 붙는 안내 (기사 처리에는 영향 없음) */
const SUBMISSION_NOTE = `
- 이 글은 팬이 NCT DREAM 관련이라고 제보한 글이다. 게스트가 공개되지 않은 예고(예: "다음 게스트❓ 11/13(금) 6:30PM")라도
  날짜·시간이 있으면 일정으로 뽑고 step을 "게스트 예고 (미공개)"로 적는다. kind는 방송.
- "제보 메모"에 멤버 추측이 있으면 members에 넣지 말고 step 끝에 "(추측: 지성)"처럼 붙인다.`;

/**
 * @param focus 빈칸 채우기 검색으로 찾은 글이면 무엇을 찾던 중인지 (예: "MMA 2026"). 그 대상의 일정도 함께 뽑는다.
 * @param submission 팬 제보 글이면 { note: 제보 메모 }
 */
/** 기사·제보 글 일정 뽑기 요청 (바로 부를 때와 Batch에 똑같이) */
export function articleRequest(article: { title: string; publishedAt: string; body: string }, focus?: string, submission?: { note?: string }) {
  const input =
    `글 작성일: ${kstStamp(article.publishedAt)} (KST)\n` +
    (focus ? `관련 대상: ${focus}\n` : '') +
    (submission?.note ? `제보 메모: ${submission.note}\n` : '') +
    `글 제목: ${article.title}\n\n글 본문:\n${article.body.slice(0, 6000)}`;
  return { instructions: ARTICLE_INSTRUCTIONS + (submission ? SUBMISSION_NOTE : ''), input, schema: { name: 'article_events', schema: ARTICLE_SCHEMA }, effort: LLM_EFFORT, maxOutputTokens: 16000 };
}
export const parseArticleEvents = (value: string) => (JSON.parse(value) as { events: LlmEvent[] }).events;

export async function extractArticleEvents(
  article: { title: string; publishedAt: string; body: string },
  focus?: string,
  submission?: { note?: string; fallbackModel?: string },
): Promise<LlmResult<LlmEvent[]>> {
  const req = articleRequest(article, focus, submission);
  const r = await callJson<{ events: LlmEvent[] }>(req.instructions, req.input, req.schema.name, req.schema.schema, submission?.fallbackModel);
  return { value: r.value.events, usage: r.usage };
}

const VIDEO_INSTRUCTIONS = `너는 유튜브 영상 정보(제목·설명·공개 시각)를 보고 K-pop 그룹 ${GROUP.name}(멤버: ${MEMBER_NAMES.join(', ')})의 일정을 뽑는다.

- 영상 자체가 출연 콘텐츠(예능·웹예능·라디오·인터뷰·챌린지 등)면 일정 1개: 영상 공개.
  date/time = 영상 공개 시각, target = 채널·프로그램 이름 (예: "유튜브 집대성 빈집대성", "유튜브 효연의 레벨업 가짜 김효연"),
  step = "{멤버} 출연분 공개" (회차가 있으면 함께, 예: "ep.8 NCT DREAM 출연분 공개"), kind = 발매.
- 음원·OST·뮤직비디오 공개 영상이면 target = 작품·앨범 이름 (예: "ENA 크래시2 OST Part.1"), step = "'{곡명}' 공개", kind = 발매.
- 영상이 오프라인 행사를 찍은 취재 영상(브랜드 행사 포토월·제작발표회·쇼케이스·시상식 레드카펫·공항 등)이면 일정은 그 행사다.
  target = 행사 이름 (브랜드·작품·행사명, 예: "BARRIE '데미안 허스트' 캡슐 컬렉션 행사", "ENA 크래시2 제작발표회"),
  step = "{멤버} 참석" (포토월이면 "{멤버} 포토월 참석"), kind = 행사.
  date는 제목·설명에 행사 날짜가 적혀 있으면 그 날짜. 날짜가 없으면 행사 현장을 직접 찍은 영상(포토월·현장·풀영상)일 때만 영상 공개 날짜를 쓴다.
  time은 설명에 행사 시간이 있을 때만.
- 행사를 앞두고 나온 뉴스 보도(출연 예정·라인업 소개·기대 등)는 일정을 만들지 않는다. 영상 공개 날짜는 행사 날짜가 아니다.
- 티저·예고 영상이면 본편 공개 일정을 만든다: date/time = 제목·설명에 적힌 공개 시각, target = 프로그램 이름, step = "{멤버} 출연분 공개". 공개 시각이 안 적혀 있으면 만들지 않는다.
- 개인·팬 채널이 올린 직찍·쇼츠·매장 방문 영상은 출연이 아니다.
- 예능·웹예능 채널의 회차 영상에 그룹·멤버 이름이나 해시태그(#NCTDREAM, #제노 등)가 붙어 있으면 그 멤버가 나오는 출연 콘텐츠로 본다.
  해시태그에 멤버 전원이 있으면 members는 빈 배열(단체).
- 제목·설명에 원래 방송 날짜(예: "190731 방송")가 있으면 지난 방송을 다시 올린 하이라이트다. 원래 방송이 영상 공개일보다 일주일 넘게 앞서면 일정을 만들지 않고,
  최근 방송이면 원래 방송 날짜를 date로 쓴다.
- 리액션·편집·가사·플레이리스트·팬 자막(번역) 업로드·뮤직비디오 재업로드·기사를 읽어 주는 소식 요약(쇼츠 포함)처럼 출연도 행사도 아니면 일정을 만들지 않는다.
- ${GROUP.name} 또는 멤버 이름이 제목이나 설명에 직접 나와야 한다. 팬덤 이름(시즈니 등)이나 같은 상위 그룹의 다른 팀만 나오면 뺀다.
- 설명에 "다음 회 예고", "다음 주 게스트"로만 나오는 사람은 이 영상의 출연이 아니다.
- members: 영상에 나오는 멤버. 그룹 전체면 빈 배열.
- evidence: 날짜·시간 근거가 된 원문 줄을 글자 그대로. 영상 공개 시각을 썼으면 "영상 공개 시각: …" 줄을 그대로 복사한다.
- participation: 제목·설명에서 그룹·멤버가 이 영상(또는 행사)에 나온다는 부분을 글자 그대로 (예: "(feat. NCT DREAM 재민)", "#NCTDREAM #지성"). 없으면 null.
- when_text, recurrence는 null.`;

/** 영상 해석용 원문: 제목·설명·공개 시각 (검증할 때도 같은 글을 쓴다) */
export function videoSourceText(v: { title: string; description?: string; channel: string; publishedAt: string; upcoming?: boolean }): string {
  return `채널: ${v.channel}\n제목: ${v.title}\n영상 공개 시각: ${kstStamp(v.publishedAt)} (KST)${v.upcoming ? ' (공개 예정)' : ''}\n\n설명:\n${(v.description ?? '').slice(0, 3000)}`;
}

export async function extractVideoEvents(v: { title: string; description?: string; channel: string; publishedAt: string }): Promise<LlmResult<LlmEvent[]>> {
  const r = await callJson<{ events: LlmEvent[] }>(VIDEO_INSTRUCTIONS, videoSourceText(v), 'video_events', ARTICLE_SCHEMA);
  return { value: r.value.events, usage: r.usage };
}

/**
 * 공지 본문 이미지(위에서부터 자른 조각들)의 글을 그대로 옮겨 적는다.
 * 옮겨 적은 글은 공지 본문 뒤에 붙여 공지 해석에 쓰고, 근거 문장 대조도 이 글을 기준으로 한다.
 */
export async function transcribeImages(tiles: string[], noticeTitle: string): Promise<LlmResult<string>> {
  const input = `위버스 공지 "${noticeTitle}"의 본문 이미지를 위에서부터 순서대로 자른 조각 ${tiles.length}장이다.\n이미지 속 글을 빠짐없이 그대로 옮겨 적어라. 요약·설명·번역하지 말 것.\n조각 경계에서 같은 줄이 두 번 보이면 한 번만 적는다. 표는 한 줄에 "항목: 내용"으로 적는다.\n날짜·시간·장소·대상 같은 숫자와 이름은 보이는 그대로 적는다. 글이 없는 사진이면 "(글 없음)"이라고만 적는다.`;
  const res = await callAi(process.env, { instructions: '이미지의 글을 정확히 전사한다.', input, images: tiles.map((b) => `data:image/jpeg;base64,${b}`), effort: 'low', maxOutputTokens: 12000, fallbackModel: process.env.LLM_FALLBACK_MODEL ?? 'gpt-5-mini' });
  return { value: res.value.trim(), usage: res.usage };
}

// ── 검증 ────────────────────────────────────────────────────────

export interface CheckedEvent extends LlmEvent {
  /** 근거가 원문에 있고, 날짜·시간 숫자가 근거에 있음 */
  verified: boolean;
  problems: string[];
  /** 그룹·멤버가 이 일정에 직접 나온다는 문장이 원문에 있음 (기사·영상) */
  participates?: boolean;
}

const UNIT_ALIASES = GROUP.units.flatMap((u) => [u.name, ...u.aliases]);
export const mentionsGroup = (t: string) => GROUP_NAME_RE.test(t) || mentionedMembers(t).members.length > 0 || UNIT_ALIASES.some((a) => t.includes(a));

/** 참여 문장이 원문에 있고 그룹·멤버 이름이 들어 있는지 (문장 조각 단위로 확인) */
function participationInSource(text: string | null | undefined, src: string): boolean {
  if (!text) return false;
  const pieces = [text, ...text.split(/\\n|\n|(?<=[.!?。])\s+|\s\|\s|,\s*/)];
  return pieces.some((p) => squash(p).length >= 4 && src.includes(squash(p)) && mentionsGroup(p));
}

/** 비교용 정리: 공백·따옴표·괄호·이모지·"\\n" 글자 등 표기 차이를 없앤다 */
const squash = (s: string) =>
  s
    .replace(/\\n/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[\s‘’'"“”\[\]()<>【】|:：·•■□●○▶▷※❗️]/g, '');

/** 근거가 원문에 있는지: 통째로 있거나, 날짜가 든 조각(줄·콜론으로 나눈 것)이 원문에 있으면 인정 */
function evidenceInSource(evidence: string, src: string): boolean {
  if (src.includes(squash(evidence))) return true;
  const pieces = evidence.split(/\\n|\n|\s\|\s|(?<=[^\d]):(?=\s)/).map(squash).filter((p) => p.length >= 8 && /\d/.test(p));
  return pieces.length > 0 && pieces.some((p) => src.includes(p));
}

/**
 * AI 결과를 원문과 대조한다. 근거가 원문에 없으면 버리고, 숫자가 안 맞으면 "확인 필요"로 남긴다.
 * @param publishedAt 기사 작성 시각. 주면 기사 날짜보다 이틀 이상 전 일정(지난 일 언급)을 버린다.
 */
export function checkAgainstSource(
  events: LlmEvent[],
  source: string,
  publishedAt?: string,
): { kept: CheckedEvent[]; dropped: { event: LlmEvent; reason: string }[] } {
  const src = squash(source);
  const kept: CheckedEvent[] = [];
  const dropped: { event: LlmEvent; reason: string }[] = [];
  let pastLimit: string | undefined;
  if (publishedAt) {
    const p = toKstParts(new Date(new Date(publishedAt).getTime() - 2 * 24 * 3600 * 1000));
    pastLimit = kstDate(p.year, p.month, p.day);
  }

  for (const e of events) {
    if (!e.evidence || !evidenceInSource(e.evidence, src)) {
      dropped.push({ event: e, reason: '근거 문장이 원문에 없음' });
      continue;
    }
    e.members = e.members.filter((m) => MEMBER_NAMES.includes(m));
    const writtenYear = publishedAt ? Number(toKstParts(new Date(publishedAt)).year) : null;
    const years = [...`${e.target} ${e.step} ${e.when_text ?? ''}`.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((m) => Number(m[1]));
    if (writtenYear && years.length && Math.max(...years) < writtenYear) {
      dropped.push({ event: e, reason: `지난 해 일정 (${Math.max(...years)}년)` });
      continue;
    }
    if (e.date === null) {
      // 날짜 미정 소식: 시기 표현이 있어야 의미가 있다
      if (!e.when_text) dropped.push({ event: e, reason: '날짜도 시기 표현도 없음' });
      else kept.push({ ...e, verified: true, problems: [], participates: participationInSource(e.participation, src) });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
      dropped.push({ event: e, reason: `날짜 형식 오류 ${e.date}` });
      continue;
    }
    if (pastLimit && e.date < pastLimit) {
      dropped.push({ event: e, reason: '지난 일 언급' });
      continue;
    }
    const problems: string[] = [];
    const ev = e.evidence;
    const day = Number(e.date.slice(8, 10));
    const yymmdd = e.date.slice(2).replace(/-/g, '');
    if (!new RegExp(`(?<!\\d)0?${day}(?!\\d)`).test(ev) && !ev.includes(yymmdd) && !/오늘|내일|모레|첫날|DAY/i.test(ev)) {
      problems.push(`근거에 ${day}일이 없음`);
    }
    if (e.time) {
      const h = Number(e.time.slice(0, 2));
      const h12 = h % 12 === 0 ? 12 : h % 12;
      if (!new RegExp(`(?<!\\d)0?(${h}|${h12})(?!\\d)`).test(ev)) problems.push(`근거에 ${h}시가 없음`);
    }
    kept.push({ ...e, verified: problems.length === 0, problems, participates: participationInSource(e.participation, src) });
  }
  return { kept, dropped };
}

/** 질문 에이전트 등에서 쓰는 범용 호출: 모델·노력 수준을 골라 JSON 또는 글로 받는다 */
const dropLone = (t: string) => t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
export async function callModel(opts: { model?: string; effort?: 'minimal' | 'low' | 'medium' | 'high'; instructions: string; input: string; schema?: { name: string; schema: object } }): Promise<LlmResult<string>> {
  const primaryModel = opts.model === 'gpt-5-nano'
    ? (process.env.GROQ_SMALL_MODEL ?? 'openai/gpt-oss-20b')
    : opts.model === 'gpt-5.4-nano'
      ? (process.env.GROQ_RERANK_MODEL ?? 'openai/gpt-oss-120b')
      : undefined;
  // Groq 모델로 바꿔 부르는 단계(질문 해석·리랭킹·요약)만 Groq, gpt- 모델을 직접 고른 호출(물어보기 답변)은 OpenAI로 바로
  const env = primaryModel || !opts.model?.startsWith('gpt-') ? process.env : { ...process.env, GROQ_API_KEY: undefined };
  const res = await callAi(env, { instructions: dropLone(opts.instructions), input: dropLone(opts.input), schema: opts.schema, effort: opts.effort, maxOutputTokens: 8000, primaryModel, fallbackModel: opts.model?.startsWith('gpt-') ? opts.model : (process.env.LLM_FALLBACK_MODEL ?? 'gpt-5-mini') });
  return { value: res.value, usage: res.usage };
}
