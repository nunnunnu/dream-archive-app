/**
 * 팬 글에서 화제 키워드 뽑기 (규칙, 무료)
 * 위버스 highlight 팬 글에서 단어를 뽑아 "NCT DREAM {키워드}" 기사 검색어로 쓴다.
 * 팬 글 본문·닉네임은 저장하지 않는다.
 */
import { GROUP, GROUP_NAME_RE, PARENT_RE } from './group.ts';

/** 제목에 그룹·멤버 이름이 있어야 관련 기사로 본다 ("서인영 … 복근" 같은 기사 제외) */
const MEMBER_ALIAS_RE = new RegExp(GROUP.members.flatMap((m) => m.aliases).join('|'), 'i');
export const isNctRelated = (title: string) => GROUP_NAME_RE.test(title) || PARENT_RE.test(title) || MEMBER_ALIAS_RE.test(title);

/** 그룹·멤버·팬덤 이름과 흔한 말. 이런 단어로는 화제를 알 수 없다. */
const STOPWORDS = new Set(
  [
    // 그룹·멤버·팬덤 (config/group.json)
    ...GROUP.nameVariants.flatMap((n) => [n, n.replace(/\s+/g, '')]),
    ...GROUP.parentNames, ...GROUP.fandom, ...GROUP.nicknames,
    ...GROUP.members.flatMap((m) => [...m.aliases, ...(m.nicknames ?? [])]),
    ...GROUP.formerMembers.flatMap((f) => f.aliases),
    '드림', 'dream', '미들', '미들아이',
    // 흔한 말
    '진짜', '정말', '너무', '완전', '그냥', '대박', '혹시', '드디어', '오늘', '내일', '어제', '지금', '이제', '우리', '여러분',
    '이거', '저거', '그거', '근데', '그래서', '그리고', '하지만', '모두', '다들', '항상', '계속', '빨리', '얼른', '많이', '조금',
    '사랑해', '사랑', '화이팅', '홧팅', '축하해', '축하', '생일', '고마워', '감사', '보고싶어', '귀여워', '귀엽다', '멋있어', '최고',
    '으엥', '헐', '와', '우와', '아니', '어떡해', '미쳤다', '미쳤어', '레전드', '굿나잇', '수고',
    '오빠', '언니', '누나', '형', '즈니분', '아침', '점심', '저녁', '새벽',
    // 흔한 영어 (앨범명 'DREAM AFTER DREAM'의 After 같은 단어가 화제로 잡히지 않게)
    'this', 'that', 'with', 'from', 'have', 'today', 'love', 'happy', 'birthday', 'album', 'song', 'track', 'the', 'and',
    'after', 'before', 'about', 'again', 'also', 'back', 'best', 'come', 'comes', 'dear', 'every', 'first', 'good', 'here',
    'just', 'last', 'like', 'made', 'make', 'more', 'much', 'next', 'only', 'other', 'over', 'some', 'still', 'such', 'than',
    'them', 'then', 'there', 'these', 'they', 'time', 'very', 'want', 'well', 'were', 'what', 'when', 'where', 'which',
    'while', 'will', 'would', 'your', 'ours', 'their', 'thank', 'thanks', 'tonight', 'tomorrow', 'morning', 'night',
    'members', 'member', 'fans', 'promotional', 'title', 'songs',
  ].map((w) => w.toLowerCase()),
);

/** 조사·어미 떼기: "코첼라가" → "코첼라", "드림이들" → "드림" */
const KOREAN_SUFFIX_RE = /(이에요|예요|이야|이랑|에서|에게|한테|까지|부터|으로|들은|들이|들|은|는|이|가|을|를|에|도|의|로|랑|와|과|만|요|야|아|임|ㅋ+|ㅎ+|ㅠ+|ㅜ+)+$/;
/** "출연했네" → "출연": 명사 + 하다/되다 꼴은 명사만 남긴다 */
const HADA_RE = /(했었|했네|했다|했어|했음|했대|했고|했는데|한다|한대|하는|하네|하고|하면|하자|해요|해서|해도|된다|됐다|됐네|되는|함|됨)$/;
/** 동사·형용사로 끝나는 말은 키워드로 쓰지 않는다. "자"는 전과자·당첨자 같은 명사가 많아서 넣지 않는다. */
const VERB_ENDING_RE = /(다|요|죠|네|까|지|고|서|면|데|게|음|함|됨|해|했|하|니|는데|어|었|았|겠)$/;

export function extractKeywords(text: string): string[] {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#_]/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    let word = raw;
    if (/[가-힣]/.test(word)) {
      if (!/^[가-힣]+$/.test(word)) continue;
      word = word.replace(KOREAN_SUFFIX_RE, '');
      const stem = word.replace(HADA_RE, '');
      if (stem !== word && stem.length >= 2) word = stem;
      else if (VERB_ENDING_RE.test(word)) continue;
      if (word.length < 2) continue;
    } else if (/^[A-Za-z]+$/.test(word)) {
      // 영어는 고유명사로 보이는 대문자 시작 단어만 (Coachella, Tokyo …)
      if (word.length < 4 || !/^[A-Z]/.test(word)) continue;
    } else {
      continue;
    }
    if (STOPWORDS.has(word.toLowerCase()) || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}
