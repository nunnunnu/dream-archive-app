/**
 * 팬 질문 에이전트 핵심 (Node·Cloudflare 함수 공용, 파일·네트워크를 직접 쓰지 않는다)
 * ① 질문 해석 (AI, JSON): 기간·프로그램·멤버·찾을 낱말
 * ② 검색: 일정은 날짜·프로그램·멤버·낱말로, 원문(공지 본문·이미지 속 글·기사 본문)은 낱말 점수로 문단을 고른다
 * ③ 답변 (AI): 찾은 자료만 근거로, 자료 번호를 달고, 없으면 없다고 말한다
 * ④ 검사: 답에 나온 날짜·시간이 자료에 있는지 확인해서 없으면 경고
 */
import type { PublicEvent } from './consolidate.ts';

export interface AskDoc { kind: 'notice' | 'article' | 'video'; title: string; date: string; time?: string; url: string; text: string }
export interface AskData {
  groupName: string;
  members: string[];
  /** 볼 수 있는 곳: 일정 제목에 들어가는 이름 → 시청처 */
  watch?: Record<string, { label: string; url?: string; note?: string }[]>;
  /** 답변 규칙 (config/ask-rules.json → 질문 자료와 함께 KV로, 배포 없이 바꿀 수 있게) */
  rules?: { answer: string[] };
  /** 시리즈·종류별 모아보기 (조회 도구: "지성 커버 전부", "JUST DO IT 회차 전부") */
  series?: { name: string; type: string; seasons: { name: string; videos: { title: string; date: string; url: string; members: string[]; ep: number | null }[] }[] }[];
  /** 멤버 다른 표기 (런쥔 → RENJUN, 황런쥔): 영어 제목 영상도 찾게 */
  memberAliases?: Record<string, string[]>;
  /** 다른 그룹 활동이 있는 멤버 (그 일정은 자료에 없을 수 있음) */
  otherGroups?: Record<string, string[]>;
  programs: { names: string[]; short?: string; weekday?: string; time?: string }[];
  synonyms: Record<string, string[]>;
  events: PublicEvent[];
  docs: AskDoc[];
}
export type AskCall = (opts: { model: string; effort: 'low'; instructions: string; input: string; schema?: { name: string; schema: object } }) => Promise<{ value: string; usage: { costUsd: number } }>;

export interface AskResult {
  answer: string;
  query: { from: string | null; to: string | null; programs: string[]; members: string[]; keywords: string[] };
  /** 같은 주소는 하나로 합치고, 그 출처를 가리키는 번호들(ids)을 함께 둔다 */
  sources: { id: string; ids: string[]; title: string; url: string; kind?: 'notice' | 'article' | 'video' | 'event' | 'list' | 'submission'; date?: string }[];
  unverified: string[];
  /** 답이 근거로 단 일정 (화면의 핵심 정보 표·확인 대기 경고·캘린더 추가용) */
  events?: { id: string; date: string; time: string | null; endDate: string | null; endTime: string | null; title: string; step: string; kind: string; status: string; fromSubmission: boolean; url: string; flowId?: string }[];
  /** 근거를 하나도 못 단 답 (화면에서 "찾지 못했어요"로, 재사용 저장 안 함) */
  notFound?: boolean;
  stats: { events: number; docs: number; chunks: number; costUsd: number; model: string; vectorHits?: number };
  /** 검색 정확도 재기용: 리랭킹 전 후보·최종 자료 주소, 일정 출처 주소 */
  retrieval?: { candidates: string[]; final: string[]; events: string[] };
}

/** 의미 검색: text-embedding-3-small 로 질문을 임베딩하고 Supabase match_rag_chunks 로 찾는다 */
export const supabaseVector = (env: { OPENAI_API_KEY?: string; SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string }): VectorSearch | undefined => {
  if (!env.OPENAI_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return undefined;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const sb = { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) };
  return async (text, { count }) => {
    const e = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: dropLoneSurrogates(text.slice(0, 2000)) }) });
    if (!e.ok) throw new Error(`임베딩 실패 ${e.status}`);
    const emb = (await e.json()) as { data: { embedding: number[] }[]; usage: { total_tokens: number } };
    const r = await fetch(`${env.SUPABASE_URL!.replace(/\/$/, '')}/rest/v1/rpc/match_rag_chunks`, { method: 'POST', headers: { ...sb, 'content-type': 'application/json' }, body: JSON.stringify({ query_embedding: `[${emb.data[0].embedding.join(',')}]`, match_count: count, doc_types: ['notice', 'article', 'video'] }) });
    if (!r.ok) throw new Error(`의미 검색 실패 ${r.status}`);
    return { hits: (await r.json()) as never, costUsd: (emb.usage.total_tokens / 1e6) * 0.02 };
  };
};

const kst = (d: Date) => new Date(d.getTime() + 9 * 3600 * 1000);

/** 공식 자료로 답할 수 없는 질문은 AI를 거치지 않고 정해진 답을 준다 (지시문만으로는 매번 지켜지지 않음) */
const GUARDS: { re: RegExp; answer: string }[] = [
  { re: /팬싸\s*컷|사인회\s*(컷|커트라인)|당첨\s*(컷|커트라인)|몇\s*장\s*(사야|이면)\s*(당첨|붙)/, answer: '팬싸컷(당첨 커트라인)은 공식으로 공개되지 않아서 답할 수 없어요. 응모 기간·방법은 팬사인회 공지를 확인해 주세요.' },
];
const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

export interface AskTurn { q: string; a: string }
/** 의미 검색(pgvector) 결과 한 조각 */
export interface VectorHit { doc_type: string; doc_url: string; title: string; published_at: string | null; content: string; similarity: number }
/** 의미 검색: 질문(+찾을 낱말)을 임베딩해 rag_chunks 에서 가까운 조각을 찾는다. 없으면 낱말 검색만 */
export type VectorSearch = (text: string, opts: { count: number }) => Promise<{ hits: VectorHit[]; costUsd: number }>;
/** 글자 수로 자르다 이모지 한가운데가 잘리면 짝 없는 문자가 생겨 요청 JSON이 깨진다 → 모델·임베딩에 보내기 직전에 뺀다 */
export const dropLoneSurrogates = (t: string) => t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
export async function askCore(question: string, data: AskData, rawCall: AskCall, opts: { today?: string; model?: string; onCost?: (usd: number) => void; log?: (s: string) => void; history?: AskTurn[]; vector?: VectorSearch; rerank?: boolean } = {}): Promise<AskResult> {
  const call: AskCall = (o) => rawCall({ ...o, instructions: dropLoneSurrogates(o.instructions), input: dropLoneSurrogates(o.input) });
  // 앞 대화(최근 2개): "유투브에서봐?"처럼 이어지는 질문을 이해하게
  const history = (opts.history ?? []).slice(-2).map((t) => ({ q: t.q.slice(0, 200), a: t.a.replace(/\[[EDL]\d+\]/g, '').slice(0, 500) }));
  const historyText = history.length ? `이전 대화:\n${history.map((t) => `Q: ${t.q}\nA: ${t.a}`).join('\n')}\n\n` : '';
  const model = opts.model ?? 'gpt-5-mini';
  const guard = GUARDS.find((g) => g.re.test(question));
  if (guard) return { answer: guard.answer, query: { from: null, to: null, programs: [], members: [], keywords: [] }, sources: [], unverified: [], stats: { events: 0, docs: 0, chunks: 0, costUsd: 0, model: 'rule' } };
  const { events, programs, synonyms: SYNONYMS } = data;
  const log = opts.log ?? (() => {});
  // 평가를 같은 조건에서 다시 돌릴 수 있게 "오늘"을 고정할 수 있다
  const now = opts.today ? new Date(`${opts.today}T12:00:00+09:00`) : new Date();
  const today = kst(now).toISOString().slice(0, 10);
  const weekday = '일월화수목금토'[kst(now).getUTCDay()];

  // ① 질문 해석
  const near = (d: string) => Math.abs(Date.parse(d) - Date.parse(today)) < 120 * 864e5;
  const knownNames = [...new Set(events.filter((e) => near(e.date)).map((e) => e.title.replace(/^(유튜브|KBS2?|MBC|SBS|JTBC|ENA|tvN|Mnet( Plus)?)\s+/i, '').replace(/\s*[:(（].*$/, '').replace(/['‘’"“”]/g, '').trim()).filter((t) => t.length >= 2 && t.length <= 40))].slice(0, 150);
  const parsed = await call({
    model: 'gpt-5-nano',
    effort: 'low',
    instructions: [
      // 지시문은 매번 같게 (OpenAI 프롬프트 캐시 할인), 오늘 날짜는 입력 맨 앞에
      `너는 ${data.groupName} 팬의 질문을 검색 조건으로 바꾼다. 오늘 날짜(한국 시간)는 입력 맨 앞 "오늘:" 줄에 있다.`,
      '- 기간: "다음주"는 다음 월요일~일요일, "이번주"는 이번 월요일~일요일, "내일"·"모레"는 그 날. 기간 말이 없으면 null.',
      `- 프로그램: 줄임말을 정식 이름으로 (${programs.map((p) => `${p.short ?? p.names[0]}=${p.names[0]}`).join(', ')}).`,
      `- 멤버: ${data.members.join(', ')} 중 질문에 나온 사람. 없으면 빈 목록.`,
      `- 아는 일정 이름: ${knownNames.join(' / ')}`,
      '- 질문에 나온 작품·행사가 위 이름 중 하나를 가리키면 keywords에 그 이름을 그대로 넣는다 (한글로 물어도 영어 표기 이름으로, 예: 아이돌스 테이블 → IDOL’S TABLE).',
      '- 이전 대화가 있으면 지금 질문이 그 대화의 이어지는 질문인지 보고, 생략된 대상(작품·멤버·날짜)을 이전 대화에서 채운다 (예: "유튜브에서 봐?" → 앞에서 물은 작품).',
      `- lookup: 목록을 전부 봐야 하는 질문(○○ 커버 전부, 시리즈 회차 전부, 안무 영상 목록 등)이면 아래 목록에서 하나를 고른다. 아니면 kind=none. 시리즈·모아보기: ${(data.series ?? []).map((s) => s.name).join(' / ')}`,
      '- lookup.member: 특정 멤버 것만 물으면 그 멤버 이름(없으면 null).',
      '- search_queries: 의미 검색에 쓸 문장 2~3개. 질문을 자료에 적혀 있을 법한 말로 다시 쓴다 (멤버·작품의 한글·영어 표기, 영상 종류 Cover·Dance Practice·Behind·EP 같은 말, 같은 뜻의 다른 표현 포함).',
      '- keywords: 일정·공지·기사에서 찾을 낱말 2~6개 (작품 이름, 사녹·사전녹화·본인확인·준비물·티켓·OTT 같은 말). 비슷한 표기도 함께 (예: 사녹 → 사전녹화).',
    ].join('\n'),
    input: `오늘: ${today} (${weekday}요일)\n${historyText}지금 질문: ${question}`,
    schema: {
      name: 'ask_query',
      schema: {
        type: 'object', additionalProperties: false,
        required: ['from', 'to', 'programs', 'members', 'keywords', 'search_queries', 'lookup'],
        properties: {
          from: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
          to: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
          programs: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'string' } },
          keywords: { type: 'array', items: { type: 'string' } },
          search_queries: { type: 'array', items: { type: 'string' } },
          lookup: {
            type: 'object', additionalProperties: false, required: ['kind', 'name', 'member'],
            properties: { kind: { type: 'string', enum: ['none', 'series'] }, name: { type: ['string', 'null'] }, member: { type: ['string', 'null'] } },
          },
        },
      },
    },
  });
  opts.onCost?.(parsed.usage.costUsd);
  const q = JSON.parse(parsed.value) as { from: string | null; to: string | null; programs: string[]; members: string[]; keywords: string[]; search_queries?: string[]; lookup?: { kind: string; name: string | null; member: string | null } };
  // 작은 모델이 "이번 주말"을 다음 7일로 넓히는 경우가 있어 날짜는 코드로 확정한다.
  if (/이번\s*주말|주말\s*일정/.test(question)) {
    const todayUtc = Date.parse(`${today}T00:00:00Z`);
    const weekday0 = new Date(todayUtc).getUTCDay();
    const untilSaturday = (6 - weekday0 + 7) % 7;
    q.from = new Date(todayUtc + untilSaturday * 864e5).toISOString().slice(0, 10);
    q.to = new Date(todayUtc + (untilSaturday + 1) * 864e5).toISOString().slice(0, 10);
  }
  // 조회 도구: 시리즈·모아보기를 데이터에서 바로 전부 가져온다 (검색 운에 맡기지 않음)
  const lookupRows: { title: string; date: string; url: string; season: string; members: string[] }[] = [];
  if (q.lookup?.kind === 'series' && q.lookup.name) {
    const want = sq(q.lookup.name);
    const sr = (data.series ?? []).find((s) => sq(s.name) === want) ?? (data.series ?? []).find((s) => sq(s.name).includes(want) || want.includes(sq(s.name)));
    if (sr) {
      const mem = q.lookup.member;
      const aliases = mem ? [mem, ...(data.memberAliases?.[mem] ?? [])].map(sq) : [];
      for (const s of sr.seasons) for (const v of s.videos) {
        if (mem && !v.members.includes(mem) && !aliases.some((a) => a && sq(v.title).includes(a))) continue;
        lookupRows.push({ title: v.title, date: v.date, url: v.url, season: s.name, members: v.members });
      }
      lookupRows.sort((a, b) => a.date.localeCompare(b.date));
      log(`조회: ${sr.name}${mem ? ` · ${mem}` : ''} → ${lookupRows.length}개`);
    }
  }
  // 프로그램 정식 이름 → 모든 표기 (음악중심 → 음악중심·Show! MusicCore·MusicCore·음중)
  const programTerms = q.programs.flatMap((p) => programs.find((x) => x.names.some((n) => sq(n) === sq(p)) || sq(x.short ?? '') === sq(p))?.names ?? [p]);
  // 팬 용어 → 공지에 쓰는 말 (팬사인회 → 사인회, 사녹 → 사전녹화)
  const synonymTerms = Object.entries(SYNONYMS).filter(([k]) => sq(`${question} ${q.keywords.join(' ')}`).includes(sq(k))).flatMap(([, v]) => v);
  // 물은 멤버의 다른 표기 (런쥔 → RENJUN)
  const aliasTerms = q.members.flatMap((m) => data.memberAliases?.[m] ?? []);
  const terms = [...new Set([...q.keywords, ...programTerms, ...synonymTerms, ...aliasTerms].map(sq).filter((t) => t.length >= 2))];
  log(`\n질문 해석: 기간 ${q.from ?? '-'} ~ ${q.to ?? '-'} · 프로그램 ${q.programs.join(', ') || '-'} · 멤버 ${q.members.join(', ') || '-'} · 낱말 ${q.keywords.join(', ')}`);

  // ② 일정 검색
  const hits = (text: string) => terms.filter((t) => sq(text).includes(t)).length;
  // 방송은 며칠 전에 녹화하므로, 프로그램을 물으면 기간 시작 10일 전부터의 녹화·신청 일정도 함께 본다
  const from10 = q.from ? new Date(Date.parse(q.from) - 10 * 864e5).toISOString().slice(0, 10) : null;
  const inRange = (e: PublicEvent) => !q.from || !q.to || ((e.endDate ?? e.date) >= q.from && e.date <= q.to)
    || (programTerms.length > 0 && from10 !== null && e.date >= from10 && e.date < q.from && programTerms.some((p) => sq(e.title).includes(sq(p))));
  const asksTrip = /출국|입국|귀국|공항|해외|돌아와|들어와/.test(question);
  const tripWindow = (e: PublicEvent) => asksTrip && (Date.parse(e.date) - Date.parse(today)) >= -21 * 864e5 && (Date.parse(e.date) - Date.parse(today)) <= 30 * 864e5
    && (q.members.length === 0 || e.members.length === 0 || q.members.some((m) => e.members.includes(m)));
  const scoredEvents = events
    .filter((e) => inRange(e) || tripWindow(e))
    .map((e) => {
      const text = `${e.title} ${e.step} ${e.evidence ?? ''}`;
      let score = hits(text) * 2;
      if (programTerms.some((p) => sq(e.title).includes(sq(p)))) score += 4;
      if (q.members.length && q.members.some((m) => e.members.includes(m))) score += 1;
      return { e, score };
    })
    // 짧은 기간을 물으면(다음주 월요일에 뭐 있어?) 그 기간 일정은 낱말이 안 맞아도 모두
    .filter((x) => x.score > 0 || tripWindow(x.e) || (q.from !== null && q.to !== null && Date.parse(q.to) - Date.parse(q.from) <= 14 * 864e5 && (x.e.endDate ?? x.e.date) >= q.from && x.e.date <= q.to))
    .sort((a, b) => b.score - a.score || Math.abs(Date.parse(a.e.date) - Date.parse(today)) - Math.abs(Date.parse(b.e.date) - Date.parse(today)))
    .slice(0, q.from && q.to ? 24 : 14)
    .map((x) => x.e)
    .sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));

  // 원문 검색: 문서를 문단으로 나눠 낱말 점수로 고른다. 일정의 출처 공지는 가산점
  const sourceUrls = new Set(scoredEvents.flatMap((e) => e.sources.map((s) => s.url)));
  // 공지는 모두, 기사는 제목에 낱말이 있을 때만 (프로그램을 물으면 모두)
  const docs = data.docs
    .filter((d) => d.kind === 'notice' || hits(d.title) > 0 || (d.kind === 'article' && q.programs.length > 0))
    .map((d) => ({ ...d, boost: sourceUrls.has(d.url) ? 6 : 0 }));
  const keywordChunks = docs
    .flatMap((d) => {
      const paras = d.text.split(/\n{2,}|(?<=다\.)\s+(?=\S)/).reduce<string[]>((acc, p) => {
        const last = acc.at(-1);
        if (last && last.length + p.length < 700) acc[acc.length - 1] = `${last}\n${p}`;
        else acc.push(p);
        return acc;
      }, []);
      // 공항 질문은 최근 7일 자료를, 물어본 멤버가 제목에 있는 자료를 앞으로 (제목만 있는 짧은 기사가 긴 지난 출국 영상 설명에 밀리지 않게)
      const recentTrip = asksTrip && d.date >= new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10) ? 3 : 0;
      const memberHit = (q.members ?? []).some((m) => [m, ...(data.memberAliases?.[m] ?? [])].some((a) => d.title.includes(a))) ? 2 : 0;
      return paras.map((text) => ({ d, text: text.trim(), score: hits(text) * 2 + hits(d.title) + d.boost + recentTrip + memberHit + (q.from && d.date >= new Date(Date.parse(q.from) - 21 * 864e5).toISOString().slice(0, 10) ? 1 : 0) }));
    })
    .filter((c) => c.score > 1 && c.text.length > 30)
    .sort((a, b) => b.score - a.score || b.d.date.localeCompare(a.d.date))
    .slice(0, 30);
  // 하이브리드: 낱말 순위와 의미 검색 순위를 RRF(1/(60+순위))로 합쳐 상위 8개 (같은 문서·같은 문단은 하나로)
  let vectorCost = 0;
  let vectorHits = 0;
  type Chunk = (typeof keywordChunks)[number];
  let candidates: Chunk[] = keywordChunks;
  if (opts.vector) {
    // 의미 검색은 AI가 다듬은 검색 문장으로 (사람이 만든 낱말 목록이 아니라)
    const v = await opts.vector([question, ...(q.search_queries ?? []), ...aliasTerms].join('\n'), { count: 30 }).catch(() => ({ hits: [] as VectorHit[], costUsd: 0 }));
    vectorCost = v.costUsd;
    vectorHits = v.hits.length;
    const kst9 = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString() : '');
    const vecChunks: Chunk[] = v.hits.filter((h) => h.doc_type !== 'event').map((h) => ({
      d: { kind: (h.doc_type === 'notice' || h.doc_type === 'video' ? h.doc_type : 'article') as AskDoc['kind'], title: h.title, date: kst9(h.published_at).slice(0, 10), time: kst9(h.published_at).slice(11, 16) || undefined, url: h.doc_url, text: h.content, boost: 0 },
      text: h.content, score: h.similarity,
    }));
    const key = (c: Chunk) => `${c.d.url}|${c.text.slice(0, 60)}`;
    const fused = new Map<string, { c: Chunk; s: number }>();
    keywordChunks.forEach((c, i) => fused.set(key(c), { c, s: 1 / (60 + i + 1) }));
    vecChunks.forEach((c, i) => { const k = key(c); const cur = fused.get(k); fused.set(k, { c: cur?.c ?? c, s: (cur?.s ?? 0) + 1 / (60 + i + 1) }); });
    candidates = [...fused.values()].sort((a, b) => b.s - a.s).slice(0, 30).map((x) => x.c);
  }
  // 리랭킹: 후보 30개 중 질문에 맞는 것을 작은 AI(gpt-5-nano)가 골라 순서를 매긴다. 실패하면 합친 순서 그대로
  let chunks: Chunk[] = candidates.slice(0, 10);
  let rerankCost = 0;
  if (opts.rerank !== false && candidates.length > 3) {
    try {
      const list = candidates.map((c, i) => `[${i}] ${c.d.title.slice(0, 80)} (${c.d.date})\n${c.text.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
      const rr = await call({
        model: 'gpt-5.4-nano', effort: 'low',
        instructions: '질문에 답하는 데 필요한 자료 번호를 관련 높은 순서로 최대 10개 고른다. 관련 없는 자료는 고르지 않는다. 목록을 묻는 질문이면 해당하는 자료를 빠짐없이 고른다.',
        input: `오늘: ${today}\n질문: ${question}\n\n자료:\n${list}`,
        schema: { name: 'rerank', schema: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', items: { type: 'integer' } } } } },
      });
      rerankCost = rr.usage.costUsd;
      const ids = [...new Set((JSON.parse(rr.value) as { ids: number[] }).ids)].filter((i) => i >= 0 && i < candidates.length).slice(0, 10);
      if (ids.length) chunks = ids.map((i) => candidates[i]);
    } catch { /* 합친 순서 그대로 */ }
  }
  // 같은 문서의 문단은 한 번호로 묶는다 (같은 공지를 [D7][D8]로 두 번 인용하지 않게)
  const docBlocks = [...new Map(chunks.map((c) => [c.d.url, { d: c.d, texts: chunks.filter((x) => x.d.url === c.d.url).map((x) => x.text) }])).values()];
  // 공항 질문: 최근 7일 공항 기사·영상(물어본 멤버나 단체가 제목에 있는 것)은 검색 점수와 상관없이 맨 앞에 (검색어가 매번 달라 빠지는 일 방지)
  if (asksTrip) {
    const weekAgo = new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10);
    const names = (q.members ?? []).flatMap((m) => [m, ...(data.memberAliases?.[m] ?? [])]);
    const trip = docs.filter((d) => d.date >= weekAgo && d.date <= today && /출국|입국|귀국|공항|airport|arrival|departure/i.test(d.title)
      && (!names.length || names.some((n) => d.title.includes(n)) || !(data.members ?? []).some((m) => d.title.includes(m))));
    for (const d of trip.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4).reverse()) {
      if (!docBlocks.some((b) => b.d.url === d.url)) docBlocks.unshift({ d, texts: [d.text.slice(0, 600)] });
    }
  }

  // 날짜마다 요일과 오늘 기준 주(지난주·이번주·다음주)를 붙여서 AI가 "이번주"를 잘못 부르지 않게
  const dayMs = 864e5;
  const mondayOf = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); const wd = (new Date(t).getUTCDay() + 6) % 7; return t - wd * dayMs; };
  const thisMonday = mondayOf(today);
  const rel = (d: string) => {
    const w = Math.round((mondayOf(d) - thisMonday) / (7 * dayMs));
    const wd = '일월화수목금토'[new Date(`${d}T00:00:00Z`).getUTCDay()];
    const week = d === today ? '오늘' : w === 0 ? '이번주' : w === -1 ? '지난주' : w === 1 ? '다음주' : w < 0 ? `${-w}주 전` : `${w}주 뒤`;
    return `${d}(${wd}, ${week})`;
  };
  const statusOf = (e: PublicEvent) => ((e.endDate ?? e.date) < today ? '이미 끝남' : e.date > today ? '예정' : '진행 중·오늘');
  const evLines = scoredEvents.map((e, i) => `[E${i + 1}] (${statusOf(e)})${e.abroad ? ` [해외: ${e.abroad}]` : ''} ${rel(e.date)}${e.endDate && e.endDate !== e.date ? `~${e.endDate}` : ''} ${e.time ?? '시간 미정'}${e.timezone ? ` 현지(${e.timezone})${e.kst ? ` = 한국 ${e.kst.date !== e.date ? `${e.kst.date} ` : ''}${e.kst.time}` : ''}` : ''} · ${e.kind} · ${e.title} · ${e.step} · ${e.members.length ? e.members.join('·') : '단체'} · 출처 ${e.sources[0]?.url ?? '-'}${e.evidence ? `\n    근거: ${e.evidence.slice(0, 200)}` : ''}`);
  // 공지·기사 문단에 적힌 날짜가 모두 오늘보다 앞이면 표시 (끝난 이벤트를 지금 일처럼 말하지 않게, 코드로 계산)
  const datesIn = (t: string) => [...t.matchAll(/(20\d\d)\s*[.\-년/]\s*(\d{1,2})\s*[.\-월/]\s*(\d{1,2})/g)].map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  const pastNote = (texts: string[]) => {
    const ds = texts.flatMap(datesIn).filter((d) => !Number.isNaN(Date.parse(d)));
    if (!ds.length) return '';
    const last = ds.sort().at(-1)!;
    return last < today ? ` (적힌 날짜가 모두 지남: 마지막 ${last})` : '';
  };
  const docLines = docBlocks.map((b, i) => `[D${i + 1}]${pastNote(b.texts)} ${b.d.title} (게시 ${rel(b.d.date)}${b.d.time ? ` ${b.d.time}` : ''}) ${b.d.url}\n${b.texts.map((t) => t.slice(0, 900)).join('\n…\n')}`);
  // 물은 프로그램의 정규 방송 요일·시각과, 그 요일의 이번주 날짜 (추정할 때 날짜로 바꿔 말하게)
  const weekDates = [...Array(7)].map((_, i) => new Date(thisMonday + i * dayMs).toISOString().slice(0, 10));
  const progLines = q.programs.map((p) => programs.find((x) => x.names.some((n) => sq(n) === sq(p))))
    .filter((x): x is NonNullable<typeof x> => Boolean(x?.weekday))
    .map((x) => `- ${x.names[0]}: 매주 ${x.weekday}요일 ${x.time ?? ''} 방송 → 이번주 방송일 ${rel(weekDates['월화수목금토일'.indexOf(x.weekday!)])}`);
  const series = new Map<string, PublicEvent[]>();
  for (const e of scoredEvents) series.set(`${e.title}|${e.time ?? ''}`, [...(series.get(`${e.title}|${e.time ?? ''}`) ?? []), e]);
  const regularLines = [...series.values()].filter((l) => l.length >= 2 && l[0].kind === '방송').map((l) => {
    const all = events.filter((e) => e.title === l[0].title && e.time === l[0].time);
    const days = [...new Set(all.map((e) => '일월화수목금토'[new Date(`${e.date}T00:00:00Z`).getUTCDay()]))];
    return `- ${l[0].title}: 매주 ${days.join('·')} ${l[0].time ?? ''} (일정 ${all.length}개 기준)`;
  });
  if (regularLines.length) progLines.push(...regularLines);
  const watchLines = Object.entries(data.watch ?? {}).filter(([name]) => [question, ...q.keywords, ...scoredEvents.slice(0, 6).map((e) => e.title)].some((t) => sq(t).includes(sq(name))))
    .map(([name, ws]) => `- ${name} 볼 수 있는 곳: ${ws.map((w) => `${w.label}${w.url ? ` ${w.url}` : ''}${w.note ? ` (${w.note})` : ''}`).join(' / ')}`);
  if (watchLines.length) progLines.push(...watchLines);
  const otherNotes = Object.entries(data.otherGroups ?? {}).filter(([m]) => q.members.includes(m) || question.includes(m)).map(([m, gs]) => `- ${m}: ${gs.join('·')} 활동도 한다. ${gs.join('·')} 일정은 수집하지 않아서 자료에 없을 수 있다.`);
  if (otherNotes.length) progLines.push(...otherNotes);
  const lookupText = lookupRows.length ? `# 조회 결과 (데이터에서 가져온 전체 목록, 빠짐없이 쓸 것)\n${lookupRows.map((r, i) => `[L${i + 1}] ${rel(r.date)} · ${r.title}${r.season && r.season !== r.title ? ` · ${r.season}` : ''} · ${r.url}`).join('\n')}\n\n` : '';
  const context = `${lookupText}${progLines.length ? `# 참고 (정규 편성·멤버)\n${progLines.join('\n')}\n\n` : ''}# 일정\n${evLines.join('\n') || '(맞는 일정 없음)'}\n\n# 공지·기사 문단\n${docLines.join('\n\n') || '(맞는 문단 없음)'}`;

  // ③ 답변
  const answer = await call({
    model,
    effort: 'low',
    instructions: [
      `너는 ${data.groupName} 팬을 돕는 일정 도우미다. 오늘 날짜와 이번주 범위(한국 시간)는 입력 맨 앞 "오늘:" 줄에 있다.`,
      ...(data.rules?.answer ?? []),
    ].join('\n'),
    input: `오늘: ${today} (${weekday}요일). 이번주는 ${new Date(thisMonday).toISOString().slice(0, 10)}(월)~${new Date(thisMonday + 6 * dayMs).toISOString().slice(0, 10)}(일).\n${historyText}질문: ${question}\n\n자료:\n${context}`,
  });
  opts.onCost?.(answer.usage.costUsd + vectorCost + rerankCost);

  // ④ 검사: 답의 날짜·시간이 자료에 있는지
  const nextWeek = weekDates.map((d) => new Date(Date.parse(d) + 7 * dayMs).toISOString().slice(0, 10));
  const ctx = `${context}\n${today} ${weekDates.join(' ')} ${nextWeek.join(' ')}`.replace(/(\d{1,2})\.\s+(\d{1,2})/g, '$1.$2');
  const checkText = answer.value.split('\n').filter((l) => !/추정/.test(l)).join('\n');
  // 자료 번호가 아닌 가짜 출처 표시([자료에 없어요], [참고])는 지운다
  answer.value = answer.value.replace(/\s*\[(?![EDL]\d+\])[^\]\n]{1,12}\]/g, '');
  const pad = (n: string) => n.padStart(2, '0');
  const unverified: string[] = [];
  for (const m of checkText.matchAll(/(?<![\d.])(\d{1,2})\s*[/월.]\s*(\d{1,2})(?![\d:])\s*일?/g)) {
    const [mm, dd] = [pad(m[1]), pad(m[2])];
    if (!(ctx.includes(`-${mm}-${dd}`) || ctx.includes(`${Number(mm)}월 ${Number(dd)}일`) || ctx.includes(`${Number(mm)}/${Number(dd)}`) || ctx.includes(`${Number(mm)}.${Number(dd)}`) || ctx.includes(`${mm}.${dd}`))) unverified.push(m[0]);
  }
  for (const m of checkText.matchAll(/(\d{1,2}):(\d{2})/g)) {
    const h = Number(m[1]);
    // 자료가 "06:30PM", "오후 6시 30분"처럼 12시간제로 적혀 있어도 같은 시각으로 본다
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const flat = ctx.replace(/\s+/g, '');
    const ok = ctx.includes(`${pad(m[1])}:${m[2]}`) || ctx.includes(`${h}:${m[2]}`)
      || new RegExp(`0?${h12}:${m[2]}${ampm}`, 'i').test(flat)
      || flat.includes(`${h >= 12 ? '오후' : '오전'}${h12}시${m[2] === '00' ? '' : `${Number(m[2])}분`}`);
    if (!ok) unverified.push(m[0]);
  }

  const used = [...new Set([...answer.value.matchAll(/\[([EDL])(\d+)\]/g)].map((m) => `${m[1]}${m[2]}`))].sort();
  const raw = used.flatMap((id): Omit<AskResult["sources"][number], "ids">[] => {
    const i = Number(id.slice(1)) - 1;
    if (id[0] === 'E' && scoredEvents[i]) { const e = scoredEvents[i]; const sub = e.sources.every((x) => x.type === 'submission'); return [{ id, title: `${e.title} ${e.date}`, url: e.sources[0]?.url ?? '', kind: sub ? ('submission' as const) : ('event' as const), date: e.date }]; }
    if (id[0] === 'D' && docBlocks[i]) return [{ id, title: docBlocks[i].d.title, url: docBlocks[i].d.url, kind: docBlocks[i].d.kind as 'notice' | 'article' | 'video', date: docBlocks[i].d.date }];
    if (id[0] === 'L' && lookupRows[i]) return [{ id, title: `${lookupRows[i].title} ${lookupRows[i].date}`, url: lookupRows[i].url, kind: 'list' as const, date: lookupRows[i].date }];
    return [];
  });
  // 공지 제목(D)이 일정 제목(E)보다 알아보기 쉬워서 D를 먼저
  raw.sort((a, b) => (a.id[0] === b.id[0] ? 0 : a.id[0] === 'D' ? -1 : 1));
  const byUrl = new Map<string, AskResult['sources'][number]>();
  for (const r of raw) {
    const key = r.url || r.id;
    const hit = byUrl.get(key);
    if (hit) hit.ids.push(r.id);
    else byUrl.set(key, { ...r, ids: [r.id] });
  }
  const sources = [...byUrl.values()];
  return {
    answer: answer.value, query: q, sources, unverified: [...new Set(unverified)],
    events: used.filter((id) => id[0] === 'E').map((id) => scoredEvents[Number(id.slice(1)) - 1]).filter(Boolean).map((e) => ({
      id: e.id, date: e.date, time: e.time, endDate: e.endDate, endTime: e.endTime, title: e.title, step: e.step, kind: e.kind, status: e.status,
      fromSubmission: e.sources.every((x) => x.type === 'submission'), url: e.sources[0]?.url ?? '', flowId: e.flowId,
    })),
    notFound: used.length === 0,
    stats: { events: scoredEvents.length, docs: docBlocks.length, chunks: chunks.length, costUsd: parsed.usage.costUsd + answer.usage.costUsd + vectorCost + rerankCost, model, vectorHits },
    retrieval: { candidates: [...new Set(candidates.map((c) => c.d.url))], final: [...new Set(chunks.map((c) => c.d.url))], events: scoredEvents.flatMap((e) => e.sources.map((x) => x.url)) },
  };
}
