/* ============================================================================
   VIBE Backend — Node خالص (بدون مكتبات خارجية)
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const store = require('./lib/store');
const wallet = require('./lib/wallet');
const sec = require('./lib/security');
store.load();

const limiter = sec.rateLimit(150, 60 * 1000);

const PORT = process.env.PORT || 3000;
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

  // liste الفيديوهات
  if (p === '/api/videos' && method === 'GET') {
    const list = Object.values(db.videos)
      .sort((x, y) => y.createdAt - x.createdAt)
      .map(v => publicVideo(v));
    return send(res, 200, { videos: list });
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

  // إعلان (محاكاة دخل) — عشان نحسب if الربح يغطي المصروف
  if (p === '/api/ads/impression' && method === 'POST') {
    const a = auth(req, db); if (!a) return send(res, 401, { error: 'unauthorized' });
    db.stats.adImpressions++;
    store.commit();
    return send(res, 200, { ok: true, revenue: db.config.adRevenuePerView });
  }

  // إحصائيات الأدمن
  if (p === '/api/admin/stats' && method === 'GET') {
    return send(res, 200, {
      stats: db.stats,
      config: db.config,
      users: Object.keys(db.users).length,
      videos: Object.keys(db.videos).length,
      revenueEstimate: Math.round(db.stats.adImpressions * db.config.adRevenuePerView * 100) / 100,
      spent: db.stats.totalSpent,
      profit: Math.round((db.stats.adImpressions * db.config.adRevenuePerView - db.stats.totalSpent) * 100) / 100,
    });
  }

  // تعديل الإعدادات (للاستخدام المحلي/التجريبي)
  if (p === '/api/admin/config' && method === 'POST') {
    const b = await body(req);
    for (const k of Object.keys(db.config)) {
      if (b[k] !== undefined) db.config[k] = b[k];
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
