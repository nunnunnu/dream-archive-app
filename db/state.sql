-- 수집 상태를 JSON 파일 묶음(state.tgz) 대신 Postgres에 저장한다.
-- Supabase 대시보드 → SQL Editor 에 붙여 넣고 Run (한 번만). 다시 실행해도 괜찮다 (if not exists).
-- 읽기·쓰기는 수집기(service_role/secret 키)만. RLS를 켜 두고 공개 정책은 만들지 않는다 (원문은 저작권 때문에 비공개).
-- 자주 찾는 값(날짜·상태·채널)은 열과 인덱스로, 나머지 세부 항목은 data(jsonb)에 그대로 (수집기 기록 형태를 바꾸지 않으려고).

-- 위버스 공지
create table if not exists notices (
  id          text primary key,
  posted_at   timestamptz not null,
  title       text not null,
  url         text not null,
  data        jsonb not null,               -- NoticeRecord 전체
  updated_at  timestamptz not null default now()
);
create index if not exists notices_posted_idx on notices (posted_at desc);

-- 기사 (구글 뉴스로 찾은 것)
create table if not exists articles (
  guid          text primary key,
  published_at  timestamptz not null,
  title         text not null,
  status        text,                       -- pending | skipped | processed | failed
  data          jsonb not null,             -- ArticleRecord 전체
  updated_at    timestamptz not null default now()
);
create index if not exists articles_published_idx on articles (published_at desc);
create index if not exists articles_status_idx on articles (status);

-- 공지·기사·제보 원문 (비공개, 재게시하지 않음)
create table if not exists bodies (
  kind        text not null,                -- notice | article | submission | video | post
  id          text not null,
  text        text not null,
  updated_at  timestamptz not null default now(),
  primary key (kind, id)
);

-- 문서별 AI 추출 결과 (원문 대조를 통과한 일정 포함)
create table if not exists extractions (
  doc_type        text not null,
  doc_id          text not null,
  prompt_version  int  not null,
  content_hash    text not null,
  data            jsonb not null,           -- ExtractionRecord 전체
  created_at      timestamptz not null default now(),
  primary key (doc_type, doc_id)
);

-- 유튜브 영상 (공식 채널·출연·공항·드라마 등)
create table if not exists videos (
  video_id        text primary key,
  published_at    timestamptz not null,
  channel         text not null,
  title           text not null,
  unavailable_at  timestamptz,              -- 비공개·삭제 확인된 때
  data            jsonb not null,           -- Video 전체
  updated_at      timestamptz not null default now()
);
create index if not exists videos_published_idx on videos (published_at desc);
create index if not exists videos_channel_idx on videos (channel);

-- 그 밖의 상태 (비용 기록, 활동 주소, 추적 목록, 채우기 진행 등). key = 예전 파일 경로 (예: 'usage', 'activities/ids')
create table if not exists app_state (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table notices     enable row level security;
alter table articles    enable row level security;
alter table bodies      enable row level security;
alter table extractions enable row level security;
alter table videos      enable row level security;
alter table app_state   enable row level security;
