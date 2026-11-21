'use strict';
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { getDb, C } = require('../db');
const { bad, notFound, forbidden, conflict } = require('../lib/errors');
const { compute } = require('./analytics');
const settings = require('./settings');

const GREEN = '#1b7f3b';
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '-');

/** Period ranges are computed in IST (UTC+5:30) since the platform operates in India. */
function periodRange(period, dateStr) {
  const IST = 330 * 60000;
  const base = dateStr ? new Date(`${dateStr}T00:00:00+05:30`) : new Date();
  if (Number.isNaN(base.getTime())) throw bad('Invalid date');
  const local = new Date(base.getTime() + IST);
  let y = local.getUTCFullYear(); let m = local.getUTCMonth(); let d = local.getUTCDate();
  let start; let end; let label;
  const mk = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd) - IST);
  if (period === 'daily') { start = mk(y, m, d); end = mk(y, m, d + 1); label = `Daily report – ${start.toISOString().slice(0, 10)}`; }
  else if (period === 'weekly') { const dow = (local.getUTCDay() + 6) % 7; start = mk(y, m, d - dow); end = mk(y, m, d - dow + 7); label = `Weekly report – week of ${new Date(start.getTime() + IST).toISOString().slice(0, 10)}`; }
  else if (period === 'monthly') { start = mk(y, m, 1); end = mk(y, m + 1, 1); label = `Monthly report – ${y}-${String(m + 1).padStart(2, '0')}`; }
  else if (period === 'yearly') { start = mk(y, 0, 1); end = mk(y + 1, 0, 1); label = `Yearly report – ${y}`; }
  else throw bad('period must be daily, weekly, monthly or yearly');
  return { start: start.toISOString(), end: end.toISOString(), label };
}

async function adminReport(period, date) {
  const range = periodRange(period, date);
  const s = await settings.get();
  const all = await getDb().find(C.donations, {});
  const list = all.filter((d) => d.createdAt >= range.start && d.createdAt < range.end).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    ...range, period, metrics: compute(list, s), generatedAt: new Date().toISOString(),
    rows: list.map((d) => ({
      id: d.id, createdAt: d.createdAt, donor: d.donorOrg, food: d.foodName, category: d.category, vegType: d.vegType,
      quantityKg: d.quantityKg, receivedKg: d.receivedKg ?? '', distributedKg: d.distributedKg ?? '', peopleServed: d.peopleServed ?? '',
      ngo: d.ngoName || '', volunteer: d.volunteerName || '', area: `${d.pickup?.area || ''}, ${d.pickup?.city || ''}`, status: d.status,
    })),
  };
}

function pdfHeader(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 70).fill(GREEN);
  doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('FoodBridge', 40, 20);
  doc.fontSize(10).font('Helvetica').text('Food Rescue & Donation Management', 40, 46);
  doc.fillColor('#111111').moveDown(3);
  doc.fontSize(16).font('Helvetica-Bold').text(title, 40, 90);
  if (subtitle) doc.fontSize(10).font('Helvetica').fillColor('#555555').text(subtitle);
  doc.fillColor('#111111').moveDown();
}

function kv(doc, pairs) {
  for (const [k, v] of pairs) {
    doc.font('Helvetica-Bold').fontSize(10).text(`${k}: `, { continued: true }).font('Helvetica').text(String(v ?? '-'));
  }
}

function reportPdf(res, r) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="foodbridge-${r.period}-report.pdf"`);
  doc.pipe(res);
  pdfHeader(doc, r.label, `${fmtDate(r.start)} to ${fmtDate(r.end)} · generated ${fmtDate(r.generatedAt)}`);
  const m = r.metrics;
  kv(doc, [
    ['Total donations', m.totalDonations], ['Successful (completed)', m.successfulDonations], ['Rejected (incl. unsafe)', m.rejectedDonations],
    ['Expired', m.expiredDonations], ['Food donated (kg)', m.totalDonatedKg], ['Food delivered (kg)', m.totalDeliveredKg],
    ['Food waste prevented (kg distributed)', m.foodWastePreventedKg],
    [`Estimated meals (assumes ${m.servingSizeKg} kg/meal – an estimate, not verified beneficiaries)`, m.estimatedMeals],
    ['People served (reported by NGOs)', m.peopleServedReported],
  ]);
  doc.moveDown().font('Helvetica-Bold').fontSize(12).text('Area-wise statistics');
  doc.font('Helvetica').fontSize(9);
  m.areas.forEach((a) => doc.text(`${a.area}: ${a.donations} donations · ${a.donatedKg} kg donated · ${a.deliveredKg} kg delivered · ${a.completed} completed`));
  doc.moveDown().font('Helvetica-Bold').fontSize(12).text('Donations');
  doc.font('Helvetica').fontSize(8);
  r.rows.forEach((x) => doc.text(`${fmtDate(x.createdAt)} | ${x.donor} | ${x.food} | ${x.quantityKg} kg | rcvd ${x.receivedKg || '-'} | ${x.ngo || '-'} | ${x.volunteer || '-'} | ${x.status}`));
  if (!r.rows.length) doc.text('No donations in this period.');
  doc.end();
}

async function reportXlsx(res, r) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FoodBridge';
  const s = wb.addWorksheet('Summary');
  s.columns = [{ header: 'Metric', key: 'k', width: 55 }, { header: 'Value', key: 'v', width: 20 }];
  const m = r.metrics;
  [['Report', r.label], ['From', r.start], ['To', r.end], ['Total donations', m.totalDonations], ['Successful donations', m.successfulDonations],
    ['Rejected donations', m.rejectedDonations], ['Expired donations', m.expiredDonations], ['Food donated (kg)', m.totalDonatedKg],
    ['Food delivered (kg)', m.totalDeliveredKg], ['Food waste prevented (kg)', m.foodWastePreventedKg],
    [`Estimated meals (assumption: ${m.servingSizeKg} kg/meal)`, m.estimatedMeals], ['People served (reported)', m.peopleServedReported],
  ].forEach(([k, v]) => s.addRow({ k, v }));
  s.getRow(1).font = { bold: true };
  const a = wb.addWorksheet('Areas');
  a.columns = [{ header: 'Area', key: 'area', width: 35 }, { header: 'Donations', key: 'donations' }, { header: 'Donated kg', key: 'donatedKg' }, { header: 'Delivered kg', key: 'deliveredKg' }, { header: 'Completed', key: 'completed' }];
  m.areas.forEach((x) => a.addRow(x));
  a.getRow(1).font = { bold: true };
  const d = wb.addWorksheet('Donations');
  d.columns = ['id', 'createdAt', 'donor', 'food', 'category', 'vegType', 'quantityKg', 'receivedKg', 'distributedKg', 'peopleServed', 'ngo', 'volunteer', 'area', 'status'].map((k) => ({ header: k, key: k, width: 18 }));
  r.rows.forEach((x) => d.addRow(x));
  d.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="foodbridge-${r.period}-report.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

async function auditXlsx(res) {
  const logs = await getDb().recent(C.auditLogs, 'at', 5000);
  const wb = new ExcelJS.Workbook();
  const w = wb.addWorksheet('Audit log');
  w.columns = ['at', 'actorName', 'actorRole', 'action', 'entityType', 'entityId', 'ip', 'details'].map((k) => ({ header: k, key: k, width: 22 }));
  logs.forEach((l) => w.addRow({ ...l, details: JSON.stringify(l.details) }));
  w.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="foodbridge-audit-log.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}

async function donorCertificate(res, user, donationId) {
  const d = await getDb().get(C.donations, donationId);
  if (!d) throw notFound('Donation');
  if (user.role !== 'admin' && d.donorId !== user.id) throw forbidden();
  if (d.status !== 'completed' || !d.completion) throw conflict('Certificates are available only for completed (fully verified) donations');
  const c = d.completion;
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="foodbridge-certificate-${d.id}.pdf"`);
  doc.pipe(res);
  const W = doc.page.width; const H = doc.page.height;
  doc.lineWidth(6).strokeColor(GREEN).rect(20, 20, W - 40, H - 40).stroke();
  doc.lineWidth(1).rect(32, 32, W - 64, H - 64).stroke();
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(34).text('Certificate of Food Donation', 0, 80, { align: 'center' });
  doc.fillColor('#333').font('Helvetica').fontSize(14).text('This certificate is gratefully presented to', 0, 150, { align: 'center' });
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(26).text(c.donor.org || c.donor.name, 0, 180, { align: 'center' });
  doc.fillColor('#333').font('Helvetica').fontSize(13).text(
    `for donating ${c.quantityKgReceived} kg of ${c.food.name} (${c.food.vegType === 'veg' ? 'vegetarian' : 'non-vegetarian'}), safely collected by a verified FoodBridge volunteer and received by ${c.ngo.name}, who distributed it to ${c.peopleServed} people.`,
    100, 235, { align: 'center', width: W - 200 });
  doc.fontSize(11).fillColor('#555').text(`Estimated meals: ${c.estimatedMeals} (based on ${c.servingSizeKgAssumed} kg per meal – an estimate)`, 0, 320, { align: 'center' });
  doc.text(`Completed on ${fmtDate(c.completedAt)} · Pickup OTP verified ${fmtDate(c.pickupOtpVerifiedAt)} · Delivery OTP verified ${fmtDate(c.deliveryOtpVerifiedAt)}`, 0, 340, { align: 'center' });
  doc.fontSize(9).text(`Certificate ID: FB-${d.id}`, 0, H - 90, { align: 'center' });
  doc.end();
}

async function ngoImpact(user, month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw bad('month must be YYYY-MM');
  const { start, end } = periodRange('monthly', `${month}-01`);
  const db = getDb();
  const s = await settings.get();
  const [mine, dists] = await Promise.all([db.find(C.donations, { ngoId: user.id }), db.find(C.distributions, { ngoId: user.id })]);
  const inMonth = mine.filter((d) => d.receivedAt && d.receivedAt >= start && d.receivedAt < end);
  const distsInMonth = dists.filter((x) => x.distributedAt >= start && x.distributedAt < end);
  const receivedKg = inMonth.reduce((a, d) => a + (d.receivedKg || 0), 0);
  return {
    month, start, end,
    donationsReceived: inMonth.length,
    receivedKg: Math.round(receivedKg * 10) / 10,
    distributedKg: Math.round(distsInMonth.reduce((a, x) => a + (x.distributedKg || 0), 0) * 10) / 10,
    peopleServed: distsInMonth.reduce((a, x) => a + (x.peopleServed || 0), 0),
    estimatedMeals: Math.floor(receivedKg / s.servingSizeKg), servingSizeKg: s.servingSizeKg,
    unsafeRejected: mine.filter((d) => d.status === 'unsafe_rejected' && d.closedAt >= start && d.closedAt < end).length,
    rows: inMonth.map((d) => ({ id: d.id, food: d.foodName, donor: d.donorOrg, receivedAt: d.receivedAt, receivedKg: d.receivedKg, peopleServed: d.peopleServed ?? '', status: d.status })),
  };
}

async function ngoImpactPdf(res, user, month) {
  const r = await ngoImpact(user, month);
  const ngo = await getDb().get(C.ngos, user.id);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="foodbridge-impact-${month}.pdf"`);
  doc.pipe(res);
  pdfHeader(doc, `Monthly Impact Report – ${month}`, ngo?.registeredName);
  kv(doc, [['Donations received', r.donationsReceived], ['Food received (kg)', r.receivedKg], ['Food distributed (kg)', r.distributedKg],
    ['People served (recorded by NGO)', r.peopleServed], [`Estimated meals (${r.servingSizeKg} kg/meal assumption)`, r.estimatedMeals], ['Donations rejected as unsafe', r.unsafeRejected]]);
  doc.moveDown().font('Helvetica-Bold').fontSize(12).text('Donations');
  doc.font('Helvetica').fontSize(9);
  r.rows.forEach((x) => doc.text(`${fmtDate(x.receivedAt)} | ${x.food} | from ${x.donor} | ${x.receivedKg} kg | served ${x.peopleServed || '-'} | ${x.status}`));
  if (!r.rows.length) doc.text('No donations received this month.');
  doc.end();
}

module.exports = { periodRange, adminReport, reportPdf, reportXlsx, auditXlsx, donorCertificate, ngoImpact, ngoImpactPdf };
