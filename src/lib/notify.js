'use strict';
const { getDb, C } = require('../db');

/** Create in-app notifications and (if configured) send FCM web-push. Never throws. */
async function notify(userIds, { title, body, link }) {
  const db = getDb();
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  const now = new Date().toISOString();
  await Promise.all(ids.map((userId) => db.create(C.notifications, { userId, title, body, link: link || null, read: false, createdAt: now }).catch(() => {})));
  if (db.kind === 'firestore') {
    try {
      const { getMessaging } = require('firebase-admin/messaging');
      const tokens = (await Promise.all(ids.map((userId) => db.find(C.pushTokens, { userId })))).flat();
      if (tokens.length) {
        const res = await getMessaging().sendEachForMulticast({
          tokens: tokens.map((t) => t.token),
          notification: { title, body },
          webpush: { fcmOptions: { link: link ? `/#${link}` : '/' } },
        });
        res.responses.forEach((r, i) => { if (!r.success) db.delete(C.pushTokens, tokens[i].id).catch(() => {}); });
      }
    } catch (e) { /* push is best-effort */ }
  }
}

async function adminIds() {
  const admins = await getDb().find(C.users, { role: 'admin', status: 'active' });
  return admins.map((a) => a.id);
}

module.exports = { notify, adminIds };
