const crypto = require('node:crypto');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sign(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function seal(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(part => part.toString('base64url')).join('.');
}
function open(value, key) {
  const [iv, tag, bytes] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8'));
}
function validateSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) return false;
  let url;
  try { url = new URL(value.endpoint); } catch { return false; }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'jmt17.google.com' || host === 'web.push.apple.com' ||
    host.endsWith('.push.apple.com') || host === 'updates.push.services.mozilla.com' ||
    host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const keys = value.keys;
  if (!keys || !/^[A-Za-z0-9_-]+$/.test(keys.p256dh || '') || !/^[A-Za-z0-9_-]+$/.test(keys.auth || '')) return false;
  const publicKey = Buffer.from(keys.p256dh, 'base64url');
  return publicKey.length === 65 && publicKey[0] === 4 && Buffer.from(keys.auth, 'base64url').length === 16;
}
module.exports = { digest, sign, equal, seal, open, validateSubscription };
