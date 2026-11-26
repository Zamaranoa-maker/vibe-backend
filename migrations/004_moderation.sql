-- ============================================================================
-- Migration 004 — Admin, Reports, Strikes, Appeals, Notices, Audit
-- adapted: bigint user ids (بدل auth.uid()). لا يحذف بيانات.
-- ============================================================================

-- ===== الأدمن =====
create table if not exists admins (
  user_id bigint primary key references users(id) on delete cascade,
  role text not null default 'moderator' check (role in ('moderator','super'))
);
create or replace function is_admin(p_user bigint, min_role text default 'moderator')
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id=p_user
    and (min_role='moderator' or role='super'))
$$;
-- أضف نفسك أدمن: insert into admins values (<your_id>, 'super');

-- ===== البروفايل =====
alter table profiles add column if not exists age_tier text check (age_tier in ('13-15','16-17','18+'));
alter table profiles add column if not exists is_private boolean not null default false;
alter table profiles add column if not exists status text not null default 'active'
  check (status in ('active','restricted','suspended','banned'));
alter table profiles add column if not exists restricted_until timestamptz;
alter table profiles add column if not exists ban_reason text;

-- تاريخ الميلاد في جدول مقفول
create table if not exists private_birthdates (
  user_id bigint primary key references users(id) on delete cascade,
  birth_date date not null,
  set_at timestamptz not null default now()
);

-- حالة الفيديو الافتراضية: pending
alter table videos alter column status set default 'pending';

-- ===== البلاغات =====
create table if not exists reports (
  id           bigserial primary key,
  reporter_id  bigint references users(id) on delete set null,
  target_type  text not null check (target_type in ('video','comment','profile','voice','live','message')),
  target_id    text not null,
  target_owner bigint,
  reason       text not null check (reason in
    ('child_safety','sexual','violence','hate','self_harm','drugs_weapons','scam','harassment','copyright','other')),
  details      text check (length(details)<=500),
  priority     smallint not null default 3,
  status       text not null default 'open' check (status in ('open','actioned','dismissed')),
  created_at   timestamptz not null default now(),
  reviewed_by  bigint,
  reviewed_at  timestamptz,
  unique (reporter_id, target_type, target_id)
);
create index if not exists idx_reports_status on reports (status, priority, created_at);
create index if not exists idx_reports_target on reports (target_type, target_id);

-- ===== العقوبات =====
create table if not exists strikes (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  severity   text not null check (severity in ('minor','severe')),
  reason     text,
  report_id  bigint references reports(id),
  issued_by  bigint,
  revoked    boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);
create index if not exists idx_strikes_user on strikes (user_id) where not revoked;

create table if not exists appeals (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  strike_id   bigint not null references strikes(id),
  message     text not null check (length(message) between 10 and 1000),
  status      text not null default 'open' check (status in ('open','accepted','rejected')),
  reviewed_by bigint,
  created_at  timestamptz not null default now()
);

-- إشعارات شفافية
create table if not exists user_notices (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  kind text not null,
  body text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- سجل المراجعين
create table if not exists mod_audit (
  id bigserial primary key,
  admin_id bigint not null,
  action text not null,
  target_type text, target_id text, report_id bigint, note text,
  created_at timestamptz not null default now()
);

-- كلمات ممنوعة
create table if not exists blocked_words (
  term text primary key,
  action text not null default 'review' check (action in ('block','review'))
);
insert into blocked_words(term,action) values
  ('عري','block'),('شذوذ','block'),('اغتصاب','block'),('انتحار','review'),('مخدرات','block')
on conflict (term) do nothing;

-- ===== RLS =====
alter table admins enable row level security;
alter table private_birthdates enable row level security;
alter table reports enable row level security;
alter table strikes enable row level security;
alter table appeals enable row level security;
alter table user_notices enable row level security;
alter table mod_audit enable row level security;
alter table blocked_words enable row level security;

drop policy if exists "own strikes" on strikes;
drop policy if exists "own notices" on user_notices;
drop policy if exists "own appeals" on appeals;
create policy "own strikes" on strikes for select using (user_id = (select id from users where external_id=current_setting('app.user',true)));
create policy "own notices" on user_notices for select using (user_id = (select id from users where external_id=current_setting('app.user',true)));
create policy "own appeals" on appeals for select using (user_id = (select id from users where external_id=current_setting('app.user',true)));
-- باقي الجداول: مفيش policies = كله من خلال الدوال

/* ============================================================================
   دوال الإشراف
   ========================================================================== */

-- تقديم بلاغ (أولوية قصوى لسلامة الطفل)
create or replace function submit_report(
  p_user bigint, p_type text, p_target text, p_owner bigint, p_reason text, p_details text default ''
) returns bigint language plpgsql security definer set search_path=public as $$
declare rid bigint; pr smallint;
begin
  pr := case when p_reason in ('child_safety','sexual') then 1
             when p_reason in ('violence','self_harm') then 2 else 3 end;
  insert into reports(reporter_id,target_type,target_id,target_owner,reason,details,priority)
  values (p_user,p_type,p_target,p_owner,p_reason,left(coalesce(p_details,''),500),pr)
  on conflict (reporter_id,target_type,target_id) do update
    set reason=excluded.reason, priority=excluded.priority, status='open'
  returning id into rid;
  return rid;
end $$;

-- إصدار عقوبة (تصعيد تلقائي حسب العدد)
create or replace function issue_strike(
  p_admin bigint, p_user bigint, p_severity text, p_reason text, p_report bigint default null
) returns text language plpgsql security definer set search_path=public as $$
declare n int; act text;
begin
  if not is_admin(p_admin) then raise exception 'not admin'; end if;
  if p_severity='severe' then
    insert into strikes(user_id,severity,reason,report_id,issued_by) values (p_user,'severe',p_reason,p_report,p_admin);
    update profiles set status='banned', ban_reason=p_reason where id=p_user;
    insert into user_notices(user_id,kind,body) values (p_user,'ban','تم حظر الحساب نهائياً: '||p_reason);
    return 'ban';
  end if;
  select count(*) into n from strikes where user_id=p_user and not revoked;
  insert into strikes(user_id,severity,reason,report_id,issued_by) values (p_user,'minor',p_reason,p_report,p_admin);
  act := case n+1 when 1 then 'warn' when 2 then 'restrict24h' when 3 then 'suspend7d' else 'ban' end;
  update profiles set status = case act when 'ban' then 'banned' when 'suspend7d' then 'suspended'
      when 'restrict24h' then 'restricted' else 'active' end,
    restricted_until = case when act='restrict24h' then now()+interval '24 hours'
      when act='suspend7d' then now()+interval '7 days' else null end
  where id=p_user;
  insert into user_notices(user_id,kind,body) values (p_user,act,'إجراء جديد على حسابك: '||act);
  insert into mod_audit(admin_id,action,target_type,target_id,report_id)
    values (p_admin,act,'profile',p_user::text,p_report);
  return act;
end $$;

-- استئناف
create or replace function file_appeal(p_user bigint, p_strike bigint, p_message text)
returns bigint language plpgsql security definer set search_path=public as $$
declare aid bigint;
begin
  if length(coalesce(p_message,'')) not between 10 and 1000 then raise exception 'bad message'; end if;
  insert into appeals(user_id,strike_id,message) values (p_user,p_strike,p_message) returning id into aid;
  return aid;
end $$;

-- مراجعة الاستئناف (أدمن)
create or replace function review_appeal(p_admin bigint, p_appeal bigint, p_accept boolean)
returns void language plpgsql security definer set search_path=public as $$
declare a appeals%rowtype;
begin
  if not is_admin(p_admin) then raise exception 'not admin'; end if;
  select * into a from appeals where id=p_appeal;
  if not found then return; end if;
  update appeals set status=case when p_accept then 'accepted' else 'rejected' end, reviewed_by=p_admin where id=p_appeal;
  if p_accept then
    update strikes set revoked=true where id=a.strike_id;
    update profiles set status='active', restricted_until=null, ban_reason=null where id=a.user_id;
    insert into user_notices(user_id,kind,body) values (a.user_id,'appeal','تم قبول استئنافك ✅');
  end if;
  insert into mod_audit(admin_id,action,target_type,target_id) values (p_admin,
    case when p_accept then 'appeal_accept' else 'appeal_reject' end,'appeal',p_appeal::text);
end $$;

-- طابور المراجعة (أولوية)
create or replace function review_queue(p_admin bigint)
returns table (id bigint, priority smallint, reason text, target_type text, target_id text, created_at timestamptz)
language sql stable security definer set search_path=public as $$
  select r.id,r.priority,r.reason,r.target_type,r.target_id,r.created_at
  from reports r where is_admin(p_admin) and r.status='open'
  order by r.priority asc, r.created_at asc limit 100
$$;

-- إجراء على بلاغ
create or replace function action_report(
  p_admin bigint, p_report bigint, p_action text, p_note text default ''
) returns void language plpgsql security definer set search_path=public as $$
declare r reports%rowtype;
begin
  if not is_admin(p_admin) then raise exception 'not admin'; end if;
  select * into r from reports where id=p_report;
  if not found then return; end if;
  update reports set status=case when p_action='dismiss' then 'dismissed' else 'actioned' end,
    reviewed_by=p_admin, reviewed_at=now() where id=p_report;
  insert into mod_audit(admin_id,action,target_type,target_id,report_id,note)
    values (p_admin,p_action,r.target_type,r.target_id,p_report,p_note);
end $$;

grant execute on function submit_report,issue_strike,file_appeal,review_appeal,review_queue,action_report,is_admin to authenticated;
