-- ============================================================================
-- Migration 007 — حماية الحقول الحساسة (status) على الفيديوهات والتعليقات
-- لا يحذف أي بيانات. يمنع العميل من تغيير status مباشرة.
-- ============================================================================

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

create or replace function videos_guard() returns trigger
language plpgsql security definer set search_path=public as $$
declare c text;
begin
  if tg_op='INSERT' then
    if not can_interact(new.creator_id) then raise exception 'ACCOUNT_RESTRICTED'; end if;
    new.status := 'pending';
  elsif new.status is distinct from old.status and current_user in ('authenticated','anon') then
    raise exception 'FORBIDDEN';
  end if;
  c := text_check(new.caption);
  if c='block' then raise exception 'CONTENT_BLOCKED'; end if;
  if c='review' and new.status='approved' then new.status := 'under_review'; end if;
  return new;
end $$;
drop trigger if exists trg_videos_guard on videos;
create trigger trg_videos_guard before insert or update on videos
for each row execute function videos_guard();

create or replace function comments_guard() returns trigger
language plpgsql security definer set search_path=public as $$
declare c text;
begin
  if tg_op='UPDATE' then
    if new.status is distinct from old.status and current_user in ('authenticated','anon') then
      raise exception 'FORBIDDEN';
    end if;
    return new;
  end if;
  if not can_interact(new.user_id) then raise exception 'ACCOUNT_RESTRICTED'; end if;
  c := text_check(new.body);
  if c='block' then raise exception 'CONTENT_BLOCKED'; end if;
  new.status := case when c='review' then 'under_review' else 'approved' end;
  return new;
end $$;
drop trigger if exists trg_comments_guard on comments;
create trigger trg_comments_guard before insert or update on comments
for each row execute function comments_guard();

grant execute on function text_check,can_interact to authenticated;
