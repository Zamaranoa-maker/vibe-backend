/* ============================================================================
   For You v1 final — ranked/explore/following/fallback + diversity
   adapted: p_user bigint بدل auth.uid()
   ========================================================================== */

-- جدول المتابعات لو مش موجود
create table if not exists follows (
  follower_id bigint not null references users(id),
  followee_id bigint not null references users(id),
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id)
);

-- recompute_scores (Bayesian + decay + stage upgrade)
create or replace function recompute_scores() returns void language plpgsql as $$
declare med double precision;
begin
  update video_stats s set
    quality =
        0.40 * (s.completions + 7.0) / (s.views + 20.0)
      + 1.50 * (s.likes       + 1.0) / (s.views + 20.0)
      + 3.00 * (s.shares      + 0.2) / (s.views + 20.0)
      + 2.00 * (s.comments    + 0.4) / (s.views + 20.0)
      - 0.30 * (s.skips       + 6.0) / (s.impressions + 20.0);

  update video_stats s set
    score = greatest(s.quality, 0.0001)
            * (0.25 + 0.75 * power(0.5, extract(epoch from now() - v.created_at) / 172800.0)),
    updated_at = now()
  from videos v where v.id = s.video_id;

  select percentile_cont(0.5) within group (order by quality) into med
  from video_stats where impressions >= 30;

  update video_stats set stage = stage + 1
  where stage < 3
    and impressions >= (array[30, 100, 400])[stage + 1]
    and quality >= coalesce(med, 0);
end $$;

-- get_for_you بالمعامل p_user
create or replace function get_for_you(
  p_user bigint, p_limit int default 20, p_exclude bigint[] default '{}'
) returns table (video_id bigint, source text)
language sql volatile security definer set search_path = public as $$
  with
  me as (select p_user as uid),
  scored as (
    select v.id, v.creator_id, v.created_at, s.stage, s.impressions,
           (f.followee_id is not null) as is_following,
           s.score
             * (1 + 0.25 * least(greatest(coalesce(i.weight, 0), 0), 4))
             * (case when f.followee_id is not null then 1.3 else 1 end)
             as final
    from videos v
    join video_stats s on s.video_id = v.id
    cross join me
    left join user_interests i on i.user_id = me.uid and i.category = v.category
    left join follows f on f.follower_id = me.uid and f.followee_id = v.creator_id
    where v.status = 'approved' and v.visibility = 'public'
      and v.creator_id <> me.uid
      and v.created_at > now() - interval '30 days'
      and v.id <> all (p_exclude)
      and not exists (select 1 from user_video_state u
                      where u.user_id = me.uid and u.video_id = v.id)
      and not exists (select 1 from blocks b
                      where (b.blocker_id = me.uid and b.blocked_id = v.creator_id)
                         or (b.blocker_id = v.creator_id and b.blocked_id = me.uid))
  ),
  ranked  as (select id, creator_id, 'ranked'::text as src,
                     row_number() over (order by final * (0.8 + 0.4 * random()) desc) as rk
              from scored where stage >= 3),
  explore as (select id, creator_id, 'explore'::text,
                     row_number() over (order by random())
              from scored
              where stage < 3 and impressions < (array[30, 100, 400])[stage + 1]),
  follow  as (select id, creator_id, 'following'::text,
                     row_number() over (order by created_at desc)
              from scored where is_following),
  fallb   as (select id, creator_id, 'fallback'::text,
                     row_number() over (order by final desc)
              from scored),
  pool    as (select * from ranked union all select * from explore
              union all select * from follow union all select * from fallb),
  dedup   as (select distinct on (id) id, creator_id, src, rk from pool
              order by id,
                       case src when 'following' then 0 when 'explore' then 1
                                when 'ranked' then 2 else 3 end, rk),
  diverse as (select *, row_number() over (partition by creator_id order by rk) as c_rn from dedup)
  select id, src
  from diverse
  where c_rn <= 2
  order by rk / (case src when 'ranked' then 0.55 when 'explore' then 0.25
                          when 'following' then 0.20 else 0.03 end)
  limit p_limit;
$$;
