/* ============================================================================
   test-env.js — بوابة الأمان للاختبارات
   تمنع أي اختبار من لمس قاعدة الإنتاج. لازم TEST_DATABASE_URL منفصل تماماً،
   بنفس project ref أو مختلف — بنقارن الـ ref وليس الـ host فقط.
   ========================================================================== */
'use strict';
// VIBE_SKIP_DOTENV=1 يُستخدم في اختبارات البوابة نفسها عشان نتحكم في القيم بالكامل
if (process.env.VIBE_SKIP_DOTENV !== '1') require('./env');

const KNOWN_PROD_REF = 'dqpvrsgwfxzgapiqiwfq';
const prod = process.env.DATABASE_URL || '';
const test = process.env.TEST_DATABASE_URL || '';

function hostOf(s) { try { return new URL(s).hostname.toLowerCase(); } catch (e) { return ''; } }
function refOf(s) {
  try {
    const u = new URL(s);
    // Supabase pooler: postgres.<ref> في اسم المستخدم
    const user = decodeURIComponent(u.username || '');
    const m1 = user.match(/^postgres\.([a-z0-9]+)$/i);
    if (m1) return m1[1].toLowerCase();
    // Supabase direct: db.<ref>.supabase.co
    const m2 = u.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    if (m2) return m2[1].toLowerCase();
  } catch (e) {}
  return '';
}

if (!test) {
  throw new Error('TEST_DATABASE_URL missing — عيّن قاعدة اختبار منفصلة في .env قبل تشغيل الاختبارات');
}
if (!prod) {
  throw new Error('DATABASE_URL missing — لازم نتأكد إن TEST_DATABASE_URL مختلف عن الإنتاج');
}
if (test === prod) {
  throw new Error('TEST_DATABASE_URL يساوي DATABASE_URL — ممنوع تشغيل الاختبارات على إنتاج');
}

const prodHost = hostOf(prod), testHost = hostOf(test);
const prodRef = refOf(prod), testRef = refOf(test);

if (!testHost || !prodHost) {
  throw new Error('DATABASE_URL أو TEST_DATABASE_URL غير صالح (مفيش hostname)');
}
if (!prodRef) {
  throw new Error(`تعذّر استخراج Supabase project ref من DATABASE_URL — متوقع postgres.<ref> أو db.<ref>.supabase.co`);
}
if (!testRef) {
  throw new Error(`تعذّر استخراج Supabase project ref من TEST_DATABASE_URL — متوقع postgres.<ref> أو db.<ref>.supabase.co`);
}
if (testRef === prodRef || testRef === KNOWN_PROD_REF) {
  throw new Error(`TEST_DATABASE_URL يستخدم نفس Supabase project ref (${testRef}) — ممنوع تشغيل الاختبارات على الإنتاج`);
}
if (prodHost === testHost) {
  throw new Error(`TEST_DATABASE_URL host (${testHost}) نفس host الإنتاج — استخدم مشروع Supabase منفصل`);
}

// من دلوقتي كل عميل pg في الاختبار هياخد قاعدة الاختبار
process.env.DATABASE_URL = test;
module.exports = { prodUrl: prod, testUrl: test, prodHost, testHost, prodRef, testRef, KNOWN_PROD_REF };
