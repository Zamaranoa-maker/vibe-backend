/* ============================================================================
   storage-guard.js — حفظ يومي للاستخدام + منع رفع graceful عند الحد
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const VIDEO_DIR = path.join(__dirname, '..', 'data', 'videos');

const LIMITS = {
  dailyUploadBytes: 500 * 1024 * 1024,   // 500MB/يوم
  totalVideoBytes:  4 * 1024 * 1024 * 1024, // 4GB إجمالي (R2 free 10GB)
  warnAtPct: 80,
};

function dayKey() { return new Date().toISOString().slice(0, 10); }

function usage() {
  let total = 0, files = 0;
  try {
    for (const f of fs.readdirSync(VIDEO_DIR)) {
      const st = fs.statSync(path.join(VIDEO_DIR, f));
      if (st.isFile()) { total += st.size; files++; }
    }
  } catch (e) {}
  return { total, files };
}

/* سجل يومي في data/usage.json */
function logUsage(bytes) {
  const file = path.join(__dirname, '..', 'data', 'usage.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const key = dayKey();
  data[key] = (data[key] || 0) + bytes;
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
  return data[key];
}

/* هل نسمح برفع جديد؟ */
function canUpload(incomingBytes = 25 * 1024 * 1024) {
  const u = usage();
  const file = path.join(__dirname, '..', 'data', 'usage.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const today = data[dayKey()] || 0;
  if (today + incomingBytes > LIMITS.dailyUploadBytes)
    return { ok:false, reason:'daily_limit', message:'الحد اليومي للرفع خلص — جرّب بكرة' };
  if (u.total + incomingBytes > LIMITS.totalVideoBytes)
    return { ok:false, reason:'storage_limit', message:'التخزينfull — جرّب بعدين' };
  const pct = Math.round((u.total / LIMITS.totalVideoBytes) * 100);
  return { ok:true, warn:pct >= LIMITS.warnAtPct, usagePct:pct, todayBytes:today };
}

module.exports = { LIMITS, usage, logUsage, canUpload };
