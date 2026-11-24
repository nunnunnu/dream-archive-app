-- 수집 상태 2차: 제보·출처 링크·AI 비용 (db/state.sql 다음에 한 번 실행). 다시 실행해도 괜찮다.

-- 사이트 제보 (추가·수정·삭제). 일정은 매 수집마다 다시 만들어지는 결과라 event_id에 외래키를 걸지 않고,
-- 제보 당시 일정 모습을 event_snapshot 으로 남긴다 (일정 ID는 고정 지문이라 같은 일정이면 유지된다)
create table if not exists reports (
  id                text primary key,
  group_id          text not null default 'nctdream',
  type              text not null check (type in ('add', 'fix', 'delete', 'news')),
  event_id          text,
  event_snapshot    jsonb,
  title             text,
  source_url        text,
  proposed_changes  jsonb,                  -- 날짜·시간·멤버 등 바꾸자는 값
  message           text,
  status            text not null default 'pending'
                    check (status in ('pending', 'auto_approved', 'manual_review', 'approved', 'rejected')),
  review_reason     text,
  created_at        timestamptz not null default now(),
  reviewed_at       timestamptz
);
create index if not exists reports_status_idx on reports (status);
create index if not exists reports_event_idx on reports (event_id);

-- 직접 넣은 출처 링크 (npm run submit): AI가 읽어서 일정으로
create table if not exists submissions (
  id          text primary key,
  url         text not null,
  note        text,
  status      text,
  added_at    timestamptz not null default now(),
  data        jsonb not null
);

-- AI 비용: 운영은 달마다('YYYY-MM'), 일회성 개발 작업은 'dev'
create table if not exists llm_usage (
  bucket      text primary key,
  cost_usd    numeric(12, 6) not null default 0,
  calls       int not null default 0,
  updated_at  timestamptz not null default now()
);

alter table reports     enable row level security;
alter table submissions enable row level security;
alter table llm_usage   enable row level security;

-- 소식 제보(news) 추가 (2026-11-24): 이미 만든 DB에는 아래를 한 번 실행
alter table reports drop constraint if exists reports_type_check;
alter table reports add constraint reports_type_check check (type in ('add', 'fix', 'delete', 'news'));

-- 제보를 KV 대신 여기에 바로 받는다 (2026-11-24): 어드민 결정 칸, 한 건 제보 횟수 제한용 IP 해시
alter table reports add column if not exists decision jsonb;
alter table reports add column if not exists ip_hash text;
create index if not exists reports_ip_idx on reports (ip_hash, created_at);
create index if not exists reports_decision_idx on reports (id) where decision is not null;
