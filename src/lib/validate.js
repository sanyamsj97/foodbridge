'use strict';
const { z } = require('zod');
const { bad } = require('./errors');

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw bad(`Invalid input: ${issues.map((i) => `${i.field || 'body'} – ${i.message}`).join('; ')}`, issues);
  }
  return r.data;
}

const str = (min = 1, max = 200) => z.string().trim().min(min).max(max);
const optStr = (max = 500) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{8,18}$/, 'Enter a valid phone number');
const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(10, 'At least 10 characters').max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter').regex(/[0-9]/, 'Must contain a number');
const gps = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100000).optional(),
});
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date/time').transform((s) => new Date(s).toISOString());
const dataUrl = z.string().max(1_100_000).regex(/^data:[a-z/+.-]+;base64,/i, 'Must be a base64 data URL');
const photos = (min, max) => z.array(dataUrl).min(min, `At least ${min} photo(s) required`).max(max);

module.exports = { z, parse, str, optStr, phone, email, password, gps, isoDate, dataUrl, photos };
