/* route-helpers.mjs — auth / encrypt / realtime (placeholders for production wiring) */
import crypto from 'node:crypto';

const KEY = process.env.ACCOUNT_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY,'hex'), iv);
  const enc = Buffer.concat([cipher.update(String(text),'utf8'),cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv,tag,enc]).toString('base64');
}
export function decrypt(payload) {
  const b = Buffer.from(payload,'base64');
  const iv=b.subarray(0,12), tag=b.subarray(12,28), enc=b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(KEY,'hex'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc),d.final()]).toString('utf8');
}

/* auth middleware: يقرأ token من Authorization ويحوّله لـ userId رقمي */
export function auth(req,res,next) {
  const h = req.headers.authorization||'';
  const token = h.startsWith('Bearer ')?h.slice(7):'';
  if(!token) return res.status(401).json({error:'UNAUTHORIZED'});
  req.user = { id: numericId(token) };
  next();
}
function numericId(str){let x=0;for(const c of String(str))x=((x*31)+c.charCodeAt(0))>>>0;return(x%900000000000)+1000000000}

/* بث لحظي — يُستبدل بـ WebSocket/SSE في الإنتاج */
export const realtime = {
  emitGift(tx){ console.log('[realtime] gift', tx?.id); },
};
