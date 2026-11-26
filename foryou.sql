/* ============================================================================
   For You v1 — حقن إحصائيات + اختبار مرحلي + منع غش + RLS
   ملاحظة: user_id bigint (متوافق مع جدول users الحالي)
   ========================================================================== */

create table if not exists videos (
  id           bigserial primary key,
  creator_id   bigint not null references users(id),
  category     text not null default 'general',
  status       text not null default 'approved',
  visibility   text not null default 'public',
  created_at   timestamptz not null default now(),
  duration_ms  bigint not null default 15000,
  file         text,
  caption      text
);

create table if not exists video_stats (
  video_id       bigint primary key references videos(id) on delete cascade,
  impressions    int  not null default 0,
  views          int  not null default 0,   -- اتفرج 2 ثانية أو أكتر
  skips          int  not null default 0,   -- سابه قبل 2 ثانية
  completions    int  not null default 0,   -- وصل 90%+ أو عاد يشوفه
  likes          int  not null default 0,
  comments       int  not null default 0,
  shares         int  not null default 0,
  total_watch_ms bigint not null default 0,
  quality        double precision not null default 0,
  score          double precision not null default 0,
  stage          smallint not null default 0,   -- 0,1,2 = اختبار | 3 = مفتوح للكل
  updated_at     timestamptz not null default now()
);

create or replace function init_video_stats() returns trigger language plpgsql as $$
begin
  insert into video_stats(video_id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists trg_init_stats on videos;
create trigger trg_init_stats after insert on videos
for each row execute function init_video_stats();

create table if not exists user_video_state (
  user_id        bigint  not null references users(id),
  video_id       bigint  not null references videos(id) on delete cascade,
  counted        boolean not null default false,
  watched_ratio  real    not null default 0,
  liked          boolean not null default false,
  commented      boolean not null default false,
  shared         boolean not null default false,
  not_interested boolean not null default false,
  first_seen     timestamptz not null default now(),
  primary key (user_id, video_id)
);

create table if not exists user_interests (
  user_id  bigint not null references users(id),
  category text   not null,
  weight   double precision not null default 0,
  primary key (user_id, category)
);

-- أمان: العميل ما يكتبش مباشرة، كله من خلال الدوال
alter table video_stats      enable row level security;
alter table user_video_state enable row level security;
alter table user_interests   enable row level security;
-- من غير policies = مفيش وصول مباشر. الدوال security definer.

/* ---------------------------------------------------------------------------
   تسجيل حدث مشاهدة/تفاعل (من السيرفر فقط)
   --------------------------------------------------------------------------- */
create or replace function record_video_event(
  p_user bigint, p_video bigint, p_event text,
  p_watch_ms bigint default 0, p_ratio real default 0
) returns void language plpgsql security definer as $$
declare
  st user_video_state%rowtype;
begin
  insert into user_video_state(user_id, video_id)
    values (p_user, p_video) on conflict do nothing;
  select * into st from user_video_state where user_id=p_user and video_id=p_video;

  if p_event = 'impression' then
    update video_stats set impressions=impressions+1, updated_at=now() where video_id=p_video;

  elsif p_event = 'view' then
    -- مشاهدة واحدة محتسبة لكل مستخدم (منع غش)
    if not st.counted and p_watch_ms >= 2000 then
      update video_stats set views=views+1, total_watch_ms=total_watch_ms+p_watch_ms, updated_at=now()
        where video_id=p_video;
      update user_video_state set counted=true where user_id=p_user and video_id=p_video;
    elsif p_watch_ms < 2000 and not st.counted then
      update video_stats set skips=skips+1, updated_at=now() where video_id=p_video;
    end if;
    update user_video_state set watched_ratio=greatest(watched_ratio, p_ratio)
      where user_id=p_user and video_id=p_video;

  elsif p_event = 'complete' then
    update video_stats set completions=completions+1, total_watch_ms=total_watch_ms+p_watch_ms, updated_at=now()
      where video_id=p_video;
    update user_video_state set watched_ratio=1 where user_id=p_user and video_id=p_video;

  elsif p_event = 'like' then
    if not st.liked then
      update video_stats set likes=likes+1, updated_at=now() where video_id=p_video;
      update user_video_state set liked=true where user_id=p_user and video_id=p_video;
    end if;

  elsif p_event = 'comment' then
    if not st.commented then
      update video_stats set comments=comments+1, updated_at=now() where video_id=p_video;
      update user_video_state set commented=true where user_id=p_user and video_id=p_video;
    end if;

  elsif p_event = 'share' then
    if not st.shared then
      update video_stats set shares=shares+1, updated_at=now() where video_id=p_video;
      update user_video_state set shared=true where user_id=p_user and video_id=p_video;
    end if;

  elsif p_event = 'not_interested' then
    update user_video_state set not_interested=true where user_id=p_user and video_id=p_video;
  end if;

  perform refresh_video_score(p_video);

  -- وزن اهتمام المستخدم بالفئة
  if p_event in ('view','complete','like') then
    insert into user_interests(user_id, category, weight)
      select p_user, v.category, case p_event when 'complete' then 2 else 1 end
      from videos v where v.id=p_video
      on conflict (user_id, category) do update set weight=least(20, user_interests.weight+excluded.weight);
  end if;
end $$;

/* ---------------------------------------------------------------------------
   حساب الجودة والسكور + ترقية المرحلة
   --------------------------------------------------------------------------- */
create or replace function refresh_video_score(p_video bigint) returns void
language plpgsql security definer as $$
declare
  s video_stats%rowtype;
  q double precision;
  rate double precision;
begin
  select * into s from video_stats where video_id=p_video;
  if not found then return; end if;

  rate := case when s.views>0 then s.completions::double precision/s.views else 0 end;
  q := rate*0.45
     + (case when s.views>0 then least(1, s.likes::double precision/s.views*5) else 0 end)*0.2
     + (case when s.impressions>0 then least(1, s.views::double precision/s.impressions) else 0 end)*0.2
     + (case when s.views>0 then least(1, s.shares::double precision/s.views*3) else 0 end)*0.15;

  -- ترقية المرحلة حسب التعرّض
  if s.stage=0 and s.impressions>=100 then s.stage:=1;
  elsif s.stage=1 and s.impressions>=300 then s.stage:=2;
  elsif s.stage=2 and s.impressions>=1000 and q>=0.35 then s.stage:=3;
  end if;

  update video_stats set quality=round(q::numeric,4), score=round((q*case s.stage when 0 then 1.3 when 1 then 1.2 when 2 then 1.1 else 1 end)::numeric,4),
    stage=s.stage, updated_at=now()
  where video_id=p_video;
end $$;

/* ---------------------------------------------------------------------------
   For You feed — تنويع + اهتمامات + استبعاد non-interest
   --------------------------------------------------------------------------- */
create or replace function get_foryou(p_user bigint, p_limit int default 20)
returns table (video_id bigint, score double precision, stage smallint)
language plpgsql security definer as $$
begin
  return query
  with candidates as (
    select v.id as vid, s.score, s.stage, v.category, v.creator_id,
      coalesce((select weight from user_interests ui where ui.user_id=p_user and ui.category=v.category),0) as interest,
      row_number() over (
        partition by v.creator_id
        order by (s.score + least(
          coalesce((select weight from user_interests ui where ui.user_id=p_user and ui.category=v.category),0)
        ,5)*0.05) desc
      ) as rn
    from videos v
    join video_stats s on s.video_id=v.id
    where v.status='approved' and v.visibility='public'
      and s.stage>=0
      and not exists (
        select 1 from user_video_state u
        where u.user_id=p_user and u.video_id=v.id and u.not_interested
      )
  )
  select c.vid, c.score, c.stage
  from candidates c
  where c.rn<=2                      -- تنويع: max 2 لكل صانع
  order by (c.score + least(
    coalesce((select weight from user_interests ui where ui.user_id=p_user and ui.category=c.category),0)
  ,5)*0.05) desc, c.stage asc
  limit p_limit;
end $$;
