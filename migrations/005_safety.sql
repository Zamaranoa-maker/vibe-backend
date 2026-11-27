-- ============================================================================
-- Migration 005 — Trust & Safety (adapted to bigint, لا يحذف بيانات)
-- ============================================================================

-- ===== إعدادات مركّزة =====
create table if not exists safety_config (
  key text primary key, value jsonb not null
);
insert into safety_config(key,value) values
  ('min_age','13'::jsonb),
  ('report_auto_hide_count','3'::jsonb),
  ('reporter_min_age_days','1'::jsonb),
  ('report_rate_per_hour','20'::jsonb),
  ('strike_expiry_days','90'::jsonb),
  ('appeal_window_days','14'::jsonb),
  ('new_creator_review_count','3'::jsonb),
  ('helplines','[{"label":"خط نجدة الطفل","number":"123"},{"label":"خط المساعدة","number":"8002226666"}]'::jsonb)
on conflict (key) do nothing;

create or replace function safety_cfg(p_key text) returns jsonb
language sql stable security definer set search_path=public as $$
  select value from safety_config where key=p_key
$$;

-- ===== الأدمن =====
create table if not exists admins (
  user_id bigint primary key references users(id) on delete cascade,
  role text not null default 'moderator' check (role in ('moderator','super'))
);
create or replace function is_admin(p_user bigint, min_role text default 'moderator')
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from admins where user_id=p_user
    and (min_role='moderator' or role='super'))
$$;
-- أضف نفسك: insert into admins values(<id>, 'super');

-- ===== البروفايل =====
alter table profiles add column if not exists age_tier text check (age_tier in ('13-15','16-17','18+'));
alter table profiles add column if not exists is_private boolean not null default false;
alter table profiles add column if not exists status text not null default 'active'
  check (status in ('active','restricted','suspended','banned'));
alter table profiles add column if not exists restricted_until timestamptz;
alter table profiles add column if not exists ban_reason text;

create table if not exists private_birthdates (
  user_id bigint primary key references users(id) on delete cascade,
  birth_date date not null,
  set_at timestamptz not null default now()
);

-- ===== البلاغات =====
create table if not exists reports (
  id bigserial primary key,
  reporter_id bigint references users(id) on delete set null,
  target_type text not null check (target_type in ('video','comment','profile','voice','live','message')),
  target_id text not null,
  target_owner bigint,
  reason text not null check (reason in
    ('child_safety','sexual','violence','hate','self_harm','drugs_weapons','scam','harassment','copyright','other')),
  details text check (length(details)<=500),
  priority smallint not null default 3,
  status text not null default 'open' check (status in ('open','actioned','dismissed')),
  created_at timestamptz not null default now(),
  reviewed_by bigint, reviewed_at timestamptz,
  unique (reporter_id,target_type,target_id)
);
create index if not exists idx_reports_open on reports(status,priority,created_at);
create index if not exists idx_reports_target on reports(target_type,target_id);

-- ===== العقوبات =====
create table if not exists strikes (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  severity text not null check (severity in ('minor','severe')),
  reason text, report_id bigint references reports(id),
  issued_by bigint, revoked boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);
create index if not exists idx_strikes_user on strikes(user_id) where not revoked;

create table if not exists appeals (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  strike_id bigint not null references strikes(id),
  message text not null check (length(message) between 10 and 1000),
  status text not null default 'open' check (status in ('open','accepted','rejected')),
  reviewed_by bigint, created_at timestamptz not null default now()
);

create table if not exists user_notices (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  kind text not null, body text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists mod_audit (
  id bigserial primary key,
  admin_id bigint not null, action text not null,
  target_type text, target_id text, report_id bigint, note text,
  created_at timestamptz not null default now()
);

-- سجل أدلة CSAM: بيانات وصفية فقط (مين/إيه/إمتى) — بدون أي محتوى
create table if not exists csam_evidence (
  id bigserial primary key,
  user_id bigint,
  target_type text not null,
  target_id text not null,
  report_id bigint,
  actioned_by bigint,
  ts timestamptz not null default now(),
  reported_to_authorities boolean not null default false
);
alter table csam_evidence enable row level security;  -- مفيش policies = أدمن بس عبر الدوال

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
-- مفيش policies على reports/strikes/admins = كله من خلال الدوال
drop policy if exists "own notices" on user_notices;
drop policy if exists "own strikes" on strikes;
drop policy if exists "own appeals" on appeals;
create policy "own notices" on user_notices for select using (user_id=(select id from users where external_id=current_setting('app.user',true)));
create policy "own strikes" on strikes for select using (user_id=(select id from users where external_id=current_setting('app.user',true)));
create policy "own appeals" on appeals for select using (user_id=(select id from users where external_id=current_setting('app.user',true)));

/* ===== الدوال ===== */

-- بوابة العمر
create or replace function set_birthdate(p_user bigint, p_birth date) returns text
language plpgsql security definer set search_path=public as $$
declare a int; tier text;
begin
  if exists(select 1 from private_birthdates where user_id=p_user) then raise exception 'ALREADY_SET'; end if;
  if p_birth > current_date then raise exception 'INVALID'; end if;
  a := extract(year from age(current_date,p_birth));
  if a > 110 then raise exception 'INVALID'; end if;
  if a < (safety_cfg('min_age'))::int then
    update profiles set status='banned', ban_reason='under_13' where id=p_user;
    return 'under_13';
  end if;
  tier := case when a<16 then '13-15' when a<18 then '16-17' else '18+' end;
  insert into private_birthdates(user_id,birth_date) values (p_user,p_birth);
  update profiles set age_tier=tier, is_private=(is_private or tier='13-15') where id=p_user;
  return tier;
end $$;

-- فحص النص
create or replace function text_check(t text) returns text
language sql stable security definer set search_path=public as $$
  select case
    when exists(select 1 from blocked_words where action='block'
      and position(normalize_ar(term) in normalize_ar(t))>0) then 'block'
    when exists(select 1 from blocked_words where action='review'
      and position(normalize_ar(term) in normalize_ar(t))>0) then 'review'
    else 'ok' end
$$;

create or replace function can_interact(p_user bigint) returns boolean
language sql stable security definer set search_path=public as $$
  select coalesce((select status='active' or (status in ('restricted','suspended') and restricted_until<now())
    from profiles where id=p_user),false)
$$;

-- البلاغات
create or replace function submit_report(
  p_user bigint,p_type text,p_target text,p_reason text,p_details text default ''
) returns bigint language plpgsql security definer set search_path=public as $$
declare rid bigint; owner bigint; pr smallint; n int;
begin
  if (select count(*) from reports where reporter_id=p_user and created_at>now()-interval '1 hour')
     >= (safety_cfg('report_rate_per_hour'))::int then raise exception 'RATE_LIMIT'; end if;
  owner := case p_type
    when 'video' then (select creator_id from videos where id=p_target::bigint)
    when 'comment' then (select user_id from comments where id=p_target::bigint)
    when 'profile' then p_target::bigint end;
  if owner is null then raise exception 'NOT_FOUND'; end if;
  if owner=p_user then raise exception 'SELF_REPORT'; end if;
  pr := case when p_reason='child_safety' then 1 when p_reason in ('sexual','violence','self_harm') then 2 else 3 end;
  insert into reports(reporter_id,target_type,target_id,target_owner,reason,details,priority)
  values (p_user,p_type,p_target,owner,p_reason,left(coalesce(p_details,''),500),pr)
  on conflict (reporter_id,target_type,target_id) do nothing
  returning id into rid;
  if not found then return null; end if;   -- بلاغ مكرر = متجاهل تماماً
  if p_type='video' then
    select count(distinct r.reporter_id) into n
    from reports r join users u on u.id=r.reporter_id
    where r.target_type='video' and r.target_id=p_target and r.status='open'
      and u.created_at < now() - ((safety_cfg('reporter_min_age_days'))::int||' days')::interval;
    if n >= (safety_cfg('report_auto_hide_count'))::int or p_reason='child_safety' then
      update videos set status='under_review' where id=p_target::bigint and status='approved';
    end if;
  end if;
  return rid;
end $$;

-- العقوبات
create or replace function apply_strike(
  p_user bigint,p_severity text,p_reason text,p_report bigint,p_admin bigint
) returns text language plpgsql security definer set search_path=public as $$
declare n int; outcome text;
begin
  if p_admin is null or not is_admin(p_admin) then raise exception 'FORBIDDEN'; end if;
  insert into strikes(user_id,severity,reason,report_id,issued_by,expires_at)
  values (p_user,p_severity,p_reason,p_report,p_admin,
    now()+((safety_cfg('strike_expiry_days'))::int||' days')::interval);
  if p_severity='severe' then outcome:='ban';
  else
    select count(*) into n from strikes where user_id=p_user and severity='minor'
      and not revoked and expires_at>now();
    outcome := case when n<=1 then 'warn' when n=2 then 'restrict24h'
                    when n=3 then 'suspend7d' else 'ban' end;
  end if;
  if outcome='restrict24h' then update profiles set status='restricted',restricted_until=now()+interval '24 hours' where id=p_user;
  elsif outcome='suspend7d' then update profiles set status='suspended',restricted_until=now()+interval '7 days' where id=p_user;
  elsif outcome='ban' then update profiles set status='banned',restricted_until=null,ban_reason='policy' where id=p_user; end if;
  insert into user_notices(user_id,kind,body) values (p_user,outcome,p_reason);
  return outcome;
end $$;

-- إجراء أدمن
create or replace function admin_action(p_admin bigint,p_report bigint,p_action text,p_note text default '')
returns text language plpgsql security definer set search_path=public as $$
declare r reports%rowtype; outcome text:='ok';
begin
  if not is_admin(p_admin) then raise exception 'FORBIDDEN'; end if;
  select * into r from reports where id=p_report for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_action='dismiss' then
    update videos set status='approved' where id=r.target_id::bigint and status='under_review' and r.target_type='video';
    update comments set status='approved' where id=r.target_id::bigint and status='under_review' and r.target_type='comment';
    update reports set status='dismissed',reviewed_by=p_admin,reviewed_at=now() where id=p_report;
  elsif p_action in ('remove','remove_severe','age_restrict') then
    if p_action='remove_severe' and not is_admin(p_admin,'super') then raise exception 'FORBIDDEN'; end if;

    -- 🚨 CSAM: إجراء ثابت — حذف فوري، مفيش رجوع، وسجل أدلة بس (مين/إيه/إمتى)
    if p_action='remove_severe' and r.reason='child_safety' then
      insert into csam_evidence(user_id,target_type,target_id,report_id,actioned_by,ts)
      values (r.target_owner,r.target_type,r.target_id,r.id,p_admin,now());
      -- امسح مراجع المحتوى من قاعدة البيانات (الملف الفعلي في R2 بيتحذف في الـ Edge Function)
      delete from video_hashtags where video_id=r.target_id::bigint and r.target_type='video';
      delete from video_stats   where video_id=r.target_id::bigint and r.target_type='video';
      delete from videos        where id=r.target_id::bigint and r.target_type='video';
      -- لا نحتفظ بأي نسخة من المحتوى
    else
      update videos set status=case when p_action='age_restrict' then 'age_restricted' else 'removed' end
        where id=r.target_id::bigint and r.target_type='video';
      update comments set status='removed' where id=r.target_id::bigint and r.target_type='comment';
    end if;
    if r.target_owner is not null then
      if p_action='age_restrict' then
        insert into user_notices(user_id,kind,body) values (r.target_owner,'age_restricted',coalesce(p_note,r.reason));
      else outcome:=apply_strike(r.target_owner, case when p_action='remove_severe' then 'severe' else 'minor' end,
        coalesce(p_note,r.reason),r.id,p_admin); end if;
    end if;
    update reports set status='actioned',reviewed_by=p_admin,reviewed_at=now() where id=p_report;
  else raise exception 'BAD_ACTION'; end if;
  insert into mod_audit(admin_id,action,target_type,target_id,report_id,note)
    values (p_admin,p_action,r.target_type,r.target_id,p_report,p_note);
  return outcome;
end $$;

-- طابور المراجعة
create or replace function get_mod_queue(p_admin bigint,p_limit int default 30)
returns table(target_type text,target_id text,target_owner bigint,reasons text[],reports int,
              top_priority smallint,oldest timestamptz,report_id bigint)
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_admin(p_admin) then raise exception 'FORBIDDEN'; end if;
  return query
    select r.target_type,r.target_id,max(r.target_owner),array_agg(distinct r.reason),
      count(*)::int,min(r.priority),min(r.created_at),min(r.id)
    from reports r where r.status='open'
    group by r.target_type,r.target_id
    order by min(r.priority),count(*) desc,min(r.created_at) limit least(p_limit,100);
end $$;

-- استئناف
create or replace function submit_appeal(p_user bigint,p_strike bigint,p_message text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from strikes where id=p_strike and user_id=p_user
    and created_at>now()-((safety_cfg('appeal_window_days'))::int||' days')::interval)
    then raise exception 'NOT_ALLOWED'; end if;
  if exists(select 1 from appeals where strike_id=p_strike) then raise exception 'ALREADY_APPEALED'; end if;
  insert into appeals(user_id,strike_id,message) values (p_user,p_strike,p_message);
end $$;

create or replace function admin_resolve_appeal(p_admin bigint,p_appeal bigint,p_accept boolean)
returns void language plpgsql security definer set search_path=public as $$
declare a appeals%rowtype;
begin
  if not is_admin(p_admin,'super') then raise exception 'FORBIDDEN'; end if;
  select * into a from appeals where id=p_appeal and status='open' for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_accept then
    update strikes set revoked=true where id=a.strike_id;
    update profiles set status='active',restricted_until=null where id=a.user_id and ban_reason<>'under_13';
  end if;
  update appeals set status=case when p_accept then 'accepted' else 'rejected' end,reviewed_by=p_admin where id=p_appeal;
  insert into user_notices(user_id,kind,body) values (a.user_id,
    case when p_accept then 'appeal_accepted' else 'appeal_rejected' end,
    case when p_accept then 'تم قبول الاستئناف' else 'تم رفض الاستئناف' end);
  insert into mod_audit(admin_id,action,target_type,target_id) values (p_admin,
    'appeal_'||case when p_accept then 'accepted' else 'rejected' end,'appeal',p_appeal::text);
end $$;

grant execute on function set_birthdate,text_check,can_interact,submit_report,apply_strike,
  admin_action,get_mod_queue,submit_appeal,admin_resolve_appeal,is_admin,safety_cfg to authenticated;
