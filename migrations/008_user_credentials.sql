-- Migration 008 — يوزر + باسورد (مشفر بنظام scrypt) لحساب الأدمن
alter table users add column if not exists username text unique;
alter table users add column if not exists password_hash text;

-- بروفايل للمستخدمين اللي ليهم يوزر
update profiles p set username = u.username, display_name = u.username
from users u where p.id = u.id and u.username is not null;
