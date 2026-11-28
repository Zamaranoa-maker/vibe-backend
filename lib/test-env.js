/* ============================================================================
   test-env.js — بوابة الأمان للاختبارات
   تمنع أي اختبار من لمس قاعدة الإنتاج. لازم TEST_DATABASE_URL منفصل تماماً.
   ========================================================================== */
'use strict';
require('./env');

const prod = process.env.DATABASE_URL || '';
const test = process.env.TEST_DATABASE_URL || '';
const hostOf = s => { try { return new URL(s).hostname.toLowerCase(); } catch (e) { return ''; } };
const prodHost = hostOf(prod), testHost = hostOf(test);

if (!test) {
  throw new Error('TEST_DATABASE_URL missing — عيّن قاعدة اختبار منفصلة في .env قبل تشغيل الاختبارات');
}
if (!prod) {
  throw new Error('DATABASE_URL missing — لازم نتأكد إن TEST_DATABASE_URL مختلف عن الإنتاج');
}
if (test === prod) {
  throw new Error('TEST_DATABASE_URL يساوي DATABASE_URL — ممنوع تشغيل الاختبارات على إنتاج');
}
if (!testHost) {
  throw new Error('TEST_DATABASE_URL غير صالح (مفيش hostname)');
}
if (prodHost && testHost === prodHost) {
  throw new Error(`TEST_DATABASE_URL host (${testHost}) نفس host الإنتاج (${prodHost}) — استخدم مشروع Supabase منفصل`);
}

// من دلوقتي كل عميل pg في الاختبار هياخد قاعدة الاختبار
process.env.DATABASE_URL = test;
module.exports = { prodUrl: prod, testUrl: test, prodHost, testHost };
