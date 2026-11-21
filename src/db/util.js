'use strict';
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// where: { field: value } (equality) or { field: { in: [..] } }
function matches(doc, where = {}) {
  return Object.entries(where).every(([k, v]) => {
    const val = getPath(doc, k);
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(val);
    return val === v;
  });
}
module.exports = { getPath, matches };
