'use strict';
const { C } = require('../db');

/** Write an audit record. Pass a transaction handle (t) or the db. */
function audit(t, actor, action, entityType, entityId, details = {}) {
  return t.create(C.auditLogs, {
    at: new Date().toISOString(),
    actorId: actor?.id || 'system',
    actorRole: actor?.role || 'system',
    actorName: actor?.name || 'System',
    action,
    entityType,
    entityId: entityId || null,
    details,
    ip: actor?.ip || null,
  });
}
module.exports = { audit };
