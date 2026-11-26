/* اختبارات منطق المحفظة والـ ledger */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ageOf, WalletError } = require('./lib/wallet-db');
const E = require('./lib/economy');

test('حساب العمر', () => {
  const now = Date.now();
  const d = new Date(now - 20*365.25*86400000).toISOString().slice(0,10);
  assert.equal(ageOf(d), 20);
});

test('نصيب الصانع من الهدية (50%)', () => {
  const g = E.giftById('rocket'); // 100 coin
  assert.equal(Math.floor((g.coins * 5000)/10000), 50);
  const ph = E.giftById('pharaoh'); // 500
  assert.equal(Math.floor((ph.coins * 5000)/10000), 250);
});

test('خطأ المحفظة يحمل كود', () => {
  const e = new WalletError('INSUFFICIENT_COINS','الرصيد غير كافٍ');
  assert.equal(e.code,'INSUFFICIENT_COINS');
  assert.equal(e.message,'الرصيد غير كافٍ');
});

test('معرّف ثابت للـ BIGINT', () => {
  const a = numericId('u_abc'), b = numericId('u_abc'), c = numericId('u_xyz');
  assert.equal(a,b);
  assert.notEqual(a,c);
  assert.ok(a >= 1000000000);
});
function numericId(str){let h=0;for(const ch of String(str))h=((h*31)+ch.charCodeAt(0))>>>0;return(h%900000000000)+1000000000}
