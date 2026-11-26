-- ============================================================================
-- VIBE+ Migration 002 — Search + Hashtags + Trending + For You
-- لا يحذف أي بيانات موجودة. كل شيء IF NOT EXISTS / CREATE OR REPLACE
-- ============================================================================

create extension if not exists pg_trgm with schema extensions;

create or replace function normalize_ar(t text) returns text
language sql immutable as $$
  select lower(regexp_replace(
    translate(coalesce(t,''), 'أإآٱىةؤئ', 'اااايهوي'),
    '[ًٌٍَُِّْـ]', '', 'g'))
$$;

alter table videos add column if not exists caption text;
alter table videos add column if not exists search_text text;
create index if not exists idx_videos_search on videos using gin (search_text extensions.gin_trgm_ops);

create table if not exists profiles (
  id bigint primary key references users(id) on delete cascade,
  username text, display_name text, avatar_url text,
  created_at timestamptz not null default now()
);
insert into profiles(id,username,display_name) select id,external_id,external_id from users
on conflict (id) do nothing;
create index if not exists idx_profiles_search on profiles
  using gin (normalize_ar(coalesce(username,'')||' '||coalesce(display_name,'')) extensions.gin_trgm_ops);

create table if not exists hashtags (
  id bigserial primary key, tag text not null unique, banned boolean not null default false
);
create index if not exists idx_hashtags_trgm on hashtags using gin (tag extensions.gin_trgm_ops);

create table if not exists video_hashtags (
  video_id bigint not null references videos(id) on delete cascade,
  hashtag_id bigint not null references hashtags(id),
  primary key (video_id, hashtag_id)
);
create index if not exists idx_video_hashtags_tag on video_hashtags (hashtag_id);

create table if not exists blocked_search_terms (
  term text primary key,
  action text not null default 'hide' check (action in ('hide','support'))
);
insert into blocked_search_terms(term,action) values
  ('انتحار','support'),('self harm','support'),('suicide','support')
on conflict (term) do nothing;

alter table hashtags enable row level security;
alter table video_hashtags enable row level security;
alter table blocked_search_terms enable row level security;

create or replace function videos_search_sync() returns trigger language plpgsql as $$
begin new.search_text := normalize_ar(new.caption); return new; end $$;
drop trigger if exists trg_videos_search_sync on videos;
create trigger trg_videos_search_sync before insert or update of caption on videos
for each row execute function videos_search_sync();

create or replace function videos_hashtag_sync() returns trigger
language plpgsql security definer set search_path=public as $$
declare t text; hid bigint;
begin
  delete from video_hashtags where video_id=new.id;
  for t in
    select distinct normalize_ar(m[1])
    from regexp_matches(coalesce(new.caption,''),'#([A-Za-z0-9_؀-ۿ]{2,40})','g') as m
    limit 10
  loop
    insert into hashtags(tag) values (t) on conflict (tag) do nothing;
    select id into hid from hashtags where tag=t and not banned;
    if hid is not null then insert into video_hashtags values (new.id,hid) on conflict do nothing; end if;
  end loop;
  return new;
end $$;
drop trigger if exists trg_videos_hashtag_sync on videos;
create trigger trg_videos_hashtag_sync after insert or update of caption on videos
for each row execute function videos_hashtag_sync();

create or replace function search_guard(q text) returns text
language sql stable security definer set search_path=public as $$
  select coalesce((select action from blocked_search_terms
    where normalize_ar(q) like '%'||normalize_ar(term)||'%' limit 1),'ok')
$$;

create or replace function search_videos(p_user bigint,q text,p_limit int default 20,p_offset int default 0)
returns table(video_id bigint,rank double precision)
language sql stable security definer set search_path=public,extensions as $$
  with qn as (select normalize_ar(trim(both '# ' from q)) as n)
  select v.id,
    (2.0*greatest(similarity(v.search_text,qn.n),word_similarity(qn.n,v.search_text))
     + case when exists(select 1 from video_hashtags vh join hashtags h on h.id=vh.hashtag_id
                        where vh.video_id=v.id and h.tag=qn.n) then 1.5 else 0 end
     + least(s.score*10,1.0)) as rank
  from videos v join video_stats s on s.video_id=v.id cross join qn
  where length(qn.n)>=2 and search_guard(q)='ok'
    and v.status='approved' and v.visibility='public'
    and (qn.n <% v.search_text or exists(select 1 from video_hashtags vh join hashtags h on h.id=vh.hashtag_id
                        where vh.video_id=v.id and h.tag=qn.n))
    and not exists(select 1 from blocks b where (b.blocker_id=p_user and b.blocked_id=v.creator_id)
                                            or (b.blocker_id=v.creator_id and b.blocked_id=p_user))
  order by rank desc limit least(p_limit,50) offset greatest(p_offset,0)
$$;

create or replace function search_users(p_user bigint,q text,p_limit int default 20)
returns table(id bigint,username text,display_name text,avatar_url text)
language sql stable security definer set search_path=public,extensions as $$
  with qn as (select normalize_ar(trim(q)) as n)
  select p.id,p.username,p.display_name,p.avatar_url
  from profiles p cross join qn
  where length(qn.n)>=2 and search_guard(q)='ok'
    and normalize_ar(coalesce(p.username,'')||' '||coalesce(p.display_name,'')) like '%'||qn.n||'%'
    and p.id<>p_user
    and not exists(select 1 from blocks b where (b.blocker_id=p_user and b.blocked_id=p.id)
                                            or (b.blocker_id=p.id and b.blocked_id=p_user))
  order by similarity(normalize_ar(p.username),qn.n) desc limit least(p_limit,30)
$$;

create or replace function search_suggest(q text)
returns table(kind text,label text)
language sql stable security definer set search_path=public,extensions as $$
  with qn as (select normalize_ar(trim(both '# ' from q)) as n)
  (select 'hashtag','#'||h.tag from hashtags h cross join qn
   where length(qn.n)>=2 and not h.banned and h.tag like qn.n||'%' and search_guard(q)='ok'
   order by (select count(*) from video_hashtags vh where vh.hashtag_id=h.id) desc limit 5)
  union all
  (select 'user',p.username from profiles p cross join qn
   where length(qn.n)>=2 and normalize_ar(p.username) like qn.n||'%' and search_guard(q)='ok' limit 4)
$$;

create or replace function get_hashtag_videos(p_user bigint,p_tag text,p_limit int default 20,p_offset int default 0)
returns table(video_id bigint)
language sql stable security definer set search_path=public as $$
  select v.id from hashtags h join video_hashtags vh on vh.hashtag_id=h.id
  join videos v on v.id=vh.video_id join video_stats s on s.video_id=v.id
  where h.tag=normalize_ar(trim(both '# ' from p_tag)) and not h.banned
    and v.status='approved' and v.visibility='public'
    and not exists(select 1 from blocks b where (b.blocker_id=p_user and b.blocked_id=v.creator_id)
                                            or (b.blocker_id=v.creator_id and b.blocked_id=p_user))
  order by s.score desc limit least(p_limit,50) offset greatest(p_offset,0)
$$;

drop materialized view if exists trending_hashtags;
create materialized view trending_hashtags as
with recent as (
  select vh.hashtag_id, count(distinct v.creator_id) as creators, count(*) as videos,
         coalesce(sum(s.views),0) as views,
         count(*) filter (where v.created_at>now()-interval '12 hours') as last12h
  from video_hashtags vh join videos v on v.id=vh.video_id join video_stats s on s.video_id=v.id
  where v.status='approved' and v.visibility='public' and v.created_at>now()-interval '3 days'
  group by vh.hashtag_id
)
select h.id as hashtag_id,h.tag,r.creators,r.videos,r.views,
  (r.creators*3.0+r.last12h*2.0+ln(1+r.views)) as trend_score
from recent r join hashtags h on h.id=r.hashtag_id and not h.banned
where r.creators>=3
order by trend_score desc limit 50;
create unique index if not exists idx_trending_hashtags on trending_hashtags(hashtag_id);

create or replace function get_trending_hashtags(p_limit int default 15)
returns table(tag text,creators int,videos int,trend_score double precision)
language sql stable security definer set search_path=public as $$
  select tag,creators::int,videos::int,trend_score from trending_hashtags
  order by trend_score desc limit least(p_limit,30)
$$;

create or replace function get_trending_videos(p_user bigint,p_limit int default 20,p_offset int default 0)
returns table(video_id bigint)
language sql stable security definer set search_path=public as $$
  select v.id from videos v join video_stats s on s.video_id=v.id
  where v.status='approved' and v.visibility='public'
    and v.created_at>now()-interval '3 days' and s.impressions>=20
    and not exists(select 1 from blocks b where (b.blocker_id=p_user and b.blocked_id=v.creator_id)
                                            or (b.blocker_id=v.creator_id and b.blocked_id=p_user))
  order by s.score desc limit least(p_limit,50) offset greatest(p_offset,0)
$$;

grant execute on function search_videos,search_users,search_suggest,get_hashtag_videos,
  get_trending_hashtags,get_trending_videos to authenticated;
