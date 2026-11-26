-- Migration 006 — comments table (لدوال الإشراف)
create table if not exists comments (
  id bigserial primary key,
  video_id bigint not null references videos(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  body text not null,
  status text not null default 'approved' check (status in ('approved','under_review','removed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_comments_video on comments(video_id);
alter table comments enable row level security;
-- مفيش policies = كله من خلال الدوال
