import { get, download } from '../api.js';
import { $, html, busy, statTile, fmtNum, fmtDate, empty, badge } from '../ui.js';
import { donationCard } from './donor.js';

export async function board({ el, user, banner, onCleanup }) {
  const b = await get('/api/ngo/board');
  el.innerHTML = String(html`${{ __raw: true, value: banner }}
    <div class="page-head"><div><h1>Food donations</h1><p class="muted">Only verified NGOs can receive food. Always check food condition on arrival.</p></div></div>
    <div class="stats">
      ${statTile(fmtNum(b.offers.length), 'Offers for you')}
      ${statTile(fmtNum(b.active.length), 'In progress')}
      ${statTile(fmtNum(b.history.filter((d) => d.status === 'completed').length), 'Completed')}
      ${statTile(fmtNum(b.history.reduce((a, d) => a + (d.peopleServed || 0), 0)), 'People served (recorded)')}
    </div>
    <h2 class="section-title">Offered to you <small class="muted">(matched by location & capacity)</small></h2>
    <div class="grid grid-2">${b.offers.length ? b.offers.map((d) => donationCard(d, html`<span class="badge badge-info">★ Offer – open to accept</span>`)) : empty('No offers right now.')}</div>
    <h2 class="section-title">In progress</h2>
    <div class="grid grid-2">${b.active.length ? b.active.map((d) => donationCard(d)) : empty('Nothing in progress.')}</div>
    <h2 class="section-title">Other available donations</h2>
    <div class="grid grid-2">${b.open.length ? b.open.map((d) => donationCard(d, d.request ? html`<span class="small">Your request: ${badge(d.request.status)}</span>` : '')) : empty('No other open donations.')}</div>
    <h2 class="section-title">History</h2>
    <div class="grid grid-2">${b.history.length ? b.history.map((d) => donationCard(d)) : empty('No history yet.')}</div>`);
  const t = setInterval(() => { if (!document.hidden && location.hash === '#/ngo') { clearInterval(t); board({ el, user, banner, onCleanup }).catch(() => {}); } }, 60000);
  onCleanup(() => clearInterval(t));
}

export async function impact({ el }) {
  const month = new Date().toISOString().slice(0, 7);
  el.innerHTML = String(html`
    <div class="page-head"><div><h1>Monthly impact report</h1><p class="muted">Received and distributed food for a month. Meals are an estimate; people served is what you recorded.</p></div></div>
    <form id="imp-form" class="card row"><label class="field"><span>Month</span><input type="month" name="month" value="${month}" required></label>
      <button class="btn btn-primary" type="submit">Show</button><button class="btn btn-secondary" type="button" id="pdf-btn">⬇ Download PDF</button></form>
    <div id="imp-out"></div>`);
  const show = async () => {
    const m = $('#imp-form').elements.month.value;
    const r = await get(`/api/ngo/impact?month=${encodeURIComponent(m)}`);
    $('#imp-out').innerHTML = String(html`
      <div class="stats">${statTile(fmtNum(r.donationsReceived), 'Donations received')}${statTile(`${fmtNum(r.receivedKg)} kg`, 'Food received')}${statTile(`${fmtNum(r.distributedKg)} kg`, 'Food distributed')}${statTile(fmtNum(r.peopleServed), 'People served (recorded)')}${statTile(fmtNum(r.estimatedMeals), 'Meals (estimated)', `${r.servingSizeKg} kg per meal`)}${statTile(fmtNum(r.unsafeRejected), 'Rejected as unsafe')}</div>
      <div class="card"><table class="table"><thead><tr><th>Received</th><th>Food</th><th>Donor</th><th class="num">kg</th><th class="num">People</th><th>Status</th></tr></thead><tbody>
      ${r.rows.length ? r.rows.map((x) => html`<tr><td>${fmtDate(x.receivedAt)}</td><td><a href="#/donation/${x.id}">${x.food}</a></td><td>${x.donor}</td><td class="num">${x.receivedKg}</td><td class="num">${x.peopleServed}</td><td>${badge(x.status)}</td></tr>`) : html`<tr><td colspan="6">${empty('No donations received in this month.')}</td></tr>`}
      </tbody></table></div>`);
  };
  $('#imp-form').addEventListener('submit', async (e) => { e.preventDefault(); await busy(e.submitter, show); });
  $('#pdf-btn').addEventListener('click', (e) => busy(e.target, () => { const m = $('#imp-form').elements.month.value; return download(`/api/ngo/impact.pdf?month=${encodeURIComponent(m)}`, `foodbridge-impact-${m}.pdf`); }));
  await show();
}
