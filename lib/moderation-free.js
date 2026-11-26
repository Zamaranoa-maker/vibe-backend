/* ============================================================================
   moderation-free.js — محتوى نصي: فلتر مجاني محلي + API مجاني اختياري
   ========================================================================== */
'use strict';
const safety = require('./safety');

/* كلمات حساسة عامة (بدون شتائم صريحة — بنستخدم تصنيفات المحتوى) */
const SENSITIVE = [
  'عري', 'شذوذ', 'اغتصاب', 'قتل', 'انتحار', 'إيذاء نفس',
  'مخدرات', 'سلاح', 'سكين', 'إرهاب', 'عنف', 'تنمر',
  'nude', 'porn', 'rape', 'suicide', 'drug', 'weapon', 'kill', 'hate',
];
const userTerms = []; // تُحمّل من إعدادات المستخدم

function checkTextLocal(text, extraWords = []) {
  const t = String(text || '').toLowerCase();
  const words = [...SENSITIVE, ...safety.DEFAULT_BLOCKED, ...extraWords];
  const hits = words.filter(w => w && t.includes(String(w).toLowerCase()));
  return {
    flagged: hits.length > 0,
    hits,
    severity: hits.length > 2 ? 'high' : hits.length ? 'medium' : 'clean',
  };
}

async function checkTextRemote(text) {
  const url = process.env.MODERATION_API_URL;
  if (!url) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || '').slice(0, 500) }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function moderate(text, extraWords) {
  const local = checkTextLocal(text, extraWords);
  if (local.flagged) return { ...local, source: 'local' };
  const remote = await checkTextRemote(text);
  if (remote?.flagged) return { ...remote, source: 'remote' };
  return local;
}

/* نتيجة فحص NSFW من الجهاز (TensorFlow.js) */
function checkDeviceNsfw(result) {
  if (!result) return { blocked: false };
  return { blocked: (result.nsfw || 0) > 0.7, score: result.nsfw || 0 };
}

module.exports = { checkTextLocal, checkTextRemote, moderate, checkDeviceNsfw };
