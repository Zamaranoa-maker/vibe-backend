/* ============================================================================
   economy.js — Coins, Gifts & Live economy (responsible design)
   ========================================================================== */
'use strict';

/* ---------- باقات العملات (Google Play Billing فقط) ---------- */
const COIN_PACKS = [
  { id:'c70',   coins:70,   bonusPct:0,    priceEGP:9,   label:'صغير' },
  { id:'c350',  coins:350,  bonusPct:5,    priceEGP:39,  label:'شائع' },
  { id:'c700',  coins:700,  bonusPct:10,   priceEGP:69,  label:'قيمة' },
  { id:'c1400', coins:1400, bonusPct:15,   priceEGP:129, label:'أفضل قيمة' },
  { id:'c3500', coins:3500, bonusPct:18,   priceEGP:299, label:'داعم' },
  { id:'c7000', coins:7000, bonusPct:20,   priceEGP:549, label:'أسطورة' },
];
const packTotal = p => Math.round(p.coins * (1 + p.bonusPct/100));
const perCoin = p => p.priceEGP / packTotal(p);

/* ---------- الهدايا (20+) ---------- */
const GIFTS = [
  { id:'rose',    name:'وردة',       ico:'🌹', coins:1,    tier:'cheap',  anim:'float' },
  { id:'heart',   name:'قلب',        ico:'❤️', coins:1,    tier:'cheap',  anim:'pulse' },
  { id:'clap',    name:'تصفيق',      ico:'👏', coins:2,    tier:'cheap',  anim:'pop' },
  { id:'star',    name:'نجمة',       ico:'⭐', coins:5,    tier:'cheap',  anim:'spin' },
  { id:'coffee',  name:'قهوة',       ico:'☕', coins:5,    tier:'cheap',  anim:'steam' },
  { id:'flower',  name:'باقة ورد',   ico:'💐', coins:10,   tier:'cheap',  anim:'burst' },
  { id:'cake',    name:'كيك',        ico:'🎂', coins:15,   tier:'medium', anim:'pop' },
  { id:'crown',   name:'تاج',        ico:'👑', coins:30,   tier:'medium', anim:'shine' },
  { id:'guitar',  name:'جيتار',      ico:'🎸', coins:50,   tier:'medium', anim:'wave' },
  { id:'camera',  name:'كاميرا',     ico:'📷', coins:50,   tier:'medium', anim:'flash' },
  { id:'rocket',  name:'صاروخ',      ico:'🚀', coins:100,  tier:'premium',anim:'launch' },
  { id:'diamond', name:'ألماسة',     ico:'💎', coins:150,  tier:'premium',anim:'sparkle' },
  { id:'car',     name:'سيارة',      ico:'🚗', coins:200,  tier:'premium',anim:'drive' },
  { id:'castle',  name:'قلعة',       ico:'🏰', coins:300,  tier:'premium',anim:'rise' },
  { id:'pharaoh', name:'فرعون',      ico:'👑', coins:500,  tier:'premium',anim:'gold' },
  { id:'lion',    name:'أسد',        ico:'🦁', coins:700,  tier:'premium',anim:'roar' },
  { id:'falcon',  name:'صقر',        ico:'🦅', coins:800,  tier:'premium',anim:'fly' },
  { id:'egypt',   name:'الأهرام',    ico:'🔺', coins:1000, tier:'premium',anim:'pyramid' },
  { id:'galaxy',  name:'مجرة',       ico:'🌌', coins:1500, tier:'premium',anim:'cosmos' },
  { id:'vibe',    name:'ڨايب كينج',  ico:'💫', coins:2000, tier:'premium',anim:'legend' },
];
const giftById = id => GIFTS.find(g => g.id === id) || null;

/* ---------- مستويات الداعمين ---------- */
const SUPPORTER_LEVELS = [
  { id:'bronze', name:'Bronze', ico:'🥉', min:0 },
  { id:'silver', name:'Silver', ico:'🥈', min:100 },
  { id:'gold',   name:'Gold',   ico:'🥇', min:500 },
  { id:'platinum',name:'Platinum',ico:'💎', min:2000 },
  { id:'diamond',name:'Diamond',ico:'🔷', min:5000 },
  { id:'legend', name:'Legend', ico:'👑', min:15000 },
];
function supporterLevel(totalGiftedCoins){
  let l = SUPPORTER_LEVELS[0];
  for (const x of SUPPORTER_LEVELS) if (totalGiftedCoins >= x.min) l = x;
  return l;
}

/* ---------- الاشتراك ---------- */
const PASS = { priceEGP:29, coinsPerDay:50, badge:'⭐ Supporter', adFree:true };

/* ---------- دوائر آمنة ---------- */
function canPurchase(userAgeBand){ return userAgeBand === '18+'; }
function canGift(userAgeBand){ return userAgeBand === '18+'; }
function canHostLive(userAgeBand, followers){ return userAgeBand === '18+' && followers >= 100; }
function comboBonus(count){ return Math.min(5, 1 + Math.floor(count/5) * 0.1); }

/* ---------- مكافحة الاحتيال ---------- */
function suspiciousGift(from, to, links, velocity){
  const linked = (links||[]).some(l => l.includes(from) && l.includes(to));
  return !!(linked || (velocity||0) > 30); // 30 هدية في دقيقة = إشارة
}
function amlFlag(amount, dailySpent){
  return amount >= 2000 || dailySpent >= 5000;
}

module.exports = {
  COIN_PACKS, packTotal, perCoin, GIFTS, giftById,
  SUPPORTER_LEVELS, supporterLevel, PASS,
  canPurchase, canGift, canHostLive, comboBonus,
  suspiciousGift, amlFlag,
};
