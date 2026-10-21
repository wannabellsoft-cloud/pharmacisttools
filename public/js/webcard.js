import { $, html, mount, createApi, dialog, downloadBlob, icon, toast, registerServiceWorker } from './core.js';
import { renderFront, renderBack, renderSummary } from './cardRender.js';
import { createI18n } from './patientI18n.js';
import { detectPlatform } from './platform.js';

const i18n = createI18n();
const t = (k, v) => i18n.t(k, v);
const app = document.getElementById('app');
const platform = detectPlatform();
const CACHE_KEY = 'pt.holder.cache';

const holder = {
  get token() {
    try { return localStorage.getItem('pt.holder') || sessionStorage.getItem('pt.holder'); } catch { return null; }
  },
  get persistent() {
    try { return Boolean(localStorage.getItem('pt.holder')); } catch { return false; }
  },
  clear() {
    try {
      localStorage.removeItem('pt.holder');
      sessionStorage.removeItem('pt.holder');
      localStorage.removeItem(CACHE_KEY);
    } catch { /* ignore */ }
  },
};

const api = createApi({ authHeader: () => (holder.token ? `Holder ${holder.token}` : null) });

function shell(content) {
  mount(app, html`
    <div class="patient-top">
      <span class="brand"><img src="/icons/icon-192.png" alt=""><span>${t('appName')}</span></span>
      <div class="lang-toggle" role="group" aria-label="Language">
        <button type="button" data-lang="th" aria-pressed="${i18n.lang === 'th'}">ไทย</button>
        <button type="button" data-lang="en" aria-pressed="${i18n.lang === 'en'}">EN</button>
      </div>
    </div>
    ${content}`);
  app.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => { i18n.lang = b.dataset.lang; load(); }));
}

function emptyState(title, body, tone = '') {
  shell(html`<div class="verify-card ${tone}"><div class="verify-icon">${tone ? '!' : 'i'}</div><h1>${title}</h1><p class="muted">${body}</p></div>`);
}

async function load() {
  if (!holder.token) return emptyState(t('noCard'), t('noCardBody'));
  let data;
  let offline = false;
  try {
    data = await api.get('/api/holder/card');
  } catch (err) {
    if (err.status === 401) {
      holder.clear();
      return emptyState(t('revoked'), t('revokedBody'), 'verify-bad');
    }
    // Network failure: fall back to the copy saved on this device (if the patient chose to keep it).
    try { data = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { data = null; }
    if (!data) return emptyState(t('noCard'), err.message);
    offline = true;
  }
  if (data.status !== 'active') {
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    return renderRevoked();
  }
  if (holder.persistent && !offline) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, wallet: undefined })); } catch { /* ignore */ }
  }
  renderCard(data, offline);
}

function renderRevoked() {
  shell(html`<div class="verify-card verify-bad"><div class="verify-icon">!</div><h1>${t('revoked')}</h1><p class="muted">${t('revokedBody')}</p>
    <button class="btn btn-secondary" id="forget">${t('forget')}</button></div>`);
  $('#forget').addEventListener('click', () => { holder.clear(); load(); });
}

function walletButtons(wallet, showAll) {
  const apple = html`<button class="btn btn-wallet btn-block" data-wallet="apple" ${wallet?.apple ? '' : 'disabled'}>${icon('wallet')} ${t('appleWallet')}</button>`;
  const google = html`<button class="btn btn-wallet btn-block" data-wallet="google" ${wallet?.google ? '' : 'disabled'}>${icon('wallet')} ${t('googleWallet')}</button>`;
  const list = [];
  if (platform === 'ios' || showAll) list.push(apple);
  if (platform === 'android' || showAll) list.push(google);
  const unavailable = (platform === 'ios' && !wallet?.apple) || (platform === 'android' && !wallet?.google);
  return html`${list}${unavailable ? html`<p class="fine">${t('walletUnavailable')}</p>` : ''}`;
}

function renderCard(data, offline) {
  const snap = { ...data.snapshot, language: i18n.lang };
  let showAll = platform === 'other';
  shell(html`
    ${offline ? html`<div class="notice notice-warn">${icon('alert')}<p>${t('offline')}</p></div>` : ''}
    <section class="stack">
      <h1>${t('yourCard')}</h1>
      <p class="muted">${t('showClinicians')}</p>
      <div class="card-stage">${renderFront(snap, i18n.lang)}</div>
      <div class="card-stage">${renderBack(snap, data.qrSvg, i18n.lang)}</div>
      <p class="fine">${t('updated')}: ${new Date(data.updatedAt).toLocaleString(i18n.lang === 'th' ? 'th-TH' : 'en-GB')}</p>
    </section>

    ${offline ? '' : html`<section class="panel stack mt">
      <h2>${t('saveCard')}</h2>
      <div class="stack" id="wallets">${walletButtons(data.wallet, showAll)}</div>
      <div class="option-list">
        <div class="option"><span class="tile-icon">${icon('globe')}</span><span><strong>${t('webCard')}</strong><small>${t('webCardHint')}</small></span></div>
        <button class="option" id="pdf"><span class="tile-icon">${icon('pdf')}</span><span><strong>${t('pdf')}</strong><small>${t('pdfHint')}</small></span></button>
      </div>
      ${platform !== 'other' ? html`<button class="btn btn-ghost btn-sm" id="more">${t('otherOptions')}</button>` : ''}
    </section>`}

    <details class="panel mt"><summary><strong>${t('details')}</strong></summary><div class="mt">${renderSummary(snap, i18n.lang)}</div></details>

    ${offline ? '' : html`<section class="panel stack mt">
      <h2>${icon('shield')} ${t('privacy')}</h2>
      <button class="btn btn-secondary btn-block" id="forget">${t('forget')}</button>
      <button class="btn btn-ghost btn-block" id="withdraw">${t('withdraw')}</button>
    </section>`}`);

  if (offline) return;
  const bindWallets = () => app.querySelectorAll('[data-wallet]').forEach((b) => b.addEventListener('click', () => addToWallet(b.dataset.wallet)));
  bindWallets();
  $('#more')?.addEventListener('click', (e) => {
    showAll = true;
    mount($('#wallets'), walletButtons(data.wallet, true));
    bindWallets();
    e.target.remove();
  });
  $('#pdf').addEventListener('click', async () => {
    try {
      const res = await api.get('/api/holder/card.pdf', { raw: true });
      await downloadBlob(res, 'allergy-card.pdf');
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('#forget').addEventListener('click', async () => {
    const ok = await dialog({ title: t('forget'), body: html`<p>${t('forgetBody')}</p>`, actions: [{ label: t('cancel'), value: 'cancel' }, { label: t('forget'), value: 'go', tone: 'danger' }] });
    if (!ok) return;
    await api.post('/api/holder/forget').catch(() => {});
    holder.clear();
    load();
  });
  $('#withdraw').addEventListener('click', async () => {
    const ok = await dialog({
      title: t('withdraw'),
      body: html`<p>${t('withdrawBody')}</p><label class="check"><input type="checkbox" name="sure"><span><strong>${t('withdrawCheck')}</strong></span></label>`,
      actions: [{ label: t('cancel'), value: 'cancel' }, { label: t('withdraw'), value: 'go', tone: 'danger' }],
      validate: (f) => (f.sure.checked ? null : t('mustConfirm')),
    });
    if (!ok) return;
    try {
      await api.post('/api/holder/withdraw', { confirm: true });
      holder.clear();
      emptyState(t('done'), t('withdrawn'));
    } catch (err) { toast(err.message, 'bad'); }
  });
}

/** Explicit patient confirmation is required before any Wallet pass is generated. */
async function addToWallet(kind) {
  const walletName = kind === 'apple' ? 'Apple Wallet' : 'Google Wallet';
  const res = await dialog({
    title: t('confirmWalletTitle'),
    body: html`<p>${t('confirmWalletBody', { wallet: walletName })}</p>
      <label class="check"><input type="checkbox" name="discreet"><span><strong>${t('discreet')}</strong></span></label>
      <label class="check"><input type="checkbox" name="confirm"><span><strong>${t('confirmWalletCheck')}</strong></span></label>`,
    actions: [{ label: t('cancel'), value: 'cancel' }, { label: `${t('confirm')} · ${walletName}`, value: 'go', tone: 'primary' }],
    validate: (f) => (f.confirm.checked ? null : t('mustConfirm')),
  });
  if (!res) return;
  try {
    const body = { confirm: true, discreet: Boolean(res.form.discreet) };
    if (kind === 'apple') {
      const { downloadUrl } = await api.post('/api/holder/wallet/apple', body);
      location.assign(downloadUrl);
    } else {
      const { saveUrl } = await api.post('/api/holder/wallet/google', body);
      location.assign(saveUrl);
    }
  } catch (err) { toast(err.message, 'bad'); }
}

document.documentElement.lang = i18n.lang;
load();
registerServiceWorker();
