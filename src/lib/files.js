'use strict';
const config = require('../config');
const { C } = require('../db');
const { bad } = require('./errors');

const SIGNATURES = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
};
const IMAGES = ['image/jpeg', 'image/png', 'image/webp'];
const DOCS = [...IMAGES, 'application/pdf'];

function decode(dataUrl, allowed = IMAGES) {
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl || '');
  if (!m) throw bad('File must be a base64 data URL');
  const mime = m[1].toLowerCase();
  if (!allowed.includes(mime)) throw bad(`File type ${mime} not allowed (allowed: ${allowed.join(', ')})`);
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw bad('Empty file');
  if (buf.length > config.maxFileBytes) throw bad(`File too large (max ${Math.round(config.maxFileBytes / 1024)} KB after compression)`);
  const ok = SIGNATURES[mime].some((sig) => sig.every((b, i) => buf[i] === b));
  if (!ok) throw bad('File content does not match its declared type');
  return { mime, buf };
}

/**
 * Store a file in Firestore (`files` collection). Cloud Storage requires the paid Blaze
 * plan for new projects, so files are compressed client-side and kept as base64 here.
 * sensitivity: 'identity' (owner + admin only) | 'proof' (donation participants + admin)
 */
function save(t, { ownerId, purpose, sensitivity, donationId, dataUrl, allowed }) {
  const { mime, buf } = decode(dataUrl, allowed);
  return t.create(C.files, {
    ownerId, purpose, sensitivity, donationId: donationId || null, mime, size: buf.length,
    data: buf.toString('base64'), createdAt: new Date().toISOString(),
  }).id;
}

module.exports = { decode, save, IMAGES, DOCS };
