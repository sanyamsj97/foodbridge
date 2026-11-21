#!/usr/bin/env node
'use strict';
// Create a Super Admin account. Admins can never self-register over HTTP.
// Usage: npm run create-admin -- --name "Jane Admin" --email admin@example.org --phone "+91 9xxxxxxxxx"
// The password is read from ADMIN_PASSWORD or prompted for.
const readline = require('readline');
const { createAdmin } = require('../src/services/auth');

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
  const [k, ...v] = s.trim().split(' ');
  return [k, v.join(' ').replace(/^"|"$/g, '')];
}));

function ask(q, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
  return new Promise((res) => rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); }));
}

(async () => {
  const name = args.name || await ask('Admin name: ');
  const email = args.email || await ask('Admin email: ');
  const phone = args.phone || await ask('Admin phone (+91…): ');
  const password = process.env.ADMIN_PASSWORD || await ask('Password (min 10 chars, letters + numbers): ', true);
  const u = await createAdmin({ name, email, phone, password });
  console.log(`\n✔ Admin created: ${u.email} (id ${u.id}). Sign in at /#/login/admin`);
  process.exit(0);
})().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
