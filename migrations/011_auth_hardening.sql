-- ============================================================================
-- Migration 011 — تقوية الدخول: أعمدة جديدة + جداول الاسترداد/التسجيل
-- لا يحذف بيانات. لا يدمج حسابات متعارضة — يبلغ عنها فقط.
-- ============================================================================

alter table users add column if not exists must_change_password boolean not null default false;
alter table users add column if not exists email text;
alter table users add column if not exists email_verified boolean not null default false;
alter table sessions add column if not exists device_hash text;
alter table login_attempts add column if not exists kind text not null default 'login';

create table if not exists register_attempts (
  id bigserial primary key,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists idx_register_attempts_ip_time on register_attempts(ip, created_at);

create table if not exists recovery_codes (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_recovery_user on recovery_codes(user_id);

alter table register_attempts enable row level security;
alter table recovery_codes enable row level security;
-- مفيش policies = كله من السيرفر

-- كل الهاشات القديمة (غير s1$) لازم تغيير باسورد عند الدخول الجاي
update users set must_change_password = true
where password_hash is not null and password_hash not like 's1$%' and not must_change_password;

-- توحيد اليوزرات الموجودة مع الإبلاغ عن التعارض (من غير دمج)
do $norm$
declare r record; n text;
begin
  create temp table if not exists norm_users(id bigint, uname text) on commit drop;
  truncate norm_users;
  insert into norm_users(id, uname)
  select id, lower(trim(regexp_replace(coalesce(username, external_id, ''),
    '[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]', '', 'g')))
  from users where coalesce(username, external_id, '') <> '';

  for r in
    select uname, count(*) c from norm_users group by uname having count(*) > 1
  loop
    raise notice 'USERNAME COLLISION: % (% حسابات) — لم يتم الدمج', r.uname, r.c;
  end loop;

  update users u set username = n.uname
  from norm_users n
  where u.id = n.id
    and u.username is distinct from n.uname
    and not exists (select 1 from norm_users x where x.uname = n.uname and x.id <> n.id);
end $norm$;
