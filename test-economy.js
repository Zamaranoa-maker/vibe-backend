/* اختبارات اقتصاد العملات والهدايا */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./lib/economy');

test('الباقات بونص تصاعدي', () => {
  assert.equal(E.packTotal(E.COIN_PACKS[0]), 70);
  assert.equal(E.packTotal(E.COIN_PACKS[1]), 368); // 350 + 5%
  assert.equal(E.packTotal(E.COIN_PACKS[5]), 8400); // 7000 + 20%
  for (let i=1;i<E.COIN_PACKS.length;i++)
    assert.ok(E.COIN_PACKS[i].bonusPct >= E.COIN_PACKS[i-1].bonusPct);
});

test('سعر العملة أوضح في الباقات الأكبر', () => {
  assert.ok(E.perCoin(E.COIN_PACKS[5]) < E.perCoin(E.COIN_PACKS[0]));
});

test('مستويات الداعمين', () => {
  assert.equal(E.supporterLevel(0).id, 'bronze');
  assert.equal(E.supporterLevel(100).id, 'silver');
  assert.equal(E.supporterLevel(500).id, 'gold');
  assert.equal(E.supporterLevel(2000).id, 'platinum');
  assert.equal(E.supporterLevel(5000).id, 'diamond');
  assert.equal(E.supporterLevel(15000).id, 'legend');
});

test('هدايا: 20+ من رخيصة لمميزة', () => {
  assert.ok(E.GIFTS.length >= 20);
  assert.equal(Math.min(...E.GIFTS.map(g=>g.coins)), 1);
  assert.equal(Math.max(...E.GIFTS.map(g=>g.coins)), 2000);
  assert.ok(E.giftById('pharaoh'));
  assert.equal(E.giftById('none'), null);
});

test('قواعد مسؤولة: القاصرين مفيش شراء/هدايا/لايف', () => {
  assert.equal(E.canPurchase('13-15'), false);
  assert.equal(E.canPurchase('16-17'), false);
  assert.equal(E.canPurchase('18+'), true);
  assert.equal(E.canGift('16-17'), false);
  assert.equal(E.canHostLive('18+', 50), false);
  assert.equal(E.canHostLive('18+', 100), true);
  assert.equal(E.canHostLive('17', 500), false);
});

test('كومبو بدون مقامرة', () => {
  assert.equal(E.comboBonus(0), 1);
  assert.equal(E.comboBonus(5), 1.1);
  assert.ok(E.comboBonus(100) <= 5); // سقف
});

test('كشف الهدايا المشبوهة وAML', () => {
  assert.equal(E.suspiciousGift('a','b',[['a','b']],1), true);
  assert.equal(E.suspiciousGift('a','b',[],50), true);
  assert.equal(E.suspiciousGift('a','b',[],1), false);
  assert.equal(E.amlFlag(2000,0), true);
  assert.equal(E.amlFlag(10,6000), true);
  assert.equal(E.amlFlag(10,100), false);
});
