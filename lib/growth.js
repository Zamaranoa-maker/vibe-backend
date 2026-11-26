/* ============================================================================
   growth.js — Invite codes + badges + weekly leaderboard (مكافآت رمزية فقط)
   ========================================================================== */
'use strict';

const BADGES = {
  founding: { id:'founding', ico:'🏅', name:'Founding Creator', desc:'من أول المبدعين' },
  inviter:  { id:'inviter', ico:'🎁', name:'Inviter', desc:'دعا 3 أصدقاء' },
  top:      { id:'top', ico:'👑', name:'Top Creator', desc:'الأعلى هذا الأسبوع' },
};

function makeCode(userId) {
  const base = String(userId).replace(/\D/g,'').slice(-6) || '1000';
  return 'VIBE-' + base + '-' + Math.random().toString(36).slice(2,5).toUpperCase();
}
function leaderboard(users, videos) {
  return Object.values(videos).reduce((acc, v) => {
    const an = v.analytics||{};
    const s = acc[v.owner] || (acc[v.owner]={userId:v.owner,views:0,likes:0,videos:0});
    s.views += an.views||0; s.likes += (v.likes||[]).length; s.videos++;
    return acc;
  }, {});
}
module.exports = { BADGES, makeCode, leaderboard };
