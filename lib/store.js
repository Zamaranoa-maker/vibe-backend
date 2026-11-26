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
      // مكافآت المستخدم (المصروف) — مضبوطة عشان الدخل يبقى ≥5× عند مليون مستخدم
      rewardView: 0.005,
      rewardUpload: 0.02,
      rewardLike: 0.003,
      rewardDaily: 0.04,
      // 💡 المهام اليومية: 10 إعلانات/يوم بمكافأة لكل إعلان + بونص إكمال
      dailyTask: {
        adsPerDay: 10,
        rewardPerAd: 0.008,     // المستخدم يكسب 0.008 ج.م عن كل إعلان
        completionBonus: 0.05,  // بونص لو خلص الـ 10
      },
      // أسعار الإعلانات (eCPM محافظ لمصر 2026 ≈ 50 ج.م/دولار)
      adPrices: {
        banner:      0.03,   // ~$0.60 eCPM
        interstitial:0.10,   // ~$2.00 eCPM
        rewarded:    0.18,   // ~$3.50 eCPM
      },
      adRevenuePerView: 0.10,
      profitMultiplierTarget: 5,     // الهدف: الدخل = 5× المصروف
      minWatchPercent: 70,
      viewCooldownMs: 6 * 60 * 60 * 1000,
      maxDailyEarnPerUser: 0.8,      // سقف يومي = تحكم في المصروف
      // نموذج التوقعات عند مليون مستخدم
      model: {
        registered: 1000000,
        dauRate: 0.25,          // 25% يومياً نشط = 250 ألف
        videosPerDay: 12,
        adsPerDay: 4,           // إعلان كل 3 فيديوهات
        adMix: {banner:1, interstitial:2, rewarded:1},
        qualifyingViews: 4,     // مشاهدات تُحتسب بعد الـ cooldown
        likesPerDay: 2,
        uploadsPerWeek: 1,
      },
    },
    tasks: {},   // تتبع المهام اليومية لكل مستخدم
    reports: {}, // البلاغات: videoId -> [{userId,reason,ts}]
    bannedWords: ['عري','شذوذ','مخدرات','سلاح','سكين','دم','قتل',' porn','sex','nude','drug','weapon','kill'],
    hiddenVideos: {}, // videoId -> true (مخفي للمراجعة)
    voiceComments: {}, // videoId -> [{id,userId,file,durationMs,ts,status,peaks,transcript,reports}]
    moderationQueue: [], // [{commentId,videoId,file,ts}] تنتظر المراجعة
    blockedUsers: {},   // userId -> true (محظور بسبب إساءة)
    voiceSettings: {},  // videoId -> {disabled:true} (الصانع يوقف التعليقات)
    voiceRate: {},      // userId -> [ts] (تقييد 20/دقيقة)
    captions: {},       // videoId -> {ar:'WEBVTT...', en:'WEBVTT...'}
    captionJobs: [],    // [{videoId,file,status,ts}]
    // ═══ Creator Studio ═══
    aggregates: {},     // userId -> { daily:{}, videos:{}, audience:{}, sources:{}, updatedAt }
    scheduled: [],      // [{id,userId,caption,tags,file,mime,publishAt,status,attempts}]
    drafts: {},         // userId -> [{id,caption,tags,filter,sound,file,updatedAt}]
    payouts: [],        // [{id,userId,amount,method,status,ts}]
    abTests: {},        // videoId -> {covers:[],assignments:{},impressions:{},winner:null}
    creatorSettings: {},// userId -> {allowDownloads:bool}
    // ═══ الأمان وحماية القاصرين ═══
    userProfiles: {},   // userId -> {birthDate,age,ageBand,private,parentLinked}
    familyLinks: {},    // childId -> parentId
    safetyReports: [],  // [{id,userId,videoId,reason,status,ts}]
    // ═══ Coins, Gifts & Live ═══
    coins: {},          // userId -> {balance, totalBought, gifted, diamonds, spentToday, spentMonth, firstBonusUsed, passUntil}
    purchases: [],      // [{id,userId,packId,coins,price,ts,status,receipt}]
    giftTx: [],         // [{id,from,to,giftId,coins,combo,videoId,liveId,ts,flagged}]
    supporter: {},      // creatorId -> {supporters:{userId:coins}, week:{}}
    lives: {},          // liveId -> {host,viewers,chat,gifts,status,startedAt}
    liveEvents: [],     // [{id,creatorId,title,startAt,type}]
    spendingLimits: {}, // userId -> {daily,monthly}
    refunds: [],        // [{id,purchaseId,ts,status}]
    policy: {
      minAge: 13,
      bands: {
        '13-15': { private:true, dm:'off', duet:'followers', live:false, gifts:false,
                   ads:'non-personalized', timeReminderMin:null },
        '16-17': { private:false, dm:'mutual', duet:'everyone', live:true, gifts:false,
                   ads:'limited', timeReminderMin:60 },
        '18+':   { private:false, dm:'everyone', duet:'everyone', live:true, gifts:true,
                   ads:'personalized', timeReminderMin:null },
      },
    },
    stats: { adImpressions: 0, adRevenue: 0, adByType: {}, totalSpent: 0, signups: 0 },
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
      if (!db.tasks) db.tasks = {};
      if (!db.config.dailyTask) db.config.dailyTask = def.config.dailyTask;
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
