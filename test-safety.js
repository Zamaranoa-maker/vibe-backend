/* اختبارات وحدة لنظام الأمان — node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./lib/safety');

test('العمر من تاريخ الميلاد', () => {
  const now = new Date('2026-11-26');
  assert.equal(S.ageFromDOB('2014-01-01', now), 12);
  assert.equal(S.ageFromDOB('2013-12-01', now), 12);
  assert.equal(S.ageFromDOB('2011-11-26', now), 15);
  assert.equal(S.ageFromDOB('2008-11-26', now), 18);
  assert.equal(S.ageFromDOB('not-a-date', now), null);
});

test('الفئات العمرية', () => {
  assert.equal(S.tier(12), 'blocked');
  assert.equal(S.tier(13), '13-15');
  assert.equal(S.tier(15), '13-15');
  assert.equal(S.tier(16), '16-17');
  assert.equal(S.tier(17), '16-17');
  assert.equal(S.tier(18), '18+');
  assert.equal(S.tier(60), '18+');
});

test('قواعد الفئات', () => {
  assert.equal(S.rulesFor(13).private, true);
  assert.equal(S.rulesFor(13).dm, 'off');
  assert.equal(S.rulesFor(13).duet, 'followers');
  assert.equal(S.rulesFor(13).live, false);
  assert.equal(S.rulesFor(16).dm, 'mutual');
  assert.equal(S.rulesFor(16).timeReminderMin, 60);
  assert.equal(S.rulesFor(18).live, true);
  assert.equal(S.rulesFor(18).gifts, true);
  assert.equal(S.rulesFor(12), null);
});

test('درجات العقوبات', () => {
  assert.equal(S.strikeAction(0), 'none');
  assert.equal(S.strikeAction(1), 'warn');
  assert.equal(S.strikeAction(2), 'restrict24h');
  assert.equal(S.strikeAction(3), 'suspend7d');
  assert.equal(S.strikeAction(4), 'ban');
  assert.equal(S.strikeAction(10), 'ban');
});

test('انتهاك جسيم = حظر فوري', () => {
  assert.equal(S.isSevere('csam'), true);
  assert.equal(S.isSevere('grooming'), true);
  assert.equal(S.isSevere('sexual'), false);
  let st = { strikes:0, status:'active', bans:[] };
  st = S.applyStrike(st, 'csam');
  assert.equal(st.status, 'banned');
  assert.equal(st.strikes, 4);
  assert.equal(st.bans.length, 1);
});

test('تصعيد العقوبات بالترتيب', () => {
  let st = { strikes:0, status:'active', bans:[] };
  st = S.applyStrike(st, 'hate'); assert.equal(st.status,'active'); assert.equal(st.strikes,1);
  st = S.applyStrike(st, 'hate'); assert.equal(st.status,'restricted');
  st = S.applyStrike(st, 'hate'); assert.equal(st.status,'suspended');
  st = S.applyStrike(st, 'hate'); assert.equal(st.status,'banned');
});

test('الرسائل الخاصة (anti-grooming)', () => {
  assert.equal(S.canDM(18, 13, true, false), false);
  assert.equal(S.canDM(18, 13, true, true), true);
  assert.equal(S.canDM(16, 16, true, false), true);
  assert.equal(S.canDM(16, 16, false, false), false);
  assert.equal(S.canDM(25, 30, false, false), true);
});

test('اللايف 18+ و 100 متابع', () => {
  assert.equal(S.canLive(17, 1000), false);
  assert.equal(S.canLive(18, 50), false);
  assert.equal(S.canLive(18, 100), true);
});

test('تحذير البيانات الشخصية', () => {
  assert.equal(S.personalInfoWarning('كلمني على 0123456789'), true);
  assert.equal(S.personalInfoWarning('مدرستي في المعادي'), true);
  assert.equal(S.personalInfoWarning('فيديو حلو'), false);
});

test('فلترة النص', () => {
  const r = S.checkText('محتوى عري و سلاح');
  assert.equal(r.flagged, true);
  assert.ok(r.hits.includes('عري'));
  assert.equal(S.checkText('طبخ كحول حلو').flagged, false);
});

test('درجة الخطورة والأولوية', () => {
  assert.equal(S.severityOf(S.riskScore({ hashMatch:true })), 'critical');
  assert.equal(S.severityOf(10), 'low');
  assert.equal(S.severityOf(30), 'medium');
  assert.equal(S.severityOf(60), 'high');
});
