/* ============================================================================
   المحفظة والأرباح — كل حركة ليها سجل (ledger) عشان نمنع الغش ونعرف الفلوس راحت فين
   ========================================================================== */
'use strict';
const { get, commit } = require('./store');

function ensure(userId) {
  const db = get();
  if (!db.wallet[userId]) {
    db.wallet[userId] = {
      balance: 0,
      totalEarned: 0,
      daily: { date: '', count: 0, amount: 0 },
      createdAt: Date.now(),
    };
    commit();
  }
  return db.wallet[userId];
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function add(userId, amount, type, note) {
  const db = get();
  const w = ensure(userId);
  const t = todayKey();
  if (w.daily.date !== t) w.daily = { date: t, count: 0, amount: 0 };

  // حد أقصى يومي
  const cap = db.config.maxDailyEarnPerUser;
  if (amount > 0 && w.daily.amount + amount > cap) {
    return { ok: false, reason: 'cap', cap };
  }

  const rounded = Math.round(amount * 100) / 100;
  w.balance = Math.round((w.balance + rounded) * 100) / 100;
  if (rounded > 0) {
    w.totalEarned = Math.round((w.totalEarned + rounded) * 100) / 100;
    w.daily.amount = Math.round((w.daily.amount + rounded) * 100) / 100;
    db.stats.totalSpent = Math.round((db.stats.totalSpent + rounded) * 100) / 100;
  }
  w.daily.count++;

  db.ledger.push({
    id: 'tx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId, type, amount: rounded, note: note || '', ts: Date.now(),
  });
  // احتفظ بآخر 5000 حركة فقط
  if (db.ledger.length > 5000) db.ledger = db.ledger.slice(-5000);
  commit();
  return { ok: true, balance: w.balance, amount: rounded };
}

function getWallet(userId) {
  const w = ensure(userId);
  const t = todayKey();
  return {
    balance: w.balance,
    totalEarned: w.totalEarned,
    todayEarned: w.daily.date === t ? w.daily.amount : 0,
    dailyCap: get().config.maxDailyEarnPerUser,
  };
}

function history(userId, limit = 30) {
  return get().ledger.filter(x => x.userId === userId).slice(-limit).reverse();
}

module.exports = { ensure, add, getWallet, history, todayKey };
