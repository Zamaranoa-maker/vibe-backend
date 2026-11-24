/* ============================================================================
   طبقة الأمان —rate limit + تحقق مدخلات + منع XSS + هيدرات حماية
   ========================================================================== */
'use strict';

/* تقييد عدد الطلبات لكل IP (منع هجمات/غش) */
const hits = new Map();
function rateLimit(max = 120, windowMs = 60 * 1000) {
  return (req, res, next) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || now - rec.start > windowMs) rec = { start: now, count: 0 };
    rec.count++;
    hits.set(ip, rec);
    if (rec.count > max) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil(windowMs / 1000) });
      res.end(JSON.stringify({ error: 'طلبات كتير جداً — حاول بعد شوية' }));
      return false;
    }
    next();
    return true;
  };
}

/* منع XSS: تنظيف أي نص قبل ما يتحط في HTML */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* تحقق من نوع الملف برمجياً (مش بالاسم بس) */
function isRealVideo(buf) {
  if (!buf || buf.length < 12) return false;
  // ftyp = MP4, 1A45DFA3 = WebM/MKV
  const mp4 = buf.toString('ascii', 4, 8) === 'ftyp';
  const webm = buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
  return mp4 || webm;
}

/* هيدرات حماية */
function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.removeHeader('X-Powered-By');
}

/* CORS مقيّد (المتصفح المحلي + file) */
function cors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = /^(http:\/\/localhost(:\d+)?|file:\/\/|null)$/.test(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

module.exports = { rateLimit, esc, isRealVideo, secureHeaders, cors };
