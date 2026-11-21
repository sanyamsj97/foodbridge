'use strict';
// Food-safety rule engine. Conservative defaults based on common food-safety guidance
// (2-hour/4-hour rule for perishable food in the 5–60°C "danger zone", hot holding ≥60°C,
// chilled ≤5°C, frozen ≤-18°C). Limits are intentionally strict; when in doubt, reject.

const H = 3600 * 1000;

const STORAGE = {
  hot_holding: { label: 'Hot holding (kept at 60°C or above)', flagHours: 4, maxHours: 6 },
  room_temp: { label: 'Room temperature', flagHours: 2, maxHours: 4 },
  refrigerated: { label: 'Refrigerated (5°C or below)', flagHours: 24, maxHours: 48 },
  frozen: { label: 'Frozen (-18°C or below)', flagHours: 24 * 14, maxHours: 24 * 60 },
};

// Categories with their own shelf-life behaviour at room temperature.
const CATEGORY = {
  cooked_meal: { label: 'Cooked meal', perishable: true },
  dairy: { label: 'Dairy', perishable: true },
  bakery: { label: 'Bakery', perishable: false, roomFlagHours: 12, roomMaxHours: 24 },
  raw_produce: { label: 'Fruits & vegetables', perishable: false, roomFlagHours: 24, roomMaxHours: 48 },
  packaged: { label: 'Sealed packaged food', needsExpiry: true },
  beverages: { label: 'Beverages', needsExpiry: true },
  other: { label: 'Other', perishable: true },
};

const fmt = (ms) => new Date(ms).toISOString();

/**
 * Evaluate food safety at a given stage.
 * @param {object} f food: category, storage, tempC (declared), preparedAt, expiryDate, pickupDeadline
 * @param {object} o { now (ms), stage: 'submission'|'admin_review'|'pickup'|'receipt', measuredTempC }
 * @returns {{result:'pass'|'flag'|'fail', flags:string[], failures:string[], safeUntil:string}}
 */
function evaluate(f, { now = Date.now(), stage = 'submission', measuredTempC } = {}) {
  const flags = [];
  const failures = [];
  const cat = CATEGORY[f.category] || CATEGORY.other;
  let storage = STORAGE[f.storage] ? f.storage : 'room_temp';
  const prepared = Date.parse(f.preparedAt);
  const temp = measuredTempC ?? f.tempC;

  if (Number.isNaN(prepared)) failures.push('Preparation time is missing or invalid');
  else if (prepared > now + 10 * 60 * 1000) failures.push('Preparation time cannot be in the future');

  // Temperature compliance – a storage claim that the thermometer contradicts is downgraded.
  if (temp != null && !Number.isNaN(Number(temp))) {
    const t = Number(temp);
    if (storage === 'hot_holding' && t < 60) {
      flags.push(`Hot food measured at ${t}°C (below 60°C) – room-temperature time limits applied`);
      storage = 'room_temp';
    } else if (storage === 'refrigerated' && t > 5) {
      if (t > 8) { flags.push(`Chilled food measured at ${t}°C (above 8°C) – room-temperature time limits applied`); storage = 'room_temp'; }
      else flags.push(`Chilled food at ${t}°C is above the 5°C target`);
    } else if (storage === 'frozen' && t > -18) {
      if (t > -10) { flags.push(`Frozen food measured at ${t}°C – treated as refrigerated`); storage = 'refrigerated'; }
      else flags.push(`Frozen food at ${t}°C is above the -18°C target`);
    }
    if (t > 75) flags.push(`Very high temperature recorded (${t}°C) – check the reading`);
  } else if (['hot_holding', 'refrigerated', 'frozen'].includes(storage) && stage !== 'submission') {
    flags.push('No temperature reading recorded');
  }

  // Time limits.
  let rule = STORAGE[storage];
  if (storage === 'room_temp' && cat.roomMaxHours) {
    rule = { ...rule, flagHours: cat.roomFlagHours, maxHours: cat.roomMaxHours };
  }
  let safeUntil = Number.isNaN(prepared) ? now : prepared + rule.maxHours * H;

  if (cat.needsExpiry) {
    const exp = Date.parse(f.expiryDate);
    if (Number.isNaN(exp)) failures.push('Expiry / best-before date is required for packaged food and beverages');
    else {
      safeUntil = exp;
      if (exp <= now) failures.push('Product is past its expiry / best-before date');
      else if (exp - now < 12 * H) flags.push('Product expires within 12 hours');
    }
  } else if (!Number.isNaN(prepared)) {
    const ageH = (now - prepared) / H;
    if (now > safeUntil) failures.push(`Food is ${ageH.toFixed(1)}h old – exceeds the ${rule.maxHours}h safe limit for ${STORAGE[storage].label.toLowerCase()}`);
    else if (ageH > rule.flagHours) flags.push(`Food is ${ageH.toFixed(1)}h old – approaching the ${rule.maxHours}h safe limit`);
  }

  if (stage === 'submission' || stage === 'admin_review') {
    const deadline = Date.parse(f.pickupDeadline);
    if (Number.isNaN(deadline)) failures.push('Pickup deadline is missing or invalid');
    else {
      if (deadline <= now) failures.push('Pickup deadline has already passed');
      if (deadline > safeUntil) failures.push(`Pickup deadline is after the food's safe-until time (${fmt(safeUntil)})`);
      if (deadline - now < 30 * 60 * 1000 && deadline > now) flags.push('Less than 30 minutes until the pickup deadline');
    }
  }

  const result = failures.length ? 'fail' : flags.length ? 'flag' : 'pass';
  return { result, flags, failures, safeUntil: fmt(safeUntil) };
}

module.exports = { evaluate, STORAGE, CATEGORY };
