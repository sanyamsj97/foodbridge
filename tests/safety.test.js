'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/lib/safety');

const H = 3600000;
const now = Date.parse('2026-11-21T12:00:00Z');
const at = (h) => new Date(now + h * H).toISOString();

test('fresh hot-held cooked food passes', () => {
  const r = evaluate({ category: 'cooked_meal', storage: 'hot_holding', tempC: 70, preparedAt: at(-1), pickupDeadline: at(2) }, { now });
  assert.equal(r.result, 'pass');
});

test('room-temperature cooked food older than 4h fails', () => {
  const r = evaluate({ category: 'cooked_meal', storage: 'room_temp', preparedAt: at(-4.5), pickupDeadline: at(1) }, { now });
  assert.equal(r.result, 'fail');
});

test('hot food measured below 60°C is downgraded to room-temperature limits', () => {
  const r = evaluate({ category: 'cooked_meal', storage: 'hot_holding', preparedAt: at(-3), pickupDeadline: at(0.5) }, { now, stage: 'pickup', measuredTempC: 45 });
  assert.equal(r.result, 'flag');
  assert.ok(r.flags.some((f) => f.includes('below 60')));
  const r2 = evaluate({ category: 'cooked_meal', storage: 'hot_holding', preparedAt: at(-5) }, { now, stage: 'pickup', measuredTempC: 45 });
  assert.equal(r2.result, 'fail');
});

test('pickup deadline beyond safe window is rejected', () => {
  const r = evaluate({ category: 'cooked_meal', storage: 'room_temp', preparedAt: at(-1), pickupDeadline: at(5) }, { now });
  assert.equal(r.result, 'fail');
});

test('packaged food requires a future expiry date', () => {
  assert.equal(evaluate({ category: 'packaged', storage: 'room_temp', preparedAt: at(-24), pickupDeadline: at(2) }, { now }).result, 'fail');
  assert.equal(evaluate({ category: 'packaged', storage: 'room_temp', preparedAt: at(-24), expiryDate: at(-1), pickupDeadline: at(2) }, { now }).result, 'fail');
  assert.equal(evaluate({ category: 'packaged', storage: 'room_temp', preparedAt: at(-24), expiryDate: at(72), pickupDeadline: at(2) }, { now }).result, 'pass');
});

test('preparation time in the future is rejected', () => {
  assert.equal(evaluate({ category: 'cooked_meal', storage: 'hot_holding', tempC: 70, preparedAt: at(1), pickupDeadline: at(2) }, { now }).result, 'fail');
});

test('warm refrigerated food is flagged/downgraded', () => {
  const r = evaluate({ category: 'dairy', storage: 'refrigerated', preparedAt: at(-3) }, { now, stage: 'pickup', measuredTempC: 12 });
  assert.equal(r.result, 'flag', 'downgraded to room-temperature limits');
  const r2 = evaluate({ category: 'dairy', storage: 'refrigerated', preparedAt: at(-5) }, { now, stage: 'pickup', measuredTempC: 12 });
  assert.equal(r2.result, 'fail', 'beyond 4h once downgraded');
  assert.equal(evaluate({ category: 'dairy', storage: 'refrigerated', preparedAt: at(-5) }, { now, stage: 'pickup', measuredTempC: 4 }).result, 'pass');
});
