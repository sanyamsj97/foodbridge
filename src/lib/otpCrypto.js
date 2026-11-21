'use strict';
const crypto = require('crypto');
const config = require('../config');

const generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const hashCode = (code, salt) => crypto.createHmac('sha256', config.otpKey).update(`${salt}:${code}`).digest('hex');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.otpKey, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function decrypt({ iv, tag, ct }) {
  const d = crypto.createDecipheriv('aes-256-gcm', config.otpKey, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
module.exports = { generateCode, hashCode, encrypt, decrypt, safeEqual };
