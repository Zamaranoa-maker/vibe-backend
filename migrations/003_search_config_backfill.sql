-- Migration 003 — إعدادات البحث المركّزة + backfill للفيديوهات الموجودة

create table if not exists search_config (key text primary key, value jsonb not null, note text);
insert into search_config(key,value,note) values
  ('min_creators_for_trending','3'::jsonb,'أقل عدد مبدعينdifferent'),
  ('trending_window_days','3'::jsonb,'نافذة الترند بالأيام'),
  ('recent_window_hours','12'::jsonb,'آخر 12 ساعة'),
  ('trending_limit','50'::jsonb,'أقصى عدد هاشتاجات'),
  ('max_hashtags_per_video','10'::jsonb,'أقصى هاشتاجات للفيديو'),
  ('weights','{"creator":3.0,"recent":2.0,"views":1.0,"tag_exact":1.5,"score":10.0}'::jsonb,'أوزان الترتيب'),
  ('helplines','[{"label":"خط نجدة الطفل","number":"123"},{"label":"خط المساعدة","number":"8002226666"}]'::jsonb,'خطوط مساعدة')
on conflict (key) do nothing;

create or replace function search_cfg(p_key text) returns jsonb
language sql stable security definer set search_path=public as $$
  select value from search_config where key=p_key
$$;

update videos set search_text=normalize_ar(coalesce(caption,''))
where search_text is null or search_text='';

do $$
declare v record; t text; hid bigint;
begin
  for v in select id,caption from videos where coalesce(caption,'')<>'' loop
    for t in
      select distinct normalize_ar(m[1])
      from regexp_matches(v.caption,'#([A-Za-z0-9_؀-ۿ]{2,40})','g') as m
      limit 10
    loop
      insert into hashtags(tag) values (t) on conflict (tag) do nothing;
      select id into hid from hashtags where tag=t and not banned;
      if hid is not null then
        insert into video_hashtags(video_id,hashtag_id) values (v.id,hid) on conflict do nothing;
      end if;
    end loop;
  end loop;
end $$;

do $$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
    perform extensions.cron.schedule('refresh-trending','*/30 * * * *',
      'refresh materialized view concurrently trending_hashtags');
  exception when others then
    raise notice 'pg_cron غير متاح — استخدم Edge Function مجدولة';
  end;
end $$;
