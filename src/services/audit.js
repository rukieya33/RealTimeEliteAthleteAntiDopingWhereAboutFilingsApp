'use strict';

const { query } = require('../config/db');
const realtime = require('./realtime');

/**
 * Records an action in the audit log and pushes it to the live activity feed.
 */
async function record(user, { action, entity, entityId = null, athleteId = null, summary }) {
  const row = {
    user_id: user ? user.id : null,
    user_name: user ? user.name : 'System',
    action, entity, entity_id: entityId, athlete_id: athleteId, summary,
  };
  const res = await query('INSERT INTO audit_log SET ?', [row]);
  realtime.broadcast('activity', { id: res.insertId, ...row, created_at: new Date().toISOString() });
}

module.exports = { record };
