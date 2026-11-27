-- Migration 009 — جلسات مشفرة + محاولات دخول (Rate limit في DB)
create table if not exists sessions (
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  ip text,
  user_agent text,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_sessions_user on sessions(user_id) where not revoked;

create table if not exists login_attempts (
  id bigserial primary key,
  username text,
  ip text,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_login_attempts_time on login_attempts(created_at);

alter table sessions enable row level security;
alter table login_attempts enable row level security;
-- مفيش policies = كله من خلال الدوال/السيرفر
