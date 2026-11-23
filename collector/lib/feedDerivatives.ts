/**
 * 일정 파생 기사: 일정에 이미 있는 콘텐츠(예능·유튜브·드라마·행사)를 보고 쓴 기사는 소식 탭에서 뺀다.
 * 소식 탭은 "일정엔 못 넣는 소식" 자리라, 일정에 원본이 있으면 겹친다.
 *  - 같은 멤버(그룹 일정이면 누구든)가 나오고, 일정 날짜 −2일 ~ +5일 사이에 나온 기사
 *  - 일정 제목의 특징 낱말(프로그램·콘텐츠 이름, 게스트 이름)이 기사 제목에 있을 때
 *  - 차트·화보·광고·공항 소식은 일정과 겹쳐도 남긴다
 */
import { GROUP } from './group.ts';
import type { FeedItem } from './publish.ts';

interface EventLike { date: string; title: string; members: string[] }

// 일정 제목에 흔히 들어가는 낱말 (이것만 겹쳐서는 같은 콘텐츠라고 볼 수 없음)
const STOP = new Set(`유튜브 공개 출연 방송 발매 촬영 무대 콘서트 공연 팬미팅 팬사인회 사인회 녹화 사전녹화 사녹 라이브 생방송 예능 드라마 영상 뮤직비디오
티저 앨범 컴백 쇼케이스 시상식 인터뷰 화보 광고 출국 입국 공항 응모 예매 투표 신청 당첨 발표 판매 오픈 종료 시작 마감 개최 진행 참석 게스트 스페셜
시즌 에피소드 그룹 멤버 생일 기념일 데뷔 공식 채널 출연분 본방 재방 회차 첫방 정규 미니 싱글 신곡 음원 라디오 프로그램 특집 단체 개인 함께 고정
아이돌 투어 이벤트 특전 증정 예약 음반 오프라인 온라인 팝업 스토어 축제 주년 월드 글로벌 코리아 서울 vs the and in to of on with plus ost
앵콜 앙코르 피날레 kbs kbs2 mbc sbs jtbc tvn mnet ena ebs 넷플릭스 디즈니 티빙 웨이브 쿠팡플레이 md 제작발표회 기자간담회 시사회 현장 비하인드`.split(/\s+/).filter(Boolean));
// 그룹·멤버 이름은 낱말로도 ("NCT DREAM" → "nct", "dream")
const GROUP_WORDS = [...GROUP.nameVariants, ...GROUP.parentNames, ...GROUP.members.flatMap((m) => [m.name, ...m.aliases])]
  .flatMap((w) => [w, ...w.split(/\s+/)]).map((w) => w.toLowerCase()).filter(Boolean);

/** 일정 제목의 특징 낱말 (영문·숫자가 붙은 낱말은 한글 부분도 따로: "LEE리정" → "리정") */
export function eventKeywords(title: string): string[] {
  const out = new Set<string>();
  for (const w of title.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const x of new Set([w, w.replace(/[A-Za-z0-9]+/g, ''), w.replace(/[가-힣]+/g, '')])) {
      const k = x.toLowerCase();
      if (k.length < 2 || /^\d+$/.test(k) || /^[a-z]{1,2}$/.test(k)) continue;
      if (/^\d+(집|주년|차전|회|기|화|부)$/.test(k)) continue;
      if (STOP.has(k) || GROUP_WORDS.some((g) => g === k || (k.length <= 3 && g.includes(k)))) continue;
      out.add(k);
    }
  }
  return [...out];
}

const DAY = 864e5;
/** 소식 중 일정 파생 기사 찾기 (뺄 것) */
export function eventDerivatives(feed: FeedItem[], events: EventLike[]): Set<FeedItem> {
  const prepared = events.map((e) => ({ t: Date.parse(`${e.date}T00:00:00+09:00`), members: e.members, keys: eventKeywords(e.title) })).filter((e) => e.keys.length);
  const out = new Set<FeedItem>();
  for (const f of feed) {
    if (f.type !== 'news' || f.topic || !f.members.length) continue;
    const at = Date.parse(f.publishedAt);
    const title = f.title.toLowerCase();
    if (prepared.some((e) => {
      const d = (at - e.t) / DAY;
      if (d < -2 || d > 6) return false; // 일정 날짜(0시) 기준 −2일 ~ +5일 끝까지
      if (e.members.length && !e.members.some((m) => f.members.includes(m))) return false;
      return e.keys.some((k) => title.includes(k));
    })) out.add(f);
  }
  return out;
}
