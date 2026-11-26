/* ============================================================================
   payout-rules.js — قواعد اقتصاد صحيحة قانونياً
   ========================================================================== */
'use strict';

/* Google Play commission: 15% على أول $1M/سنة، 30% بعدها.
   نحسب صافي الإيراد قبل توزيع المبدع. */
function googleCommission(grossEGP, annualGrossEGP = 0) {
  const rate = annualGrossEGP < 1_000_000 ? 0.15 : 0.30;
  return { rate, amount: Math.round(grossEGP * rate * 100) / 100 };
}
function netRevenue(grossEGP, annualGrossEGP = 0) {
  const c = googleCommission(grossEGP, annualGrossEGP);
  return { ...c, net: Math.round((grossEGP - c.amount) * 100) / 100 };
}

/* نسبة المبدع 50% من الصافي مش من الإجمالي (basis points) */
function creatorShareBps(netEGP, grossEGP, annualGrossEGP = 0) {
  const { net } = netRevenue(grossEGP, annualGrossEGP);
  const share = Math.floor((net * 5000) / 100);   // 50% = 5000 bps
  return Math.max(0, share);
}

/* سحب يدوي أول شهرين */
const MANUAL_REVIEW_MONTHS = 2;
function requiresManualPayout(accountCreatedAt, now = Date.now()) {
  const months = (now - new Date(accountCreatedAt).getTime()) / (30 * 86400000);
  return months < MANUAL_REVIEW_MONTHS;
}

/* إشارات AML */
function amlScore({ giftLoops=0, velocity=0, devicesToOneCreator=0, chargebacks=0, crossBorder=0 }) {
  return giftLoops*30 + velocity*10 + devicesToOneCreator*20 + chargebacks*25 + crossBorder*5;
}
function amlDecision(score) {
  if (score >= 80) return { action:'freeze', flag:true };
  if (score >= 50) return { action:'hold', flag:true };
  return { action:'allow', flag:false };
}

/* تحقق الرصيد عند الاسترداد: لو الرصيد لا يغطي → تجميد */
function refundFreeze(balance, refundAmount) {
  return balance >= refundAmount ? { freeze:false, remaining:balance-refundAmount }
                                 : { freeze:true, remaining:balance };
}

module.exports = { googleCommission, netRevenue, creatorShareBps,
  requiresManualPayout, amlScore, amlDecision, refundFreeze, MANUAL_REVIEW_MONTHS };
