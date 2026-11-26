/* ============================================================================
   For You events — adapted to bigint user ids (بدل auth.uid())
   نفس المنطق: أول مشاهدة بس، تفاعل مرة واحدة، "مش مهتم" يقلّل الوزن
   ========================================================================== */

-- بتتنادى لما المستخدم يسيب الفيديو (سوايب)
create or replace function report_view(
  p_user bigint, p_video bigint, p_watch_ms int, p_ratio real
) returns void language plpgsql security definer set search_path = public as $$
declare
  v   record;
  n   int;
  r   real;
  delta double precision;
begin
  if p_user is null then return; end if;
  select creator_id, category into v from videos where id = p_video and status = 'approved';
  if not found or v.creator_id = p_user then return; end if;   -- مفيش احتساب لفيديوهاتك

  r := least(greatest(p_ratio, 0), 3);

  -- أول مشاهدة بس هي اللي بتتحسب
  insert into user_video_state(user_id, video_id, watched_ratio, counted)
  values (p_user, p_video, least(r, 1), true)
  on conflict (user_id, video_id) do update
    set watched_ratio = excluded.watched_ratio, counted = true
    where not user_video_state.counted;
  get diagnostics n = row_count;
  if n = 0 then return; end if;

  update video_stats set
    impressions    = impressions + 1,
    views          = views + (p_watch_ms >= 2000)::int,
    skips          = skips + (p_watch_ms < 2000)::int,
    completions    = completions + (r >= 0.9)::int,
    total_watch_ms = total_watch_ms + least(greatest(p_watch_ms, 0), 120000)
  where video_id = p_video;

  delta := case when p_watch_ms < 2000 then -0.2 else least(r, 1) end;
  if v.category is not null then
    insert into user_interests(user_id, category, weight) values (p_user, v.category, delta)
    on conflict (user_id, category) do update
      set weight = greatest(-2, least(6, user_interests.weight * 0.98 + excluded.weight));
  end if;

  perform refresh_video_score(p_video);
end $$;

-- like | comment | share (مرة واحدة لكل مستخدم لكل فيديو)
create or replace function bump_engagement(
  p_user bigint, p_video bigint, p_kind text
) returns void language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if p_user is null then return; end if;
  select creator_id, category into v from videos where id = p_video and status = 'approved';
  if not found or v.creator_id = p_user then return; end if;

  insert into user_video_state(user_id, video_id) values (p_user, p_video) on conflict do nothing;

  if    p_kind = 'like'    then update user_video_state set liked     = true where user_id = p_user and video_id = p_video and not liked;
  elsif p_kind = 'comment' then update user_video_state set commented = true where user_id = p_user and video_id = p_video and not commented;
  elsif p_kind = 'share'   then update user_video_state set shared    = true where user_id = p_user and video_id = p_video and not shared;
  else raise exception 'bad kind'; end if;
  if not found then return; end if;

  update video_stats set
    likes    = likes    + (p_kind = 'like')::int,
    comments = comments + (p_kind = 'comment')::int,
    shares   = shares   + (p_kind = 'share')::int
  where video_id = p_video;

  if v.category is not null then
    insert into user_interests(user_id, category, weight) values (p_user, v.category, 1)
    on conflict (user_id, category) do update
      set weight = least(6, user_interests.weight + 1);
  end if;

  perform refresh_video_score(p_video);
end $$;

-- "مش مهتم"
create or replace function mark_not_interested(
  p_user bigint, p_video bigint
) returns void language plpgsql security definer set search_path = public as $$
declare cat text;
begin
  if p_user is null then return; end if;
  insert into user_video_state(user_id, video_id, not_interested) values (p_user, p_video, true)
  on conflict (user_id, video_id) do update set not_interested = true;
  select category into cat from videos where id = p_video;
  if cat is not null then
    insert into user_interests(user_id, category, weight) values (p_user, cat, -1.5)
    on conflict (user_id, category) do update
      set weight = greatest(-2, user_interests.weight - 1.5);
  end if;
end $$;
