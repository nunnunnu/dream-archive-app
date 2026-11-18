-- 질문 에이전트 RAG: 조각(청크) + 임베딩(pgvector)
-- Supabase 대시보드 → SQL Editor 에 붙여 넣고 Run (한 번만)
-- 읽기·쓰기는 서버(service_role/secret 키)만. RLS를 켜 두고 공개 정책은 만들지 않는다.

create extension if not exists vector;

create table if not exists rag_chunks (
  id           text primary key,              -- 문서 주소 + 조각 번호의 지문
  doc_type     text not null,                 -- notice | article | video | event
  doc_url      text not null,
  title        text not null,
  published_at timestamptz,
  members      text[] not null default '{}',
  content      text not null,                 -- 조각 본문 (짧게, 원문 전체를 공개하지 않는다)
  content_hash text not null,                 -- 바뀐 조각만 다시 임베딩
  embedding    vector(1536) not null,         -- text-embedding-3-small
  updated_at   timestamptz not null default now()
);

create index if not exists rag_chunks_embedding_idx on rag_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists rag_chunks_published_idx on rag_chunks (published_at);
create index if not exists rag_chunks_doc_idx on rag_chunks (doc_url);

alter table rag_chunks enable row level security;

-- 의미 검색 + 날짜·종류 필터 (하이브리드 검색에서 낱말 점수와 합친다)
create or replace function match_rag_chunks(
  query_embedding vector(1536),
  match_count int default 8,
  since timestamptz default null,
  until timestamptz default null,
  doc_types text[] default null
)
returns table (id text, doc_type text, doc_url text, title text, published_at timestamptz, members text[], content text, similarity float)
language sql stable
as $$
  select c.id, c.doc_type, c.doc_url, c.title, c.published_at, c.members, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from rag_chunks c
  where (since is null or c.published_at >= since)
    and (until is null or c.published_at <= until)
    and (doc_types is null or c.doc_type = any(doc_types))
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
