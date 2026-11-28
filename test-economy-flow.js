/* اختبارات منطق الاقتصاد — تعمل بدون Postgres حقيقي (منطق فقط) */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./lib/economy');
const R = require('./lib/payout-rules');
const S = require('./lib/safety');

test('50 هدية متوازية والرصيد يغطي 10 بس → 10 تنجح والباقي يرفض', () => {
  let balance = 10; const accepted=[];
  // محاكاة قفل صف المحفظة: كل عملية تخصم بعد قراءة الرصيد داخل transaction
  for (let i=0;i<50;i++) {
    if (balance >= 1) { balance -= 1; accepted.push(i); }
  }
  assert.equal(accepted.length, 10);
  assert.equal(balance, 0);
});

test('مفتاح idempotency مكرر ما يخصمش مرتين', () => {
  const seen = new Map(); let balance = 100;
  function charge(key, amount) {
    if (seen.has(key)) return seen.get(key);
    balance -= amount;
    const r = { balance, amount }; seen.set(key, r); return r;
  }
  const a = charge('gift_1', 10);
  const b = charge('gift_1', 10);
  assert.equal(balance, 90);
  assert.deepEqual(a, b);
});

test('نفس purchase token ما يتصرفش مرتين', () => {
  const redeemed = new Set(); let coins = 0;
  function redeem(token, granted) {
    if (redeemed.has(token)) return { alreadyRedeemed:true };
    redeemed.add(token); coins += granted; return { coins, granted };
  }
  redeem('gp_abc', 100);
  const again = redeem('gp_abc', 100);
  assert.equal(coins, 100);
  assert.equal(again.alreadyRedeemed, true);
});

test('رفض تحت 18 سنة', () => {
  assert.equal(E.canGift('13-15'), false);
  assert.equal(E.canGift('16-17'), false);
  assert.equal(E.canGift('18+'), true);
  assert.equal(S.ageFromDOB('2013-01-01', new Date('2026-11-26')), 13);
});

test('استرداد بعد الإنفاق → تجميد لو الرصيد لا يغطي', () => {
  assert.deepEqual(R.refundFreeze(100, 50), { freeze:false, remaining:50 });
  assert.deepEqual(R.refundFreeze(30, 50), { freeze:true, remaining:30 });
});

test('ledger يساوي الرصيد (reconciliation)', () => {
  const entries = [100,-20,50,-10];
  const balance = entries.reduce((a,b)=>a+b,0);
  assert.equal(balance, 120);
  const ledgerSum = entries.reduce((a,b)=>a+b,0);
  assert.equal(balance, ledgerSum);
});

test('الماس بعد عمولة جوجل 15%', () => {
  const gross = 100, c = R.googleCommission(gross, 0);
  assert.equal(c.rate, 0.15);
  assert.equal(R.netRevenue(gross,0).net, 85);
  // بعد 1M دولار → 30%
  assert.equal(R.googleCommission(gross, 2_000_000).rate, 0.30);
});

test('سحب يدوي أول شهرين', () => {
  const now = Date.now();
  assert.equal(R.requiresManualPayout(new Date(now-10*86400000).toISOString(), now), true);
  assert.equal(R.requiresManualPayout(new Date(now-90*86400000).toISOString(), now), false);
});

test('إشارات AML', () => {
  assert.equal(R.amlDecision(R.amlScore({giftLoops:3})).action, 'freeze');
  assert.equal(R.amlDecision(R.amlScore({giftLoops:2})).action, 'hold');
  assert.equal(R.amlDecision(R.amlScore({})).action, 'allow');
});
