/* ============================================================================
   VIBE Backend — Node خالص (بدون مكتبات خارجية)
   ========================================================================== */
'use strict';
require('./lib/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const store = require('./lib/store');
const wallet = require('./lib/wallet');
const sec = require('./lib/security');
const safety = require('./lib/safety');
const eco = require('./lib/economy');
const dbLayer = require('./lib/db');
const walletDB = require('./lib/wallet-db');
const billing = require('./lib/billing');
store.load();

//.init Postgres (اختياري) + عامل تحرير الماس
(async () => {
  const ok = await dbLayer.init();
  if (ok) {
    await billing.init();
    setInterval(() => walletDB.releaseHolds().catch(() => {}), 60 * 1000);
    console.log('[server] DB + billing ready');
  }
})();

const limiter = sec.rateLimit(150, 60 * 1000);

const PORT = process.env.PORT || 3000;

// تحويل المعرّف النصي لرقم ثابت (لجدول BIGINT في Postgres)
function numericId(str) {
  let h = 0; const s = String(str);
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  return (h % 900000000000) + 1000000000;
}
const VIDEO_DIR = store.VIDEO_DIR;

/* ---------- أدوات ---------- */
function send(res, code, data, type = 'application/json; charset=utf-8') {
  sec.secureHeaders(res);
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}
function body(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
/* قراءة raw body (للـ multipart/form-data) */
function rawBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/* تحليل بسيط لـ multipart/form-data */
function parseMultipart(buf, boundary) {
  const result = {};
  const parts = buf.toString('binary').split('--' + boundary);
  for (const part of parts) {
    if (!part || part === '--\r\n' || part === '--') continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd);
    const data = part.slice(headerEnd + 4, part.length - 2); // شيل الـ \r\n في الآخر
    const nameMatch = header.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const fileMatch = header.match(/filename="([^"]+)"/);
    if (fileMatch) {
      result[name] = { filename: fileMatch[1], data: Buffer.from(data, 'binary') };
    } else {
      result[name] = data;
    }
  }
  return result;
}

function auth(req, db) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const user = db.users[token];
  return user ? { token, user } : null;
}

/* ---------- Routes ---------- */
async function route(req, res) {
  sec.cors(req, res);
  if (!limiter(req, res, () => {})) return;
  if (req.method === 'OPTIONS') {
    sec.secureHeaders(res);
    res.writeHead(204); res.end(); return;
  }
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const db = store.get();
  const method = req.method;

  if (method === 'OPTIONS') return send(res, 204, '');

  // Health
  if (p === '/api/health' && method === 'GET') {
    return send(res, 200, { ok: true, users: Object.keys(db.users).length, videos: Object.keys(db.videos).length });
  }

  // تسجيل/دخول جهاز
  if (p === '/api/auth' && method === 'POST') {
    const b = await body(req);
    const deviceId = String(b.deviceId || '').slice(0, 100);
    if (!deviceId) return send(res, 400, { error: 'deviceId مطلوب' });
    // ابحث عن مستخدم بنفس الجهاز
    let found = Object.entries(db.users).find(([, v]) => v.deviceId === deviceId);
    let token, user;
    if (found) { token = found[0]; user = found[1]; }
    else {
      token = crypto.randomBytes(24).toString('hex');
      user = { id: 'u_' + Date.now().toString(36), deviceId, createdAt: Date.now() };
      db.users[token] = user;
      db.stats.signups++;
      wallet.ensure(user.id);
      store.commit();
    }
    return send(res, 200, { token, user: { id: user.id }, isNew: !found });
  }

  // ملفي
  if (p === '/api/me' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: ' unauthorized' });
    return send(res, 200, { user: a.user, wallet: wallet.getWallet(a.user.id) });
  }

  // رفع فيديو (base64 JSON)
  if (p === '/api/videos' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const b = await body(req);
    if (!b.data) return send(res, 400, { error: 'data مطلوب' });
    const buf = Buffer.from(b.data, 'base64');
    if (buf.length > 50 * 1024 * 1024) return send(res, 400, { error: 'الفيديو كبير جداً (أقصى 50MB)' });
    if (!sec.isRealVideo(buf)) return send(res, 400, { error: 'الملف مش فيديو صالح (MP4/WebM بس)' });
    // 🛡️ فلتر المحتوى: كلمات ممنوعة في الوصف/الهاشتاجات
    const text = (String(b.caption||'') + ' ' + String(b.tags||'')).toLowerCase();
    const bad = (db.bannedWords||[]).some(w => text.includes(w.toLowerCase()));
    if (bad) return send(res, 400, { error: 'المحتوى مخالف لمعايير المجتمع ❌' });
    const id = 'v_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const ext = (b.mime || 'video/mp4').includes('webm') ? 'webm' : 'mp4';
    const file = path.join(VIDEO_DIR, id + '.' + ext);
    fs.writeFileSync(file, buf);
    db.videos[id] = {
      id, owner: a.user.id, caption: sec.esc(String(b.caption || '')).slice(0, 300),
      tags: sec.esc(String(b.tags || '')).slice(0, 100), file: path.basename(file),
      size: buf.length, mime: b.mime || 'video/mp4',
      createdAt: Date.now(), likes: [], views: {},
    };
    store.commit();
    const r = wallet.add(a.user.id, db.config.rewardUpload, 'upload', 'رفع فيديو: ' + id);
    return send(res, 201, { video: publicVideo(db.videos[id]), reward: r });
  }

  // liste الفيديوهات (بدون المخفية للمراجعة)
  if (p === '/api/videos' && method === 'GET') {
    const list = Object.values(db.videos)
      .filter(v => !(db.hiddenVideos||{})[v.id])
      .sort((x, y) => y.createdAt - x.createdAt)
      .map(v => publicVideo(v));
    return send(res, 200, { videos: list });
  }

  // 🚨 إبلاغ عن فيديو (إبلاغين = إخفاء تلقائي للمراجعة)
  if (p.startsWith('/api/videos/') && p.endsWith('/report') && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[3];
    if (!db.videos[id]) return send(res, 404, { error: 'not found' });
    const b = await body(req);
    db.reports = db.reports || {};
    const list = db.reports[id] || (db.reports[id] = []);
    if (!list.some(r => r.userId === a.user.id)) {
      list.push({ userId: a.user.id, reason: String(b.reason||'مخالف للمعايير').slice(0,80), ts: Date.now() });
    }
    let hidden = false;
    if (list.length >= 2) { db.hiddenVideos = db.hiddenVideos || {}; db.hiddenVideos[id] = true; hidden = true; }
    store.commit();
    return send(res, 200, { reports: list.length, hidden, message: hidden ? 'تم إخفاء الفيديو للمراجعة ✅' : 'تم تسجيل البلاغ ✅' });
  }

  // 👮 حذف فيديو (أدمن)
  if (p.startsWith('/api/admin/videos/') && method === 'DELETE') {
    const id = p.split('/')[4];
    if (db.videos[id]) {
      const f = path.join(VIDEO_DIR, db.videos[id].file);
      if (fs.existsSync(f)) fs.unlinkSync(f);
      delete db.videos[id];
      store.commit();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  // تشغيل فيديو فعلي
  if (p.startsWith('/api/video/') && method === 'GET') {
    const id = p.split('/')[3];
    const v = db.videos[id];
    if (!v) return send(res, 404, { error: 'not found' });
    const f = path.join(VIDEO_DIR, v.file);
    if (!fs.existsSync(f)) return send(res, 404, { error: 'file missing' });
    const stat = fs.statSync(f);
    res.writeHead(200, {
      'Content-Type': v.mime || 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(f).pipe(res);
    return;
  }

  // تسجيل مشاهدة (مع مكافأة)
  if (p.startsWith('/api/videos/') && p.endsWith('/view') && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[3];
    const v = db.videos[id];
    if (!v) return send(res, 404, { error: 'not found' });
    const b = await body(req);
    const watched = Number(b.watchedPercent || 0);
    if (watched < db.config.minWatchPercent) return send(res, 400, { error: 'لازم تتفرج على الأقل ' + db.config.minWatchPercent + '%' });

    const key = a.user.id;
    const last = v.views[key] || 0;
    const now = Date.now();
    if (now - last < db.config.viewCooldownMs) {
      return send(res, 429, { error: 'اتحسبتلك المشاهدة قبل كده', waitMs: db.config.viewCooldownMs - (now - last) });
    }
    v.views[key] = now;

    // مكافأة المشاهدة + إيراد إعلان وهمي (محاكاة)
    const reward = wallet.add(a.user.id, db.config.rewardView, 'view', 'مشاهدة: ' + id);
    db.stats.adImpressions++;
    store.commit();
    return send(res, 200, { reward, views: Object.keys(v.views).length });
  }

  // إعجاب
  if (p.startsWith('/api/videos/') && p.endsWith('/like') && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[3];
    const v = db.videos[id]; if (!v) return send(res, 404, { error: 'not found' });
    const i = v.likes.indexOf(a.user.id);
    if (i === -1) { v.likes.push(a.user.id); wallet.add(a.user.id, db.config.rewardLike, 'like', 'إعجاب: ' + id); }
    else v.likes.splice(i, 1);
    store.commit();
    return send(res, 200, { likes: v.likes.length, liked: i === -1 });
  }

  // المحفظة والسجل
  if (p === '/api/wallet' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { wallet: wallet.getWallet(a.user.id), history: wallet.history(a.user.id) });
  }

  // مكافأة يومية
  if (p === '/api/wallet/claim' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const w = db.wallet[a.user.id];
    const today = wallet.todayKey();
    if (w.claimedDaily === today) {
      return send(res, 429, { error: 'جبت مكافأة اليوم بالفعل' });
    }
    w.claimedDaily = today;
    const r = wallet.add(a.user.id, db.config.rewardDaily, 'daily', 'مكافأة يومية');
    return send(res, 200, { reward: r });
  }

  // 🎙️ رفع تعليق صوتي (rate limit 20/دقيقة + حظر + pending + طابور مراجعة)
  if (p.startsWith('/api/videos/') && p.endsWith('/voice-comments') && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    if ((db.blockedUsers||{})[a.user.id]) return send(res, 403, { error: 'حسابك محظور بسبب إساءة' });
    const id = p.split('/')[3];
    if (!db.videos[id]) return send(res, 404, { error: 'not found' });
    if ((db.voiceSettings||{})[id]?.disabled) return send(res, 403, { error: 'التعليقات الصوتية معطلة على هذا الفيديو' });
    // Rate limit 20/min لكل مستخدم
    const now = Date.now();
    const rr = db.voiceRate || (db.voiceRate = {});
    const hits = (rr[a.user.id] || []).filter(t => now - t < 60000);
    if (hits.length >= 20) return send(res, 429, { error: 'طلبات كتير — حاول بعد دقيقة' });
    hits.push(now); rr[a.user.id] = hits;

    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/);
    if (!bm) return send(res, 400, { error: 'multipart مطلوب' });
    const form = parseMultipart(await rawBody(req, 2 * 1024 * 1024), bm[1].replace(/^"|"$/g, ''));
    const audio = form.audio;
    if (!audio || !audio.data || audio.data.length < 100) return send(res, 400, { error: 'ملف صوتي غير صالح' });
    if (audio.data.length > 2 * 1024 * 1024) return send(res, 400, { error: 'الملف أكبر من 2MB' });
    const dur = Math.min(60000, parseInt(form.durationMs) || 0);
    if (dur < 500) return send(res, 400, { error: 'التسجيل قصير جداً' });

    const cid = 'vc_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const ext = (audio.filename || '').endsWith('.mp4') ? 'm4a' : 'webm';
    const file = cid + '.' + ext;
    fs.writeFileSync(path.join(VIDEO_DIR, file), audio.data);

    // peaks تقريبية من حجم الملف (للـ waveform)
    const peaks = [];
    for (let i = 0; i < 40; i++) peaks.push(0.2 + Math.random() * 0.6);

    db.voiceComments = db.voiceComments || {};
    const list = db.voiceComments[id] || (db.voiceComments[id] = []);
    const rec = { id: cid, userId: a.user.id, file, durationMs: dur, ts: Date.now(),
                  status: 'pending', peaks, transcript: '', reports: 0 };
    list.push(rec);
    // أضف لطابور الإشراف (speech-to-text + toxicity filter — يكتمل بمفتاح API)
    db.moderationQueue = db.moderationQueue || [];
    db.moderationQueue.push({ commentId: cid, videoId: id, file, ts: now });
    store.commit();

    // 🤖 مراجعة تلقائية (محاكاة — لحد ما نربط speech-to-text حقيقي)
    // المحتوى الصوتي ما عندناش نص حالياً، فبنعتمد على قائمة الحظر والإبلاغات
    setTimeout(() => {
      const c = (db.voiceComments[id]||[]).find(x => x.id === cid);
      if (c && c.status === 'pending' && !(db.blockedUsers||{})[c.userId]) {
        c.status = 'approved'; c.transcript = '(صوت — تمت المراجعة الآلية)';
        db.moderationQueue = (db.moderationQueue||[]).filter(q => q.commentId !== cid);
        store.commit();
      }
    }, 1500);

    return send(res, 201, { ok: true, id: cid, status: 'pending', durationMs: dur });
  }

  // 🎙️ عرض التعليقات (ماعدا المحذوفة / المرفوضة؛ والصاحب يشوف pending بتاعه)
  if (p.startsWith('/api/videos/') && p.endsWith('/voice-comments') && method === 'GET') {
    const id = p.split('/')[3];
    const a = auth(req, db);
    const myId = a ? a.user.id : null;
    const list = (db.voiceComments || {})[id] || [];
    const visible = list.filter(c =>
      c.status === 'approved' || (myId && c.userId === myId && c.status !== 'deleted')
    );
    return send(res, 200, { comments: visible.map(c => ({
      id: c.id, durationMs: c.durationMs, ts: c.ts,
      isMe: myId === c.userId, status: c.status, peaks: c.peaks || [],
      url: '/api/voice/' + c.id,
    })) });
  }

  // 🎙️ حذف تعليق صوتي (الصاحب أو صاحب الفيديو)
  if (p.startsWith('/api/videos/') && p.endsWith('/voice-comments/') && method === 'DELETE' &&
      p.split('/').length === 7) {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const parts = p.split('/'); const id = parts[3], cid = parts[5];
    const video = db.videos[id]; if (!video) return send(res, 404, { error: 'not found' });
    const list = (db.voiceComments||{})[id] || [];
    const c = list.find(x => x.id === cid); if (!c) return send(res, 404, { error: 'not found' });
    if (c.userId !== a.user.id && video.owner !== a.user.id)
      return send(res, 403, { error: 'مش مسموح لك تحذف التعليق ده' });
    c.status = 'deleted';
    const f = path.join(VIDEO_DIR, c.file); if (fs.existsSync(f)) fs.unlinkSync(f);
    store.commit(); return send(res, 200, { ok: true });
  }

  // 🎙️ إبلاغ عن تعليق صوتي (3 بلاغات = حظر تلقائي)
  if (p.startsWith('/api/videos/') && p.endsWith('/report') && method === 'POST' &&
      p.includes('/voice-comments/')) {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const parts = p.split('/'); const id = parts[3], cid = parts[5];
    const list = (db.voiceComments||{})[id] || [];
    const c = list.find(x => x.id === cid); if (!c) return send(res, 404, { error: 'not found' });
    c.reports = (c.reports||0) + 1;
    let blocked = false;
    if (c.reports >= 3) {
      db.blockedUsers = db.blockedUsers || {}; db.blockedUsers[c.userId] = true;
      c.status = 'rejected'; blocked = true;
    }
    store.commit(); return send(res, 200, { ok: true, reports: c.reports, blocked });
  }

  // 🎙️ تفعيل/تعطيل التعليقات الصوتية (صاحب الفيديو بس)
  if (p.startsWith('/api/videos/') && p.endsWith('/voice-settings') && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[3];
    const video = db.videos[id]; if (!video) return send(res, 404, { error: 'not found' });
    if (video.owner !== a.user.id) return send(res, 403, { error: 'مش مسموح لك' });
    const b = await body(req);
    db.voiceSettings = db.voiceSettings || {};
    db.voiceSettings[id] = { disabled: !!b.disabled };
    store.commit(); return send(res, 200, { ok: true, disabled: !!b.disabled });
  }

  // 🎙️ طابور الإشراف (أدمن): اعتماد/رفض
  if (p === '/api/admin/moderation' && method === 'GET') {
    return send(res, 200, { queue: db.moderationQueue || [] });
  }
  if (p.startsWith('/api/admin/moderation/') && method === 'POST') {
    const cid = p.split('/')[4];
    const b = await body(req);
    for (const [vid, list] of Object.entries(db.voiceComments||{})) {
      const c = list.find(x => x.id === cid); if (!c) continue;
      c.status = b.approve ? 'approved' : 'rejected';
      c.transcript = String(b.transcript||'');
      db.moderationQueue = (db.moderationQueue||[]).filter(q => q.commentId !== cid);
      store.commit(); return send(res, 200, { ok: true, status: c.status });
    }
    return send(res, 404, { error: 'not found' });
  }

  // 🎙️ تشغيل ملف صوتي (للصاحب فقط لو pending)
  if (p.startsWith('/api/voice/') && method === 'GET') {
    const id = p.split('/')[3];
    let found = null;
    for (const list of Object.values(db.voiceComments || {})) {
      found = list.find(c => c.id === id); if (found) break;
    }
    if (!found || found.status === 'deleted' || found.status === 'rejected')
      return send(res, 404, { error: 'not found' });
    // الصاحب يقدر يسمع تعليقه_pending بالـ token في query (لأن <audio> ما بيبعتش header)
    const qToken = u.searchParams.get('token');
    const a = auth(req, db) || (qToken ? { user: db.users[qToken] } : null);
    if (found.status === 'pending' && (!a?.user || a.user.id !== found.userId))
      return send(res, 403, { error: 'قيد المراجعة' });
    const f = path.join(VIDEO_DIR, found.file);
    if (!fs.existsSync(f)) return send(res, 404, { error: 'file missing' });
    const stat = fs.statSync(f);
    res.writeHead(200, { 'Content-Type': f.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm',
      'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(f).pipe(res); return;
  }

  // 💡 حالة المهمة اليومية
  if (p === '/api/task/status' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const t = wallet.todayKey();
    const tk = db.tasks || (db.tasks = {});
    const rec = tk[a.user.id]?.date === t ? tk[a.user.id] : { date: t, watched: 0, claimedBonus: false };
    tk[a.user.id] = rec; store.commit();
    const cfg = db.config.dailyTask;
    return send(res, 200, {
      watched: rec.watched,
      target: cfg.adsPerDay,
      rewardPerAd: cfg.rewardPerAd,
      bonus: cfg.completionBonus,
      complete: rec.watched >= cfg.adsPerDay,
      bonusClaimed: rec.claimedBonus,
    });
  }

  // 💡 مشاهدة إعلان ضمن المهمة اليومية ( أدمن يكسب from الإعلان + المستخدم يكسب مكافأة )
  if (p === '/api/task/watch' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const t = wallet.todayKey();
    const tk = db.tasks || (db.tasks = {});
    let rec = tk[a.user.id]?.date === t ? tk[a.user.id] : { date: t, watched: 0, claimedBonus: false };
    const cfg = db.config.dailyTask;
    if (rec.watched >= cfg.adsPerDay) return send(res, 429, { error: 'خلصت المهام النهاردة — بكرة في مهام جديدة' });

    rec.watched++;
    tk[a.user.id] = rec;
    // المستخدم يكسب مكافأة الإعلان
    const userReward = wallet.add(a.user.id, cfg.rewardPerAd, 'task_ad', 'إعلان مهمة يومية');
    // الأدمن يكسب من الإعلان حسب نوعه الحقيقي
    const adType = ['banner','interstitial','rewarded'].includes(b.adType) ? b.adType : 'interstitial';
    const adPrice = db.config.adPrices[adType] || db.config.adPrices.interstitial;
    db.stats.adRevenue = Math.round(((db.stats.adRevenue || 0) + adPrice) * 100) / 100;
    db.stats.adImpressions++;
    db.stats.adByType = db.stats.adByType || {};
    db.stats.adByType[adType] = (db.stats.adByType[adType] || 0) + 1;

    let bonus = null;
    if (rec.watched >= cfg.adsPerDay && !rec.claimedBonus) {
      rec.claimedBonus = true;
      bonus = wallet.add(a.user.id, cfg.completionBonus, 'task_bonus', 'بونص إكمال المهام');
    }
    store.commit();
    return send(res, 200, { watched: rec.watched, target: cfg.adsPerDay, userReward, bonus, adminRevenue: db.config.adPrices.interstitial });
  }

  // إعلان (محاكاة دخل) — عشان نحسب if الربح يغطي المصروف
  if (p === '/api/ads/impression' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const b = await body(req);
    const type = ['banner','interstitial','rewarded'].includes(b.type) ? b.type : 'interstitial';
    const price = db.config.adPrices[type] || db.config.adRevenuePerView;
    // سجّل الدخل الفعلي (مش بس عدد) عشان الحاجز الاقتصادي يشتغل صح
    db.stats.adRevenue = Math.round(((db.stats.adRevenue||0) + price) * 100) / 100;
    db.stats.adImpressions++;
    db.stats.adByType = db.stats.adByType || {};
    db.stats.adByType[type] = (db.stats.adByType[type] || 0) + 1;
    store.commit();
    return send(res, 200, { ok: true, type, revenue: price, totalRevenue: db.stats.adRevenue });
  }

  /* ═══════════════════ COINS, GIFTS & LIVE ═══════════════════ */

  // 🪙 الحالة + الباقات + الهدايا (بيانات عامة)
  if (p === '/api/economy/catalog' && method === 'GET') {
    return send(res, 200, { packs:eco.COIN_PACKS.map(x=>({...x,total:eco.packTotal(x),
      perCoin:Math.round(eco.perCoin(x)*1000)/1000})), gifts:eco.GIFTS,
      pass:eco.PASS, levels:eco.SUPPORTER_LEVELS });
  }

  // 💰 رصيد المستخدم
  if (p === '/api/economy/wallet' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    const w = ensureCoins(db, a.user.id);
    return send(res, 200, { ...w, level:eco.supporterLevel(w.gifted),
      limits:(db.spendingLimits||{})[a.user.id]||{daily:500,monthly:2000} });
  }

  // 🛒 شراء (Google Play Billing — تحقق من الإيصال)
  if (p === '/api/economy/purchase' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    const prof = (db.userProfiles||{})[a.user.id];
    const band = prof?.ageBand || '18+';
    if (!eco.canPurchase(band)) return send(res, 403, { error:'الشراء متاح للبالغين 18+ بس' });
    const b = await body(req);
    const pack = eco.COIN_PACKS.find(x=>x.id===b.packId);
    if (!pack) return send(res, 400, { error:'باقة غير صالحة' });
    if (!b.receipt) return send(res, 400, { error:'إيصال الشراء مطلوب' });
    // تحقق الإيصال (محاكاة — لازم Google Play Developer API فعلي)
    const verified = verifyReceiptMock(b.receipt, pack);
    if (!verified) return send(res, 400, { error:'تعذر التحقق من الإيصال' });
    const w = ensureCoins(db, a.user.id);
    let total = eco.packTotal(pack);
    // مكافأة أول شحن لمرة واحدة (بدون مؤقتات وهمية)
    if (!w.firstBonusUsed) { total *= 2; w.firstBonusUsed = true; }
    w.balance += total; w.totalBought += total;
    db.purchases = db.purchases||[];
    db.purchases.push({ id:'pu_'+Date.now().toString(36), userId:a.user.id,
      packId:pack.id, coins:total, price:pack.priceEGP, ts:Date.now(), status:'verified', receipt:b.receipt });
    store.commit();
    return send(res, 200, { ok:true, added:total, balance:w.balance, firstBonus:total!==eco.packTotal(pack) });
  }

  // ↩️ استعادة المشتريات
  if (p === '/api/economy/restore' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    const mine = (db.purchases||[]).filter(x=>x.userId===a.user.id&&x.status==='verified');
    return send(res, 200, { purchases:mine.map(({receipt,...r})=>r) });
  }

  // 🎁 إرسال هدية (فيديو أو لايف)
  if (p === '/api/economy/gift' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    // 🗄️ لو Postgres متصل: استخدم الـ ledger الثابت
    if (dbLayer.available) {
      try {
        const b = await body(req);
        const g = eco.giftById(b.giftId); if (!g) return send(res,400,{error:'هدية غير صالحة'});
        const key = b.idempotencyKey || ('gift_' + Date.now() + '_' + Math.random().toString(36).slice(2));
        const senderNum = numericId(a.user.id), receiverNum = numericId(b.to);
        const tx = await walletDB.sendGift({ senderId:senderNum, receiverId:receiverNum,
          giftId:g.id, quantity:Math.min(99,Math.max(1,b.quantity||1)),
          videoId:b.videoId||null, liveId:b.liveId||null, key });
        return send(res, 200, { ok:true, tx, durable:true });
      } catch (e) {
        return send(res, e.code==='DUPLICATE'?200:400, { error:e.message });
      }
    }
    const prof = (db.userProfiles||{})[a.user.id];
    if (!eco.canGift(prof?.ageBand||'18+')) return send(res, 403, { error:'الهدايا متاحة للبالغين 18+ بس' });
    const b = await body(req);
    const g = eco.giftById(b.giftId);
    if (!g) return send(res, 400, { error:'هدية غير صالحة' });
    const w = ensureCoins(db, a.user.id);
    if (w.balance < g.coins) return send(res, 400, { error:'رصيد غير كافٍ' });
    // حدود الإنفاق
    const lim = (db.spendingLimits||{})[a.user.id]||{daily:500,monthly:2000};
    if (w.spentToday + g.coins > lim.daily) return send(res, 429, { error:'وصلت للحد اليومي — غيّره من الإعدادات' });
    // مكافحة الاحتيال
    const velocity = (db.giftTx||[]).filter(x=>x.from===a.user.id && Date.now()-x.ts<60000).length;
    if (eco.suspiciousGift(a.user.id, b.to||'', db.familyLinks ? Object.values(db.familyLinks).map(x=>[a.user.id,x]) : [], velocity))
      return send(res, 429, { error:'تم إيقاف الإرسال للاشتباه' });
    // خصم وإضافة
    w.balance -= g.coins; w.gifted += g.coins;
    w.spentToday += g.coins; w.spentMonth += g.coins;
    const creator = ensureCoins(db, b.to);
    const diamonds = Math.round(g.coins * 0.5);
    creator.diamonds += diamonds;
    const combo = Math.min(99, (b.combo||1));
    db.giftTx = db.giftTx||[];
    db.giftTx.push({ id:'gt_'+Date.now().toString(36), from:a.user.id, to:b.to,
      giftId:g.id, coins:g.coins, combo, videoId:b.videoId||null, liveId:b.liveId||null,
      ts:Date.now(), flagged:eco.amlFlag(g.coins,w.spentToday) });
    db.supporter = db.supporter||{};
    const sup = db.supporter[b.to] || (db.supporter[b.to]={supporters:{},week:{}});
    sup.supporters[a.user.id] = (sup.supporters[a.user.id]||0) + g.coins;
    store.commit();
    return send(res, 200, { ok:true, gift:g, diamonds, combo, balance:w.balance,
      creatorDiamonds:creator.diamonds });
  }

  // 🏆 لوحة الداعمين + المستويات
  if (p.startsWith('/api/economy/supporters/') && method === 'GET') {
    const creatorId = p.split('/')[4];
    const sup = (db.supporter||{})[creatorId]||{supporters:{}};
    const list = Object.entries(sup.supporters).map(([uid,coins])=>({uid,coins,
      level:eco.supporterLevel(coins).name, ico:eco.supporterLevel(coins).ico}))
      .sort((x,y)=>y.coins-x.coins).slice(0,10);
    return send(res, 200, { list, crown:list[0]||null });
  }

  // 🔴 لايف (18+ و100 متابع)
  if (p === '/api/economy/live/start' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    const prof = (db.userProfiles||{})[a.user.id];
    const followers = 100; // مبسّط — من social
    if (!eco.canHostLive(prof?.ageBand||'18+', followers)) return send(res, 403, { error:'اللايف محتاج 18+ و100 متابع' });
    const b = await body(req);
    const id = 'live_'+Date.now().toString(36);
    db.lives = db.lives||{};
    db.lives[id] = { id, host:a.user.id, title:String(b.title||'لايف').slice(0,80),
      viewers:0, chat:[], gifts:[], status:'live', startedAt:Date.now() };
    store.commit(); return send(res, 200, { ok:true, id });
  }
  if (p.startsWith('/api/economy/live/') && p.endsWith('/end') && method === 'POST') {
    const id = p.split('/')[4], a = auth(req, db);
    const lv = (db.lives||{})[id]; if(!lv) return send(res,404,{error:'not found'});
    if (lv.host!==a?.user?.id) return send(res,403,{error:'مش مسموح'});
    lv.status='ended'; lv.endedAt=Date.now(); store.commit();
    return send(res,200,{ok:true,durationMs:lv.endedAt-lv.startedAt});
  }
  if (p === '/api/economy/live/active' && method === 'GET') {
    const list = Object.values(db.lives||{}).filter(x=>x.status==='live')
      .map(x=>({id:x.id,host:x.host,title:x.title,viewers:x.viewers,startedAt:x.startedAt}));
    return send(res, 200, { lives:list });
  }

  // 💳 حدود الإنفاق + السجل
  if (p === '/api/economy/limits' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res,401,{error:'unauthorized'});
    const b = await body(req);
    db.spendingLimits = db.spendingLimits||{};
    db.spendingLimits[a.user.id] = {
      daily:Math.min(2000,Math.max(10,Number(b.daily)||500)),
      monthly:Math.min(10000,Math.max(50,Number(b.monthly)||2000)) };
    store.commit(); return send(res,200,{ok:true});
  }
  if (p === '/api/economy/history' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res,401,{error:'unauthorized'});
    return send(res, 200, {
      purchases:(db.purchases||[]).filter(x=>x.userId===a.user.id).map(({receipt,...r})=>r),
      gifts:(db.giftTx||[]).filter(x=>x.from===a.user.id),
      refunds:(db.refunds||[]).filter(x=>x.userId===a.user.id) });
  }
  if (p === '/api/economy/refund' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res,401,{error:'unauthorized'});
    const b = await body(req);
    const pu = (db.purchases||[]).find(x=>x.id===b.purchaseId&&x.userId===a.user.id);
    if (!pu) return send(res,404,{error:'not found'});
    db.refunds = db.refunds||[];
    db.refunds.push({ id:'rf_'+Date.now().toString(36), userId:a.user.id,
      purchaseId:pu.id, status:'pending', ts:Date.now() });
    store.commit(); return send(res,200,{ok:true,status:'pending'});
  }

  /* ═══════════════════ TRUST & SAFETY ═══════════════════ */

  // 🔞 بوابة العمر (DOB في أول تشغيل) — Under 13 → بلوك من غير حفظ
  if (p === '/api/safety/age' && method === 'POST') {
    const b = await body(req);
    const dob = b.dob;
    const age = safety.ageFromDOB(dob);
    if (age == null || !dob || isNaN(new Date(dob).getTime()))
      return send(res, 400, { error: 'تاريخ ميلاد غير صالح' });
    if (age < safety.MIN_AGE)
      return send(res, 403, { error: 'لا يمكن إنشاء حساب قبل سن 13', blocked:true, noRetention:true });
    const band = safety.tier(age);
    // لا نحفظ الـ DOB الخام — بس الفئة + سنة الميلاد للتحقق
    const token = b.guestToken || '';
    db.userProfiles = db.userProfiles || {};
    db.userProfiles[token] = { ageBand:band, birthYear:new Date(dob).getFullYear(),
      verifiedAt:Date.now(), needsReview:false };
    return send(res, 200, { ok:true, band, rules:safety.TIER_RULES[band] });
  }
  if (p === '/api/safety/age' && method === 'GET') {
    const a = auth(req, db);
    const prof = (db.userProfiles||{})[a?.user?.id] || null;
    return send(res, 200, { profile:prof, rules:prof?safety.TIER_RULES[prof.ageBand]:null });
  }

  // 🛡️ فحص محتوى نصي (لكل الحقول)
  if (p === '/api/safety/check' && method === 'POST') {
    const b = await body(req);
    const r = safety.checkText(b.text);
    return send(res, 200, r);
  }

  // 🚨 بلاغ عام (فيديو/تعليق/صوتي/بروفايل/لايف/رسالة) بأولوية طفل
  if (p === '/api/safety/report' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    const b = await body(req);
    const reason = String(b.reason||'other');
    const childPriority = safety.isSevere(reason) || ['csam','grooming'].includes(reason);
    db.safetyReports = db.safetyReports || [];
    db.safetyReports.push({ id:'sr_'+Date.now().toString(36), reporter:a.user.id,
      targetId:b.targetId||'', targetType:b.targetType||'video', reason,
      detail:String(b.detail||'').slice(0,300), priority:childPriority?'critical':'normal',
      status:'open', ts:Date.now() });
    store.commit();
    return send(res, 200, { ok:true, priority:childPriority?'critical':'normal',
      message:childPriority?'تم تصعيد البلاغ للأولوية القصوى':'تم استلام البلاغ' });
  }

  // ⚖️ عقوبات/درجات (داخلي + استئناف)
  if (p === '/api/safety/strikes' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    return send(res, 200, { strikes:(db.strikes||{})[a.user.id]||{strikes:0,status:'active'}, policy:safety.POLICY });
  }
  if (p === '/api/safety/appeal' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    const b = await body(req);
    db.appeals = db.appeals||[];
    db.appeals.push({ id:'ap_'+Date.now().toString(36), userId:a.user.id,
      text:String(b.text||'').slice(0,500), status:'pending', ts:Date.now() });
    store.commit(); return send(res, 200, { ok:true });
  }

  // 👮 لوحة المراجعة البشرية (مراجع + blur افتراضي + سجل تدقيق)
  if (p === '/api/safety/review/queue' && method === 'GET') {
    const q = db.safetyReports||[];
    const sorted = [...q].sort((x,y)=>
      (x.priority==='critical'?0:1)-(y.priority==='critical'?0:1) || x.ts-y.ts);
    return send(res, 200, { queue:sorted.slice(0,100), blurred:true });
  }
  if (p.startsWith('/api/safety/review/') && method === 'POST') {
    const id = p.split('/')[4], b = await body(req);
    const r = (db.safetyReports||[]).find(x=>x.id===id); if(!r) return send(res,404,{error:'not found'});
    // حظر نهائي يحتاج مراجع ثاني
    if (b.action==='ban' && !b.secondReviewer)
      return send(res, 409, { error:'الحظر النهائي يحتاج مراجع ثاني' });
    r.status = b.action; r.reviewedAt = Date.now();
    r.audit = r.audit||[]; r.audit.push({ action:b.action, reviewer:b.reviewer||'admin', ts:Date.now() });
    if (r.reporter) { /* إشعار للمبلّغ */ }
    store.commit(); return send(res, 200, { ok:true, action:b.action });
  }

  // 📊 أرقام الشفافية + السياسة في التطبيق
  if (p === '/api/safety/policy' && method === 'GET') {
    return send(res, 200, { policy:safety.POLICY, reasons:safety.REASONS,
      minAge:safety.MIN_AGE, tiers:safety.TIER_RULES,
      transparency:{ removals:(db.safetyReports||[]).filter(x=>x.status==='remove').length,
        bans:(db.safetyReports||[]).filter(x=>x.status==='ban').length,
        appeals:(db.appeals||[]).length } });
  }

  /* ═══════════════════ CREATOR STUDIO ═══════════════════ */

  const ensureCoins = (db, uid) => {
    db.coins = db.coins || {};
    if (!db.coins[uid]) db.coins[uid] = { balance:0, totalBought:0, gifted:0,
      diamonds:0, spentToday:0, spentMonth:0, firstBonusUsed:false, passUntil:0 };
    return db.coins[uid];
  };
  // محاكاة تحقق الإيصال — لازم Google Play Developer API في الإنتاج
  const verifyReceiptMock = (receipt, pack) =>
    typeof receipt === 'string' && receipt.startsWith('gp_') && receipt.includes(pack.id);

  const emptyAgg = () => ({
    summary:{views:0,watchTime:0,avgWatched:0,likes:0,comments:0,shares:0,followers:0},
    daily:[], sources:{foryou:0,following:0,search:0,profile:0,share:0},
    audience:{ages:{},gender:{},countries:{},cities:{}}, activeHours:Array(24).fill(0),
    updatedAt:null,
  });
  const buildInsights = (agg,videos) => {
    const tips=[];
    const short=videos.filter(v=>v.avgWatched>70).length;
    if(short)tips.push(`👏 ${short} فيديوهات عندها إكمال مشاهدة فوق 70% — استمر على نفس الطول`);
    if(agg.activeHours.length){
      const best=agg.activeHours.indexOf(Math.max(...agg.activeHours));
      tips.push(`⏰ أفضل وقت للنشر: ${best}:00 – ${(best+2)%24}:00`);
    }
    if((agg.sources.foryou||0)>(agg.sources.following||0)*2)
      tips.push('🔥 «لك» بيجيب لك مشاهدات أكتر — ركّز على محتوى ينتشر');
    if(!tips.length)tips.push('📈 ارفع فيديوهات أكتر عشان تظهر لك رؤى دقيقة');
    return tips;
  };

  // 👤 تحليلات الصانع (من الـ aggregates المحسوبة)
  if (p === '/api/creator/analytics' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const agg = (db.aggregates||{})[a.user.id] || emptyAgg();
    const mine = Object.values(db.videos).filter(v => v.owner === a.user.id);
    const perVideo = mine.map(v => {
      const va = (v.analytics || {});
      return { id:v.id, caption:v.caption, views:va.views||0, avgWatched:va.avgWatched||0,
               watchTime:va.watchTime||0, likes:(v.likes||[]).length, shares:va.shares||0,
               retention:va.retention||[] };
    }).sort((x,y)=>y.views-x.views);
    return send(res, 200, { summary:agg.summary, daily:agg.daily, videos:perVideo,
      sources:agg.sources, audience:agg.audience, activeHours:agg.activeHours,
      insights:buildInsights(agg,perVideo), updatedAt:agg.updatedAt });
  }

  // 📄 تصدير CSV
  if (p === '/api/creator/analytics.csv' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const mine = Object.values(db.videos).filter(v => v.owner === a.user.id);
    let csv = 'video_id,caption,views,avg_watched_pct,watch_time_s,likes,shares\n';
    for (const v of mine) {
      const va=v.analytics||{};
      csv += [v.id, '"'+String(v.caption||'').replace(/"/g,'""')+'"', va.views||0,
        va.avgWatched||0, Math.round(va.watchTime||0), (v.likes||[]).length, va.shares||0].join(',')+'\n';
    }
    res.writeHead(200, {'Content-Type':'text/csv; charset=utf-8',
      'Content-Disposition':'attachment; filename="vibe-analytics.csv"','Access-Control-Allow-Origin':'*'});
    res.end(csv); return;
  }

  // 📅 جدولة بوست
  if (p === '/api/creator/schedule' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const b = await body(req);
    if (!b.file || !b.publishAt) return send(res, 400, { error: 'ملف ووقت مطلوبين' });
    const when = new Date(b.publishAt).getTime();
    if (!when || when < Date.now()) return send(res, 400, { error: 'الوقت لازم يكون في المستقبل' });
    const j = { id:'sch_'+Date.now().toString(36), userId:a.user.id,
      caption:String(b.caption||'').slice(0,300), tags:String(b.tags||''),
      data:b.file, mime:b.mime||'video/mp4', publishAt:when, status:'scheduled', attempts:0 };
    db.scheduled = db.scheduled || []; db.scheduled.push(j); store.commit();
    return send(res, 201, { ok:true, job:{id:j.id,publishAt:j.publishAt,status:j.status} });
  }
  if (p === '/api/creator/schedule' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { jobs:(db.scheduled||[]).filter(x=>x.userId===a.user.id)
      .map(({data,...rest})=>rest) });
  }
  if (p.startsWith('/api/creator/schedule/') && method === 'DELETE') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[4];
    db.scheduled = (db.scheduled||[]).filter(x=>!(x.id===id&&x.userId===a.user.id));
    store.commit(); return send(res, 200, { ok:true });
  }
  if (p.startsWith('/api/creator/schedule/') && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[4], b = await body(req);
    const j = (db.scheduled||[]).find(x=>x.id===id&&x.userId===a.user.id);
    if (!j) return send(res, 404, { error:'not found' });
    if (b.publishAt) j.publishAt = new Date(b.publishAt).getTime();
    if (b.caption!==undefined) j.caption = String(b.caption).slice(0,300);
    store.commit(); return send(res, 200, { ok:true, publishAt:j.publishAt });
  }

  // ✏️ المسودات
  if (p === '/api/creator/drafts' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { drafts:(db.drafts||{})[a.user.id]||[] });
  }
  if (p === '/api/creator/drafts' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const b = await body(req);
    db.drafts = db.drafts || {};
    const list = db.drafts[a.user.id] || (db.drafts[a.user.id] = []);
    const d = { id:b.id||('dr_'+Date.now().toString(36)), caption:String(b.caption||'').slice(0,300),
      tags:String(b.tags||''), filter:b.filter||null, sound:b.sound||null,
      data:b.data||null, updatedAt:Date.now() };
    const i = list.findIndex(x=>x.id===d.id); if(i>=0)list[i]=d; else list.unshift(d);
    store.commit(); return send(res, 200, { ok:true, draft:{id:d.id,updatedAt:d.updatedAt} });
  }
  if (p.startsWith('/api/creator/drafts/') && method === 'DELETE') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[4];
    db.drafts[a.user.id] = ((db.drafts||{})[a.user.id]||[]).filter(x=>x.id!==id);
    store.commit(); return send(res, 200, { ok:true });
  }

  // 💰 الأرباح والسحب
  if (p === '/api/creator/earnings' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const w = (db.wallet||{})[a.user.id]||{balance:0,totalEarned:0};
    const perVideo = Object.values(db.videos).filter(v=>v.owner===a.user.id).map(v=>({
      id:v.id, caption:v.caption, earned:Math.round(((v.analytics||{}).earned||0)*100)/100 }));
    return send(res, 200, { available:w.balance, pending:0, total:w.totalEarned,
      perVideo, payouts:(db.payouts||[]).filter(x=>x.userId===a.user.id),
      minPayout:20 });
  }
  if (p === '/api/creator/payout' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const b = await body(req), amount = Number(b.amount), MIN=20;
    const w = (db.wallet||{})[a.user.id];
    if (!w || w.balance < MIN) return send(res, 400, { error: 'الحد الأدنى للسحب '+MIN+' ج.م' });
    if (!amount || amount < MIN || amount > w.balance) return send(res, 400, { error: 'مبلغ غير صالح' });
    if (!['vodafone','instapay'].includes(b.method)) return send(res, 400, { error: 'طريقة دفع غير صالحة' });
    w.balance = Math.round((w.balance-amount)*100)/100;
    db.payouts = db.payouts||[];
    db.payouts.push({ id:'po_'+Date.now().toString(36), userId:a.user.id, amount,
      method:b.method, account:String(b.account||'').slice(0,50), status:'pending', ts:Date.now() });
    store.commit(); return send(res, 200, { ok:true });
  }

  // 🖼️ A/B test للغلاف
  if (p.startsWith('/api/creator/ab/') && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[4], b = await body(req);
    const v = db.videos[id]; if (!v || v.owner!==a.user.id) return send(res, 403, { error:'مش مسموح' });
    db.abTests = db.abTests||{};
    db.abTests[id] = { covers:b.covers||[], assignments:{}, impressions:{a:0,b:0}, winner:null };
    store.commit(); return send(res, 200, { ok:true });
  }
  if (p.startsWith('/api/creator/ab/') && p.endsWith('/assign') && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[4], t = (db.abTests||{})[id];
    if (!t || t.covers.length<2) return send(res, 200, { cover:null });
    const key = t.winner ? (t.winner==='a'?0:1) : (Math.random()<0.5?0:1);
    const label = key===0?'a':'b';
    t.impressions[label] = (t.impressions[label]||0)+1;
    if (!t.winner && (t.impressions.a+t.impressions.b)>=500) {
      t.winner = t.impressions.a>=t.impressions.b?'a':'b';
    }
    store.commit(); return send(res, 200, { cover:t.covers[key], label, winner:t.winner });
  }

  // ⬇️ تنزيل فيديو (الصانع ينزّل بتاعه نظيف / الغير بس لو مسموح + كريديت)
  if (p.startsWith('/api/download/') && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/')[3], v = db.videos[id];
    if (!v) return send(res, 404, { error:'not found' });
    const own = v.owner===a.user.id;
    const allowed = own || (db.creatorSettings||{})[v.owner]?.allowDownloads;
    if (!allowed) return send(res, 403, { error: 'الصانع مش سمح بالتنزيل' });
    const f = path.join(VIDEO_DIR, v.file);
    if (!fs.existsSync(f)) return send(res, 404, { error:'file missing' });
    res.writeHead(200, { 'Content-Type':v.mime||'video/mp4',
      'Content-Disposition':`attachment; filename="vibe-${id}.mp4"`,
      'X-VIBE-Credit': own?'none':('@'+(Object.values(db.users).find(u=>u.id===v.owner)?.deviceId||'creator')),
      'Access-Control-Allow-Origin':'*' });
    fs.createReadStream(f).pipe(res); return;
  }
  if (p === '/api/creator/settings' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error:'unauthorized' });
    const b = await body(req);
    db.creatorSettings = db.creatorSettings||{};
    db.creatorSettings[a.user.id] = { allowDownloads:!!b.allowDownloads };
    store.commit(); return send(res, 200, { ok:true });
  }

  // إحصائيات الأدمن
  if (p === '/api/admin/stats' && method === 'GET') {
    return send(res, 200, {
      stats: db.stats,
      config: db.config,
      users: Object.keys(db.users).length,
      videos: Object.keys(db.videos).length,
      reports: Object.values(db.reports||{}).reduce((s,r)=>s+r.length,0),
      revenueEstimate: Math.round((db.stats.adRevenue ?? (db.stats.adImpressions * db.config.adRevenuePerView)) * 100) / 100,
      adByType: db.stats.adByType || {},
      spent: db.stats.totalSpent,
      profit: Math.round((db.stats.adImpressions * db.config.adRevenuePerView - db.stats.totalSpent) * 100) / 100,
    });
  }

  // تعديل الإعدادات (للاستخدام المحلي/التجريبي)
  if (p === '/api/admin/config' && method === 'POST') {
    const b = await body(req);
    for (const k of Object.keys(db.config)) {
      if (b[k] !== undefined) {
        if (k === 'adPrices' && typeof b[k] === 'object') db.config[k] = { ...db.config[k], ...b[k] };
        else db.config[k] = b[k];
      }
    }
    store.commit();
    return send(res, 200, { config: db.config });
  }

  // صفحة الأدمن
  if (p === '/admin' && method === 'GET') {
    const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  return send(res, 404, { error: 'not found', path: p });
}

function publicVideo(v) {
  return {
    id: v.id, owner: v.owner, caption: v.caption, tags: v.tags,
    size: v.size, mime: v.mime, createdAt: v.createdAt,
    likes: v.likes.length, views: Object.keys(v.views).length,
    url: '/api/video/' + v.id,
  };
}

/* ---------- START ---------- */
const server = http.createServer((req, res) => {
  route(req, res).catch(e => {
    console.error('[err]', e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  });
});
server.listen(PORT, () => {
  console.log(`VIBE backend running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
