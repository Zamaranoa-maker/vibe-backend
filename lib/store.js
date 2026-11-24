/* ============================================================================
   طبقة تخزين بسيطة (JSON file) — بديل عن قاعدة بيانات للـ prototype
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

function emptyDB() {
  return {
    users: {},        // token -> {id, deviceId, createdAt}
    videos: {},       // id -> {id, owner, caption, tags, file, size, mime, createdAt, likes:[], views:{}}
    wallet: {},       // userId -> {balance, totalEarned, daily:{date,claimed}}
    ledger: [],       // {id, userId, type, amount, note, ts}
    config: {
      rewardView: 0.01,
      rewardUpload: 0.05,
      rewardLike: 0.01,
      rewardDaily: 0.10,
      adRevenuePerView: 0.015,   // متوسط دخل الإعلان عن كل مشاهدة (قابل للتعديل)
      minWatchPercent: 60,        // لازم يتفرج 60% على الأقل عشان يُحتسب
      viewCooldownMs: 6 * 60 * 60 * 1000, // مشاهدة واحدة لكل جهاز لكل فيديو كل 6 ساعات
      maxDailyEarnPerUser: 2.0,   // حد أقصى يومي (مضاد للغش)
    },
    stats: { adImpressions: 0, totalSpent: 0, signups: 0 },
  };
}

let db;
function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(raw);
      const def = emptyDB();
      // دمج الإعدادات الافتراضية لل مفقود
      db.config = { ...def.config, ...(db.config || {}) };
      db.stats = { ...def.stats, ...(db.stats || {}) };
      return;
    }
  } catch (e) {
    console.error('[store] load error, starting fresh:', e.message);
  }
  db = emptyDB();
  save();
}

let saveTimer = null;
function save() {
  // كتابة ذرية عبر ملف مؤقت
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[store] save error:', e.message);
  }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 400);
}

function get() { return db; }
function commit() { scheduleSave(); }

module.exports = { load, get, save, commit, DATA_DIR, VIDEO_DIR, DB_FILE };
