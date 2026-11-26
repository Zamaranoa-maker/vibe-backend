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
const moderation = require('./lib/moderation-free');
const storageGuard = require('./lib/storage-guard');
const growth = require('./lib/growth');

// 🚀 For You v1 — دوال SQL (security definer) لما Postgres يكون متصل
async function recordEventSQL(userId, videoId, event, watchMs = 0, ratio = 0) {
  if (!dbLayer.available || !videoId) return false;
  try {
    const pool = dbLayer.getPool();
    await pool.query('SELECT record_video_event($1,$2,$3,$4,$5)',
      [numericId(userId), numericId(videoId), event, watchMs, ratio]);
    return true;
  } catch (e) { return false; }
}

// 🚧 Phase 0 — الميزات المدفوعة مخفية (No paid services, no real-money features)
const PHASE0_DISABLED = new Set(['coins','gifts','live','payouts']);
function phase0Block(res, feature) {
  return send(res, 403, { error:'هذه الميزة غير متاحة في إصدار Phase 0', feature, phase:'free-launch' });
}
const dbLayer = require('./lib/db');

/* ---------- يوزر + باسورد (scrypt، بدون مكتبات مدفوعة) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hex] = stored.split(':');
  const a = crypto.scryptSync(String(pw), salt, 64);
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
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
  res.end(Buffer.isBuffer(data) ? data : (typeof data === 'string' ? data : JSON.stringify(data)));
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

  // 🚧 Phase 0: حظر الميزات المدفوعة (عملات/هدايا/لايف/سحب فلوس)
  if (p.startsWith('/api/economy/') && !p.includes('/catalog') && !p.includes('/wallet'))
    return phase0Block(res, 'economy');
  if (p.startsWith('/api/creator/payout') && method === 'POST') return phase0Block(res, 'payouts');

  if (method === 'OPTIONS') return send(res, 204, '');

  // Health
  if (p === '/api/health' && method === 'GET') {
    return send(res, 200, { ok: true, users: Object.keys(db.users).length, videos: Object.keys(db.videos).length });
  }

  // تسجيل/دخول جهاز
  /* ─── يوزر + باسورد ─── */
  if (p === '/api/auth/register' && method === 'POST') {
    const b = await body(req);
    const username = String(b.username || '').trim().slice(0, 30);
    const pw = String(b.password || '');
    if (!/^[\p{L}\p{N}_]{3,30}$/u.test(username)) return send(res, 400, { error: 'اليوزر من 3 لـ 30 حرف أو رقم أو _' });
    if (pw.length < 6) return send(res, 400, { error: 'الباسورد على الأقل 6 حروف' });
    try {
      if (dbLayer.available) {
        const pool = dbLayer.getPool();
        const exists = await pool.query('SELECT 1 FROM users WHERE username=$1 OR external_id=$1', [username]);
        if (exists.rows.length) return send(res, 409, { error: 'اليوزر مستخدم قبل كده' });
        const id = numericId(username);
        await pool.query(`INSERT INTO users(id,username,external_id,status,password_hash)
          VALUES($1,$2,$2,'active',$3)`, [id, username, hashPassword(pw)]);
        await pool.query(`INSERT INTO profiles(id,username,display_name) VALUES($1,$2,$2)
          ON CONFLICT (id) DO NOTHING`, [id, username]);
      }
      let found = Object.entries(db.users).find(([, v]) => v.deviceId === username);
      let token = found ? found[0] : crypto.randomBytes(24).toString('hex');
      if (!found) {
        const user = { id: username, deviceId: username, createdAt: Date.now() };
        db.users[token] = user;
        db.stats.signups++;
        wallet.ensure(username);
        store.commit();
      }
      return send(res, 201, { token, user: { id: username, username }, isNew: true });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const b = await body(req);
    const username = String(b.username || '').trim().slice(0, 30);
    const pw = String(b.password || '');
    try {
      let ok = false, dbId = null;
      if (dbLayer.available) {
        const r = await dbLayer.getPool().query(
          'SELECT id,password_hash FROM users WHERE username=$1', [username]);
        if (r.rows[0]) { ok = verifyPassword(pw, r.rows[0].password_hash); dbId = r.rows[0].id; }
      }
      if (!ok) return send(res, 401, { error: 'اليوزر أو الباسورد غلط' });
      let found = Object.entries(db.users).find(([, v]) => v.deviceId === username);
      let token = found ? found[0] : crypto.randomBytes(24).toString('hex');
      if (!found) {
        db.users[token] = { id: username, deviceId: username, createdAt: Date.now() };
        wallet.ensure(username);
        store.commit();
      }
      return send(res, 200, { token, user: { id: username, username, dbId }, ok: true });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  if (p === '/api/auth/session' && method === 'GET') {
    const a = auth(req, db);
    if (!a) return send(res, 200, { loggedIn: false });
    let admin = false, dbId = null, ageTier = null;
    if (dbLayer.available) {
      try {
        const r = await dbLayer.getPool().query(
          `SELECT u.id, p.age_tier, is_admin(u.id) adm FROM users u
           LEFT JOIN profiles p ON p.id=u.id WHERE u.external_id=$1`, [String(a.user.id)]);
        if (r.rows[0]) { dbId = r.rows[0].id; admin = !!r.rows[0].adm; ageTier = r.rows[0].age_tier; }
      } catch (e) {}
    }
    return send(res, 200, { loggedIn: true, user: { id: a.user.id, username: a.user.id }, dbId, admin, ageTier });
  }

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
    if (buf.length > 25 * 1024 * 1024) return send(res, 400, { error: 'الفيديو كبير جداً (أقصى 25MB)' });
    // 💾 حاجز التخزين اليومي
    const guard = storageGuard.canUpload(buf.length);
    if (!guard.ok) return send(res, 429, { error: guard.message, reason: guard.reason });
    if (!sec.isRealVideo(buf)) return send(res, 400, { error: 'الملف مش فيديو صالح (MP4/WebM بس)' });
    // 🛡️ فلتر المحتوى: كلمات ممنوعة في الوصف/الهاشتاجات
    const mod = moderation.checkTextLocal(String(b.caption||'') + ' ' + String(b.tags||''));
    if (mod.flagged) return send(res, 400, { error: 'المحتوى مخالف لمعايير المجتمع ❌', hits:mod.hits });
    const id = 'v_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const ext = (b.mime || 'video/mp4').includes('webm') ? 'webm' : 'mp4';
    const file = path.join(VIDEO_DIR, id + '.' + ext);
    fs.writeFileSync(file, buf);
    storageGuard.logUsage(buf.length);
    // 🗄️ سجّل الفيديو في Postgres عشان الـ For You ranking يشتغل
    if (dbLayer.available) {
      try {
        const pg = dbLayer.getPool();
        const r = await pg.query(
          `INSERT INTO videos (creator_id, category, duration_ms, file, caption)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [numericId(a.user.id), String(b.tags||'general').split(' ')[0]||'general',
           parseInt(b.durationMs)||15000, path.basename(file), String(b.caption||'').slice(0,300)]);
        db.videos[id] && (db.videos[id].pgId = r.rows[0].id);
        store.commit();
      } catch (e) { console.warn('[pg video] failed:', e.message); }
    }
    db.videos[id] = {
      id, owner: a.user.id, caption: sec.esc(String(b.caption || '')).slice(0, 300),
      tags: sec.esc(String(b.tags || '')).slice(0, 100), file: path.basename(file),
      size: buf.length, mime: b.mime || 'video/mp4',
      createdAt: Date.now(), likes: [], views: {}, status: 'pending',
    };
    store.commit();
    const r = wallet.add(a.user.id, db.config.rewardUpload, 'upload', 'رفع فيديو: ' + id);
    return send(res, 201, { video: publicVideo(db.videos[id]), reward: r });
  }

  // liste الفيديوهات — For You v1 ranking
  if (p === '/api/videos' && method === 'GET') {
    const a = auth(req, db);
    // 🚀 لو Postgres متصل: استخدم دوال الـ ranking الحقيقية
    if (dbLayer.available && u.searchParams.get('feed') === 'foryou' && a) {
      try {
        const pool = dbLayer.getPool();
        const { rows } = await pool.query('SELECT * FROM get_for_you($1,30,$2::bigint[])',
          [numericId(a.user.id), []]);
        const vids = rows.map(r => {
          // ابحث بالـ pgId المخزّن وقت الرفع، أو بالمعرّف النصي
          const v = Object.values(db.videos).find(x =>
            String(x.pgId||'') === String(r.video_id) || x.id === String(r.video_id));
          if (!v) return null;
          const out = publicVideo(v); out.source = r.source; return out;
        }).filter(Boolean);
        if (vids.length) return send(res, 200, { videos:vids, ranked:true });
      } catch (e) { /* fallback للـ JSON ranking */ }
    }
    // 🛡️ المحتوى غير المعتمد لا يظهر للغير (إلا لصاحبه)
    const me = a ? a.user.id : null;
    let list = Object.values(db.videos).filter(v =>
      !(db.hiddenVideos||{})[v.id] &&
      ((v.status || 'approved') === 'approved' || v.owner === me));

    if (u.searchParams.get('feed') === 'foryou') {
      const now = Date.now();
      const scored = list.map(v => {
        const an = v.analytics || {};
        const likes = (v.likes||[]).length;
        const views = an.views || 0;
        const completion = views ? (an.avgWatched||0)/100 : 0.2;
        const engagement = views ? likes/views : 0;
        const ageHours = (now - v.createdAt)/3600000;
        const recency = Math.max(0, 1 - ageHours/72);
        // بونص صغير للمبدعين الجدد (exposure test)
        const creatorVideos = Object.values(db.videos).filter(x=>x.owner===v.owner).length;
        const newCreatorBoost = creatorVideos <= 3 ? 0.15 : 0;
        return { v, score: completion*0.4 + engagement*0.3 + recency*0.2 + newCreatorBoost };
      });
      scored.sort((a,b) => b.score - a.score);
      // diversity: حد أقصى فيديوين لكل صانع في أول 12
      const seen = {}, out = [];
      for (const s of scored) {
        const c = seen[s.v.owner]||0;
        if (c >= 2 && out.length >= 6) continue;
        seen[s.v.owner] = c+1; out.push(s.v);
        if (out.length >= 30) break;
      }
      list = out;
    } else {
      list.sort((x,y)=>y.createdAt-x.createdAt);
    }
    return send(res, 200, { videos: list.map(v => publicVideo(v)) });
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

  /* ═══════════════════ SEARCH / HASHTAGS / TRENDING ═══════════════════ */
  if (dbLayer.available) {
    const pool = dbLayer.getPool();
    const uidOf = req => { const a = auth(req, db); return a ? numericId(a.user.id) : 0; };

    if (p === '/api/search' && method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const page = Math.max(0, parseInt(u.searchParams.get('page') || '0'));
      try {
        const guard = await pool.query('SELECT search_guard($1) g', [q]);
        const action = guard.rows[0]?.g || 'ok';
        if (action === 'support') return send(res, 200, { support:true, videos:[], users:[] });
        if (action === 'hide') return send(res, 200, { support:false, videos:[], users:[] });
        const [v, us] = await Promise.all([
          pool.query('SELECT * FROM search_videos($1,$2,20,$3)', [uidOf(req), q, page*20]),
          page === 0 ? pool.query('SELECT * FROM search_users($1,$2,10)', [uidOf(req), q]) : Promise.resolve({rows:[]}),
        ]);
        return send(res, 200, { support:false, videos:v.rows.map(r=>String(r.video_id)), users:us.rows, page });
      } catch (e) { return send(res, 500, { error:e.message }); }
    }
    if (p === '/api/search/suggest' && method === 'GET') {
      try {
        const r = await pool.query('SELECT * FROM search_suggest($1)', [u.searchParams.get('q') || '']);
        return send(res, 200, { suggestions:r.rows });
      } catch (e) { return send(res, 200, { suggestions:[] }); }
    }
    if (p === '/api/hashtag' && method === 'GET') {
      try {
        const r = await pool.query('SELECT * FROM get_hashtag_videos($1,$2,20,$3)',
          [uidOf(req), u.searchParams.get('tag') || '', Math.max(0, parseInt(u.searchParams.get('page')||'0'))*20]);
        return send(res, 200, { videos:r.rows.map(x=>String(x.video_id)) });
      } catch (e) { return send(res, 200, { videos:[] }); }
    }
    if (p === '/api/trending' && method === 'GET') {
      try {
        const [tags, vids] = await Promise.all([
          pool.query('SELECT * FROM get_trending_hashtags(15)'),
          pool.query('SELECT * FROM get_trending_videos($1,20,0)', [uidOf(req)]),
        ]);
        return send(res, 200, { tags:tags.rows, videos:vids.rows.map(x=>String(x.video_id)) });
      } catch (e) { return send(res, 200, { tags:[], videos:[] }); }
    }
    if (p === '/api/admin/search-terms' && method === 'GET') {
      const r = await pool.query('SELECT * FROM blocked_search_terms ORDER BY term');
      return send(res, 200, { terms:r.rows });
    }
    if (p === '/api/admin/search-terms' && method === 'POST') {
      const b = await body(req);
      await pool.query('INSERT INTO blocked_search_terms(term,action) VALUES ($1,$2) ON CONFLICT (term) DO UPDATE SET action=EXCLUDED.action', [b.term, b.action||'hide']);
      return send(res, 200, { ok:true });
    }
    if (p.startsWith('/api/admin/search-terms/') && method === 'DELETE') {
      await pool.query('DELETE FROM blocked_search_terms WHERE term=$1', [decodeURIComponent(p.split('/')[4])]);
      return send(res, 200, { ok:true });
    }
    if (p === '/api/admin/hashtags' && method === 'GET') {
      const r = await pool.query('SELECT * FROM trending_hashtags ORDER BY trend_score DESC LIMIT 50');
      return send(res, 200, { hashtags:r.rows });
    }
    if (p.startsWith('/api/admin/hashtags/') && method === 'POST') {
      const b = await body(req);
      await pool.query('UPDATE hashtags SET banned=$2 WHERE id=$1', [parseInt(p.split('/')[4]), !!b.banned]);
      return send(res, 200, { ok:true });
    }
  }

  /* ═══════════════════ TRUST & SAFETY ═══════════════════ */
  if (dbLayer.available) {
    const pool = dbLayer.getPool();
    // كل استعلام بياخد كليان خاص، يعيّن app.user عشان سياسات RLS، وبعدين يرجّعه للمسبح
    const withUser = async (fn) => {
      const client = await pool.connect();
      try {
        const a = auth(req, db);
        await client.query('SELECT set_config($1,$2,false)', ['app.user', String(a ? a.user.id : '')]);
        return await fn(client, a ? numericId(a.user.id) : 0, a);
      } finally { client.release(); }
    };

    // إعدادات الأمان (خطوط المساعدة، الحدود...) — عام
    if (p === '/api/safety/config' && method === 'GET') {
      try {
        const r = await pool.query(`SELECT key,value FROM safety_config`);
        const cfg = {}; r.rows.forEach(x => cfg[x.key] = x.value);
        return send(res, 200, cfg);
      } catch (e) { return send(res, 200, {}); }
    }

    // بوابة العمر
    if (p === '/api/safety/birthdate' && method === 'POST') {
      const b = await body(req);
      const acc = auth(req, db);
      try {
        let realUid = 0;
        if (acc) {
          const ext = String(acc.user.id);
          const u = await pool.query(`INSERT INTO users(external_id,status) VALUES($1,'active')
            ON CONFLICT (external_id) DO UPDATE SET status='active' RETURNING id`, [ext]);
          realUid = u.rows[0].id;
        }
        const tier = await withUser(async (cl, uid) => {
          const who = realUid || uid;
          // تأكد إن البروفايل موجود قبل ما نخزّن تاريخ الميلاد
          await cl.query(`INSERT INTO profiles(id,username,display_name) VALUES($1,$2,$2)
            ON CONFLICT (id) DO NOTHING`, [who, String(acc ? acc.user.id : who)]);
          const r = await cl.query('SELECT set_birthdate($1,$2::date) t', [who, b.birth]);
          return r.rows[0]?.t;
        });
        return send(res, 200, { result: tier });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // حالة الحساب (لشاشة الحظر/التقييد)
    if (p === '/api/safety/status' && method === 'GET') {
      try {
        const r = await withUser((cl, uid) => cl.query(
          `SELECT status,age_tier,is_private,restricted_until,ban_reason FROM profiles WHERE id=$1`, [uid]));
        return send(res, 200, r.rows[0] || { status: 'active' });
      } catch (e) { return send(res, 200, { status: 'active' }); }
    }

    // بلاغ
    if (p === '/api/safety/report' && method === 'POST') {
      const b = await body(req);
      try {
        const id = await withUser((cl, uid) => cl.query(
          'SELECT submit_report($1,$2,$3,$4,$5) id',
          [uid, b.type, String(b.id), b.reason, b.details || '']).then(r => r.rows[0]?.id));
        return send(res, 200, { ok: true, duplicate: id == null, id });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // حظر مستخدم
    if (p === '/api/safety/block' && method === 'POST') {
      const b = await body(req);
      try {
        await withUser((cl, uid) => cl.query(
          `INSERT INTO blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [uid, numericId(String(b.other))]));
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // إشعارات / عقوبات / استئناف
    if (p === '/api/safety/notices' && method === 'GET') {
      try {
        const r = await withUser((cl, uid) => cl.query(
          'SELECT * FROM user_notices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [uid]));
        return send(res, 200, { notices: r.rows });
      } catch (e) { return send(res, 200, { notices: [] }); }
    }
    if (p === '/api/safety/strikes' && method === 'GET') {
      try {
        const r = await withUser((cl, uid) => cl.query(
          'SELECT * FROM strikes WHERE user_id=$1 AND NOT revoked ORDER BY created_at DESC', [uid]));
        return send(res, 200, { strikes: r.rows });
      } catch (e) { return send(res, 200, { strikes: [] }); }
    }
    if (p === '/api/safety/appeal' && method === 'POST') {
      const b = await body(req);
      try {
        await withUser((cl, uid) => cl.query('SELECT submit_appeal($1,$2,$3)',
          [uid, b.strikeId, b.message]));
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // مراجعة آلية: Edge Function لو متاحة، والا فحص محلي مجاني (fail-closed)
    if (p === '/api/safety/moderate' && method === 'POST') {
      const b = await body(req);
      try {
        const result = await withUser(async (cl, uid) => {
          const v = await cl.query('SELECT creator_id,caption,status FROM videos WHERE id=$1', [b.videoId]);
          if (!v.rows[0] || String(v.rows[0].creator_id) !== String(uid))
            throw new Error('forbidden');
          const cfg = await cl.query(`SELECT value FROM safety_config WHERE key='new_creator_review_count'`);
          const need = Number(cfg.rows[0]?.value || 3);
          const txt = await cl.query('SELECT text_check($1) c', [v.rows[0].caption || '']);
          const check = txt.rows[0]?.c;
          if (check === 'block') {
            await cl.query(`UPDATE videos SET status='removed' WHERE id=$1`, [b.videoId]);
            return { status: 'removed', reason: 'blocked_word' };
          }
          // محاولة استدعاء Edge Function لو متهيّأة
          const fnUrl = process.env.MODERATE_FUNCTION_URL;
          if (fnUrl && process.env.SUPABASE_SERVICE_ROLE_KEY) {
            try {
              const fr = await fetch(fnUrl, {
                method:'POST',
                headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY },
                body: JSON.stringify({ videoId:b.videoId, frames:b.frames || [] }),
              });
              if (fr.ok) {
                const data = await fr.json();
                return { status: data.status || 'pending' };
              }
            } catch (_) { /* fail-closed */ }
          }
          const cnt = await cl.query(
            `SELECT count(*)::int n FROM videos WHERE creator_id=$1 AND status='approved'`, [uid]);
          if ((cnt.rows[0]?.n || 0) < need || check === 'review') {
            await cl.query(`UPDATE videos SET status='under_review' WHERE id=$1`, [b.videoId]);
            return { status: 'under_review', reason: check === 'review' ? 'word_review' : 'new_creator' };
          }
          await cl.query(`UPDATE videos SET status='approved' WHERE id=$1`, [b.videoId]);
          return { status: 'approved' };
        });
        if (b.localId && db.videos[b.localId]) {
          db.videos[b.localId].status = result.status;
          store.commit();
        }
        return send(res, 200, result);
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // 👮 أدمن
    if (p === '/api/safety/admin/is-admin' && method === 'GET') {
      try {
        const ok = await withUser((cl, uid) => cl.query('SELECT is_admin($1) a', [uid]).then(r => !!r.rows[0]?.a));
        return send(res, 200, { admin: ok });
      } catch (e) { return send(res, 200, { admin: false }); }
    }
    if (p === '/api/safety/admin/queue' && method === 'GET') {
      try {
        const r = await withUser((cl, uid) => cl.query('SELECT * FROM get_mod_queue($1,50)', [uid]));
        return send(res, 200, { queue: r.rows });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/safety/admin/action' && method === 'POST') {
      const b = await body(req);
      try {
        const out = await withUser((cl, uid) => cl.query('SELECT admin_action($1,$2,$3,$4) o',
          [uid, b.reportId, b.action, b.note || '']).then(r => r.rows[0]?.o));
        return send(res, 200, { ok: true, outcome: out });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/safety/admin/appeal' && method === 'POST') {
      const b = await body(req);
      try {
        await withUser((cl, uid) => cl.query('SELECT admin_resolve_appeal($1,$2,$3)',
          [uid, b.appealId, !!b.accept]));
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/safety/admin/appeals' && method === 'GET') {
      try {
        const r = await withUser((cl, uid) => cl.query(
          `SELECT a.*,s.reason FROM appeals a JOIN strikes s ON s.id=a.strike_id
           WHERE a.status='open' ORDER BY a.created_at LIMIT 50`));
        return send(res, 200, { appeals: r.rows });
      } catch (e) { return send(res, 200, { appeals: [] }); }
    }
    if (p === '/api/safety/admin/audit' && method === 'GET') {
      try {
        const r = await withUser((cl, uid) => cl.query(
          'SELECT * FROM mod_audit ORDER BY created_at DESC LIMIT 50'));
        return send(res, 200, { audit: r.rows });
      } catch (e) { return send(res, 200, { audit: [] }); }
    }
    if (p === '/api/safety/admin/words' && method === 'GET') {
      try {
        const r = await pool.query('SELECT * FROM blocked_words ORDER BY term');
        return send(res, 200, { words: r.rows });
      } catch (e) { return send(res, 200, { words: [] }); }
    }
    if (p === '/api/safety/admin/words' && method === 'POST') {
      const b = await body(req);
      try {
        await pool.query(`INSERT INTO blocked_words(term,action) VALUES($1,$2)
          ON CONFLICT (term) DO UPDATE SET action=EXCLUDED.action`, [b.term, b.action || 'review']);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p.startsWith('/api/safety/admin/words/') && method === 'DELETE') {
      try {
        await pool.query('DELETE FROM blocked_words WHERE term=$1', [decodeURIComponent(p.split('/')[5])]);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // 🙈 مش مهتم → استبعاد من For You
    const uidOfLocal = r => { const a = auth(r, db); return a ? numericId(a.user.id) : 0; };
    if (p.startsWith('/api/videos/') && p.endsWith('/not-interested') && method === 'POST') {
      try {
        const raw = p.split('/')[3];
        const pgId = /^\d+$/.test(raw) ? raw
          : (db.videos[raw]?.pgId ? String(db.videos[raw].pgId) : null);
        if (pgId) await pool.query('SELECT mark_not_interested($1,$2)', [uidOfLocal(req), pgId]);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 200, { ok: true }); }
    }
  }

  /* ═══════════════════ GROWTH (Phase 0) ═══════════════════ */

  // 🎟️ كود الدعوة + الشارات
  if (p === '/api/growth/me' && method === 'GET') {
    const a = auth(req, db); if (!a) return send(res,401,{error:'unauthorized'});
    db.growth = db.growth || {};
    const g = db.growth[a.user.id] || (db.growth[a.user.id]={code:growth.makeCode(a.user.id),invites:0,badges:['founding']});
    return send(res,200,{code:g.code,invites:g.invites,badges:g.badges,shareUrl:'https://vibe.app/i/'+g.code});
  }
  // تفعيل كود دعوة (بشرط تسجيل جديد) — المكافأة شارة بس
  if (p === '/api/growth/redeem' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res,401,{error:'unauthorized'});
    const b = await body(req); const code = String(b.code||'').toUpperCase();
    const owner = Object.entries(db.growth||{}).find(([,g])=>g.code===code);
    if (!owner || owner[0]===a.user.id) return send(res,400,{error:'كود غير صالح'});
    db.growth[owner[0]].invites++;
    const me = db.growth[a.user.id]||(db.growth[a.user.id]={code:growth.makeCode(a.user.id),invites:0,badges:[]});
    if (db.growth[owner[0]].invites>=3 && !db.growth[owner[0]].badges.includes('inviter'))
      db.growth[owner[0]].badges.push('inviter');
    store.commit(); return send(res,200,{ok:true,badge:'🎁 Inviter'});
  }
  // 🏆 لوحة المبدعين الأسبوعية
  if (p === '/api/growth/leaderboard' && method === 'GET') {
    const data = growth.leaderboard(db.users, db.videos);
    const list = Object.values(data).sort((a,b)=>b.views-a.views).slice(0,10)
      .map((x,i)=>({...x,rank:i+1,badge:i===0?'👑':''}));
    return send(res,200,{list});
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

  // صفحة التسجيل / الدخول (تفتح من المتصفح)
  if ((p === '/register' || p === '/register.html') && method === 'GET') {
    const file = path.join(__dirname, 'register.html');
    const html = fs.readFileSync(file, 'utf8');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  // صفحة الأدمن
  if (p === '/admin' && method === 'GET') {
    const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  // 📱 خدمة ملفات التطبيق (نفس الدومين عشان الجلسة تتحفظ)
  if (method === 'GET') {
    const WEB_DIR = path.join(__dirname, '..', 'vibe-web');
    const map = { '/app': 'index.html', '/': 'index.html' };
    const rel = map[p] || (p.startsWith('/') ? p.slice(1) : '');
    if (rel && !rel.includes('..') && !rel.includes('\\')) {
      const fp = path.join(WEB_DIR, rel);
      try {
        if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          const ext = path.extname(fp).toLowerCase();
          const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
            '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
            '.png':'image/png', '.svg':'image/svg+xml', '.mp4':'video/mp4', '.webm':'video/webm' };
          return send(res, 200, fs.readFileSync(fp), types[ext] || 'application/octet-stream');
        }
      } catch (e) {}
    }
  }

  return send(res, 404, { error: 'not found', path: p });
}

function publicVideo(v) {
  return {
    id: v.id, owner: v.owner, caption: v.caption, tags: v.tags,
    size: v.size, mime: v.mime, createdAt: v.createdAt,
    likes: v.likes.length, views: Object.keys(v.views).length,
    pgId: v.pgId, status: v.status || 'approved',
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
