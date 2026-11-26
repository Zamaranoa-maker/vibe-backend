/* ============================================================================
   safety.js — Trust & Safety: age tiers, strikes, moderation rules
   ========================================================================== */
'use strict';

/* ---------- 1) فئات العمر ---------- */
const MIN_AGE = 13;
function ageFromDOB(dob, now = new Date()) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a;
}
function tier(age) {
  if (age == null) return null;
  if (age < MIN_AGE) return 'blocked';
  if (age <= 15) return '13-15';
  if (age <= 17) return '16-17';
  return '18+';
}
const TIER_RULES = {
  '13-15': { private:true, dm:'off', duet:'followers', live:false, gifts:false,
             ads:'non-personalized', timeReminderMin:null, comments:'followers', searchLimit:true },
  '16-17': { private:false, dm:'mutual', duet:'everyone', live:false, gifts:false,
             ads:'limited', timeReminderMin:60, comments:'everyone', searchLimit:false },
  '18+':   { private:false, dm:'everyone', duet:'everyone', live:true, gifts:true,
             ads:'personalized', timeReminderMin:null, comments:'everyone', searchLimit:false },
};
function rulesFor(age) { const t = tier(age); return t && TIER_RULES[t] ? TIER_RULES[t] : null; }

/* ---------- 2) نظام العقوبات (Strikes) ---------- */
const STRIKE_ACTIONS = ['warn','restrict24h','suspend7d','ban'];
function strikeAction(count) {
  if (count <= 0) return 'none';
  if (count >= 4) return 'ban';
  return STRIKE_ACTIONS[count - 1];
}
const SEVERE = ['csam','grooming','terrorism','credible_threat'];
function isSevere(reason) { return SEVERE.includes(String(reason)); }
function applyStrike(state, reason) {
  state = state || { strikes:0, status:'active', bans:[] };
  if (isSevere(reason)) {
    state.status = 'banned'; state.strikes = 4;
    state.bans.push({ reason, ts:Date.now(), type:'immediate' });
    return state;
  }
  state.strikes = (state.strikes || 0) + 1;
  const a = strikeAction(state.strikes);
  if (a === 'ban') state.status = 'banned';
  else if (a === 'suspend7d') { state.status='suspended'; state.until=Date.now()+7*86400000; }
  else if (a === 'restrict24h') { state.status='restricted'; state.until=Date.now()+86400000; }
  return state;
}

/* ---------- 3) سياسة المحتوى ---------- */
const POLICY = [
  { id:'csam', label:'استغلال جنسي لقاصر', severe:true, action:'ban' },
  { id:'grooming', label:'تحرش/استدراج أطفال', severe:true, action:'ban' },
  { id:'terrorism', label:'إرهاب/تحريض عنف', severe:true, action:'ban' },
  { id:'credible_threat', label:'تهديد حقيقي', severe:true, action:'ban' },
  { id:'sexual', label:'محتوى جنسي/عري', severe:false, action:'remove' },
  { id:'self_harm', label:'إيذاء نفس/انتحار', severe:false, action:'restrict' },
  { id:'drugs_weapons', label:'مخدرات/أسلحة', severe:false, action:'remove' },
  { id:'hate', label:'كراهية/تنمر', severe:false, action:'remove' },
  { id:'violence', label:'عنف', severe:false, action:'age_restrict' },
  { id:'doxxing', label:'بيانات خاصة', severe:false, action:'remove' },
  { id:'deepfake', label:'تزييف عميق بلا موافقة', severe:false, action:'remove' },
  { id:'fraud', label:'نصب/احتيال/انتحال', severe:false, action:'remove' },
  { id:'misinfo', label:'معلومات مضللة خطيرة', severe:false, action:'age_restrict' },
  { id:'copyright', label:'حقوق محفوظة', severe:false, action:'remove' },
];
const REASONS = POLICY.map(p => ({ id:p.id, label:p.label }));

/* كلمة ممنوعة عربية/إنجليزية (افتراضية) */
const DEFAULT_BLOCKED = ['عري','شذوذ','مخدرات','سلاح','سكين','قتل','انتحار','اغتصاب',
  'porn','sex','nude','drug','weapon','kill','rape','suicide','csam'];

function checkText(text) {
  const t = String(text||'').toLowerCase();
  const hits = DEFAULT_BLOCKED.filter(w => t.includes(w));
  return { flagged: hits.length>0, hits };
}

/* ---------- 4) تقييم المخاطر (قبل المراجعة البشرية) ---------- */
function riskScore({ textHits=[], automated={}, hashMatch=false, reportCount=0, reporterTrusted=true }) {
  let s = 0;
  s += textHits.length * 10;
  s += (automated.nudity||0) * 30;
  s += (automated.violence||0) * 15;
  s += (automated.hate||0) * 20;
  s += (automated.selfHarm||0) * 25;
  s += hashMatch ? 100 : 0;
  s += reporterTrusted ? Math.min(20, reportCount*5) : 0;
  return Math.min(100, s);
}
function severityOf(score) {
  if (score >= 80) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/* ---------- 5) إساءة social ---------- */
function canDM(fromAge, toAge, mutual, parentApproved) {
  const f = tier(fromAge), t = tier(toAge);
  if (t === '13-15') return !!(parentApproved && (f==='13-15' || (mutual && parentApproved)));
  if (t === '16-17') return !!mutual;
  return true;
}
function canLive(age, followers) {
  const t = tier(age);
  return t === '18+' && followers >= 100;
}
function personalInfoWarning(text) {
  const t = String(text||'');
  const phone = /(?:\+?20)?0?1\d{9}|\b\d{10,11}\b/.test(t.replace(/\s/g,''));
  const addr = /شارع|عنوان|مدرسة|مدرسه|مدرستي|المدرسة|school|address/i.test(t);
  return phone || addr;
}

module.exports = {
  MIN_AGE, ageFromDOB, tier, TIER_RULES, rulesFor,
  STRIKE_ACTIONS, strikeAction, isSevere, applyStrike,
  POLICY, REASONS, DEFAULT_BLOCKED, checkText,
  riskScore, severityOf, canDM, canLive, personalInfoWarning,
};
