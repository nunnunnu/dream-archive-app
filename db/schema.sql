-- NCT DREAM 아카이브 · Supabase(Postgres) 스키마 초안
-- 수집기의 저장 창구(collector/lib/repo.ts)가 다루는 데이터를 그대로 옮긴 것.
--   공개(사이트가 읽음): groups, group_members, group_units, events, event_sources, pending_items, rumors, videos, notices(본문 제외), tracked
--   비공개(수집기만):    youtube_channels, notice_bodies, article_bodies, articles, extractions, submissions, kv_state
-- 그룹(아이돌)이 여럿이어도 되게 콘텐츠 테이블마다 group_id 가 있다.
-- 수집기는 service_role 키로 쓰고, 사이트는 anon 키로 공개 테이블만 읽는다 (RLS).

-- ── 그룹(아이돌) 설정 ─────────────────────────────────────────
-- config/group.json 을 옮긴 것. 그룹이 늘면 행을 추가하고, 멤버가 빠지면 status를 'former'로 바꾼다.

create table groups (
  id                text primary key,                -- 'nctdream'
  name              text not null,                   -- 'NCT DREAM'
  name_variants     text[] not null default '{}',    -- 표기 변형 (NCT 드림, 엔시티드림 …)
  parent_names      text[] not null default '{}',    -- 상위 그룹 (NCT, 엔시티)
  extra_patterns    text[] not null default '{}',    -- 추가 정규식
  fandom            text[] not null default '{}',
  nicknames         text[] not null default '{}',
  weverse_community text,                            -- weverse.io/{community}
  active            boolean not null default true,   -- 수집 대상인지
  created_at        timestamptz not null default now()
);

create table group_members (
  group_id  text not null references groups (id) on delete cascade,
  slug      text not null,                           -- 'jisung' (구독 캘린더 파일 이름)
  name      text not null,                           -- '지성' (일정의 members 배열에 들어가는 값)
  aliases   text[] not null default '{}',            -- 박지성, JISUNG …
  nicknames text[] not null default '{}',
  status    text not null default 'active' check (status in ('active', 'former')),
  hidden    boolean not null default false,          -- true면 관련 글을 모두 숨김 (탈퇴 멤버)
  ord       smallint not null default 0,             -- 표시 순서
  primary key (group_id, slug),
  unique (group_id, name)
);

create table group_units (
  group_id text not null references groups (id) on delete cascade,
  name     text not null,                            -- 'NCT JNJM'
  aliases  text[] not null default '{}',
  members  text[] not null,                          -- {'제노','재민'}
  primary key (group_id, name)
);

create table youtube_channels (
  group_id   text not null references groups (id) on delete cascade,
  channel_id text not null,
  name       text not null,
  filter     boolean not null default true,          -- 그룹 이름이 제목에 있는 영상만
  guest      boolean not null default false,         -- 방송사·제작사 채널 (영상이 출연 콘텐츠일 수 있음)
  primary key (group_id, channel_id)
);

-- ── 원본 문서 ────────────────────────────────────────────────

create table notices (
  group_id         text not null references groups (id),
  id               text primary key,              -- 위버스 공지 번호
  url              text not null,
  title            text not null,
  posted_at        timestamptz not null,           -- 위버스에 표시된 작성 시각
  body_hash        text not null,                  -- 본문이 바뀌었는지 비교용
  first_fetched_at timestamptz not null,
  last_changed_at  timestamptz not null
);
create index notices_posted_at on notices (posted_at desc);

-- 원문 본문은 저작권 때문에 비공개 테이블로 분리
create table notice_bodies (
  notice_id text primary key references notices (id) on delete cascade,
  body      text not null
);

create table articles (
  group_id         text not null references groups (id),
  guid          text primary key,                  -- 구글 뉴스 guid
  title         text not null,                     -- 언론사 꼬리를 뗀 제목
  link          text not null,
  source        text not null,                     -- 언론사
  published_at  timestamptz not null,
  first_seen_at timestamptz not null,
  origin        text not null check (origin in ('search', 'followup')),
  focus         text,                              -- 빈칸 채우기 검색이면 찾던 대상
  cluster_id    text,                              -- 같은 소식 묶음
  status        text not null default 'pending' check (status in ('pending', 'skipped', 'processed', 'failed')),
  note          text
);
create index articles_published_at on articles (published_at desc);
create index articles_cluster on articles (cluster_id);
create index articles_status on articles (status) where status = 'pending';

create table article_bodies (
  guid text primary key references articles (guid) on delete cascade,
  body text not null
);

create table videos (
  group_id         text not null references groups (id),
  video_id            text primary key,
  title               text not null,
  url                 text not null,
  channel             text not null,
  published_at        timestamptz not null,
  first_seen_at       timestamptz not null,
  members             text[] not null default '{}',  -- 비어 있으면 단체
  scope               text not null check (scope in ('단체', '멤버', '유닛')),
  guest               boolean not null default false,  -- 다른 채널 출연 영상
  channel_subscribers integer,
  description         text,                          -- 출연 탐색 영상을 AI가 해석할 때 씀
  tags                text[] not null default '{}'
);
create index videos_tags on videos using gin (tags);
create index videos_published_at on videos (published_at desc);

create table community_posts (                     -- 팬 커뮤니티 글 (더쿠 스퀘어). 제목·링크만, 본문은 저장하지 않음(.cache)
  group_id   text not null references groups (id),
  site       text not null default 'theqoo',
  id         text not null,
  url        text not null,
  title      text not null,
  posted_at  timestamptz not null,
  members    text[] not null default '{}',          -- 제목 이모지로 표시된 멤버
  status     text not null check (status in ('listed', 'read', 'skipped', 'failed')),
  note       text,
  primary key (site, id)
);

create table submissions (
  group_id         text not null references groups (id),
  id       text primary key,
  url      text not null,
  text     text,                                   -- 웨이보 등 직접 붙여 넣은 글
  note     text,                                   -- 예: "지성 추측"
  added_at timestamptz not null,
  status   text not null check (status in ('pending', 'processed', 'needs-text', 'failed'))
);

-- ── AI 추출 결과 (문서 하나당 한 줄) ─────────────────────────

create table extractions (
  group_id       text not null references groups (id),  -- 프롬프트가 그룹별이라 같은 문서도 그룹마다 따로
  doc_type       text not null check (doc_type in ('notice', 'article', 'submission', 'video', 'post')),
  doc_id         text not null,
  model          text not null,
  prompt_version integer not null,
  content_hash   text not null,                    -- 처리한 본문의 해시 (바뀌면 다시 뽑음)
  events         jsonb not null,                   -- AI가 낸 그대로
  checked        jsonb not null,                   -- 원문 대조를 통과한 일정
  dropped        jsonb not null,                   -- 버린 것과 이유
  source         jsonb not null,                   -- 출처 (사이트 표시용)
  usage          jsonb not null,                   -- 토큰·비용
  created_at     timestamptz not null,
  primary key (group_id, doc_type, doc_id)
);

-- ── 사이트용 결과 (합치기 단계가 매번 다시 씀) ───────────────

create table events (
  group_id     text not null references groups (id),
  id           text primary key,
  date         date not null,
  time         time,                               -- 없으면 시간 미정
  end_date     date,
  end_time     time,
  timezone     text,                               -- 해외 현지 시간이면 'PHT' 등 (시간은 현지 기준)
  title        text not null,                      -- 무엇의 일정 (예: "SBS 꼬꼬무")
  step         text not null,                      -- 단계 (예: "제노 출연", "3회")
  kind         text not null check (kind in ('신청', '당첨 발표', '본인 확인', '녹화', '방송', '발매', '투표', '판매', '행사', '모임', '기타')),
  category     text not null check (category in ('공식', '참여')),  -- 공식: 멤버가 나오는 일정, 참여: 팬이 미리 해야 하는 일
  calendars    text[] not null default '{}',       -- 보여 줄 캘린더 {'공식','참여'} (콘서트·팬미팅은 둘 다)
  audience     text not null check (audience in ('all', 'winners')),  -- winners: 당첨자만 가는 단계
  members      text[] not null default '{}',
  scope        text not null check (scope in ('단체', '멤버', '유닛')),
  status       text not null check (status in ('confirmed', 'needs-check')),
  evidence     text not null,                      -- 근거 문장 (짧은 인용)
  series_id    text,                               -- 반복 방송이면 시리즈와 회차
  episode      integer,
  flow_id      text,                               -- 신청이 있는 일정 묶음 (사녹 등)
  tags         text[] not null default '{}',       -- 모아보기 태그 ('era:boogie-woogie', 'project:crash2', 'type:외부 출연', 'member:지성' …)
  extracted_by text not null check (extracted_by in ('ai', 'rule')),
  updated_at   timestamptz not null default now()
);
create index events_date on events (group_id, date);
create index events_members on events using gin (members);
create index events_flow on events (flow_id) where flow_id is not null;
create index events_tags on events using gin (tags);

create table event_sources (
  event_id     text not null references events (id) on delete cascade,
  ord          smallint not null,                  -- 0 = 대표 출처
  type         text not null check (type in ('weverse-notice', 'news', 'youtube', 'submission', 'sns')),  -- sns: 공식 SNS·유튜브 원 게시물
  ref_id       text not null,                      -- 공지 번호, 기사 guid, 영상 id …
  url          text not null,
  title        text not null,
  publisher    text,
  published_at timestamptz not null,
  primary key (event_id, ord)
);

create table pending_items (                       -- 날짜 미정 소식
  group_id  text not null references groups (id),
  id        text primary key,
  title     text not null,
  step      text not null,
  when_text text not null,                         -- 예: "2027년 4월"
  members   text[] not null default '{}',
  scope     text not null,
  evidence  text not null,
  sources   jsonb not null
);

create table rumors (                              -- 추측·예고 (멤버 미확인, 캘린더에 넣지 않음)
  group_id       text not null references groups (id),
  id             text primary key,
  date           date not null,
  time           time,
  title          text not null,
  step           text not null,
  guess_members  text[] not null default '{}',
  evidence       text not null,
  sources        jsonb not null
);

create table tags (                                -- 모아보기 태그 (config/tags.json + 자동 생성)
  group_id  text not null references groups (id),
  id        text not null,                         -- 'era:boogie-woogie'
  kind      text not null check (kind in ('era', 'project', 'type', 'year', 'member')),
  name      text not null,                         -- 'Boogie Woogie 활동 (정규 6집 DREAM AFTER DREAM)'
  keywords  text[] not null default '{}',
  date_from date,                                  -- 활동기 범위
  date_to   date,
  auto      boolean not null default false,        -- 영상 시리즈·추적 목록에서 자동으로 만든 태그
  primary key (group_id, id)
);

create table tracked (                             -- 고정 출연 추적 목록
  group_id   text not null references groups (id),
  id         text primary key,
  title      text not null,
  members    text[] not null default '{}',
  weekdays   text[] not null,                      -- {'월','화'}
  time       time,
  start_date date not null,
  episodes   integer,
  end_date   date,
  status     text not null check (status in ('active', 'ended')),
  origin     text not null check (origin in ('auto', 'manual')),
  sources    jsonb not null default '[]',
  added_at   timestamptz not null
);

-- ── 수집기 상태 (번호 커서, 구글 링크 캐시, AI 비용, 재검색 기록 …) ──

create table kv_state (
  key        text primary key,                     -- 예: 'nctdream/weverse/probe', 'usage'(전체 공통), 'nctdream/fill'
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── 사이트가 읽기 편한 뷰: 일정 + 출처 배열 ───────────────────

create view public_events as
select e.*,
       coalesce(jsonb_agg(jsonb_build_object(
         'type', s.type, 'url', s.url, 'title', s.title, 'publisher', s.publisher, 'publishedAt', s.published_at
       ) order by s.ord) filter (where s.event_id is not null), '[]') as sources
from events e
left join event_sources s on s.event_id = e.id
group by e.id;

-- ── 권한 (RLS): 공개 테이블은 누구나 읽기만, 나머지는 막음 ─────

alter table groups           enable row level security;
alter table group_members    enable row level security;
alter table group_units      enable row level security;
alter table youtube_channels enable row level security;
alter table notices        enable row level security;
alter table notice_bodies  enable row level security;
alter table articles       enable row level security;
alter table article_bodies enable row level security;
alter table videos         enable row level security;
alter table submissions    enable row level security;
alter table extractions    enable row level security;
alter table events         enable row level security;
alter table event_sources  enable row level security;
alter table pending_items  enable row level security;
alter table rumors         enable row level security;
alter table tags           enable row level security;
alter table tracked        enable row level security;
alter table kv_state       enable row level security;

create policy "공개 읽기" on groups        for select using (true);
create policy "공개 읽기" on group_members for select using (true);
create policy "공개 읽기" on group_units   for select using (true);
create policy "공개 읽기" on notices       for select using (true);
create policy "공개 읽기" on videos        for select using (true);
create policy "공개 읽기" on events        for select using (true);
create policy "공개 읽기" on event_sources for select using (true);
create policy "공개 읽기" on pending_items for select using (true);
create policy "공개 읽기" on rumors        for select using (true);
create policy "공개 읽기" on tags          for select using (true);
create policy "공개 읽기" on tracked       for select using (true);
-- notice_bodies, articles, article_bodies, submissions, extractions, kv_state 는 정책 없음 = anon 접근 불가
-- (service_role 키는 RLS를 우회하므로 수집기는 모두 읽고 쓸 수 있다)
