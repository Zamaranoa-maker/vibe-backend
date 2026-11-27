-- Migration 010 — indexes إضافية + تنضيف يومي للجلسات ومحاولات الدخول
-- متكيّف على bigint (زي باقي قاعدتنا). لا يحذف بيانات.

create index if not exists idx_login_attempts_user_time on login_attempts (username, created_at);
create index if not exists idx_login_attempts_ip_time on login_attempts (ip, created_at);
create unique index if not exists users_username_uq on users (username);

-- جدولة التنضيف: pg_cron لو متاح، والا Edge Function مجدولة
do $outer$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
    perform extensions.cron.schedule('clean-auth', '0 4 * * *', $cron$
      delete from login_attempts where created_at < now() - interval '2 days';
      delete from sessions where expires_at < now() - interval '1 day' or revoked;
    $cron$);
    raise notice 'cron clean-auth scheduled';
  exception when others then
    raise notice 'pg_cron غير متاح — استخدم Edge Function مجدولة للتنضيف';
  end;
end $outer$;
