import { $, html, mount, createApi, formData, icon, registerServiceWorker } from './core.js';
import { renderFront, renderBack } from './cardRender.js';
import { createI18n, MONTHS } from './patientI18n.js';

const i18n = createI18n();
const t = (k, v) => i18n.t(k, v);
const app = document.getElementById('app');
const KEY = 'pt.claim';

// The claim token arrives in the URL fragment (never sent to the server or in
// Referer headers). Move it to tab-scoped storage and strip it from the URL.
const state = (() => {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }
  const m = /[#&]t=([A-Za-z0-9_-]{30,})/.exec(location.hash);
  if (m) {
    saved = { token: m[1] };
    history.replaceState(null, '', location.pathname);
  }
  return saved;
})();
const persist = () => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };
const clear = () => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } };
persist();

const api = createApi({ authHeader: () => (state.session ? `Claim ${state.session}` : null) });

function shell(content, step = 0) {
  mount(app, html`
    <div class="patient-top">
      <span class="brand"><img src="/icons/icon-192.png" alt=""><span>${t('appName')}</span></span>
      <div class="lang-toggle" role="group" aria-label="Language">
        <button type="button" data-lang="th" aria-pressed="${i18n.lang === 'th'}">ไทย</button>
        <button type="button" data-lang="en" aria-pressed="${i18n.lang === 'en'}">EN</button>
      </div>
    </div>
    ${step ? html`<ol class="steps" aria-hidden="true">${[1, 2, 3].map((n) => html`<li class="${n < step ? 'done' : n === step ? 'now' : ''}"></li>`)}</ol>` : ''}
    ${content}`);
  app.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => { i18n.lang = b.dataset.lang; route(); }));
}

function fail(message) {
  clear();
  shell(html`<div class="verify-card verify-bad"><div class="verify-icon">!</div><h1>${message}</h1></div>`);
}

let countdown = null;
function startCountdown(expiresAt) {
  clearInterval(countdown);
  const el = () => $('#expiry');
  const tick = () => {
    const left = Math.max(0, new Date(expiresAt) - Date.now());
    if (el()) el().textContent = `${t('expiresIn')} ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    if (!left) { clearInterval(countdown); fail(t('invalidLink')); }
  };
  tick();
  countdown = setInterval(tick, 1000);
}

// ------------------------------------------------------------------ step 1: identity
async function identityStep() {
  let info;
  try {
    info = await api.post('/api/claim/start', { token: state.token });
  } catch {
    return fail(t('invalidLink'));
  }
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 120 }, (_, i) => thisYear - i);
  shell(html`
    <section class="panel stack">
      <div class="eyebrow">${i18n.lang === 'th' ? info.facility.nameTh : info.facility.nameEn}</div>
      <h1>${t('step1')}</h1>
      <p class="muted">${t('step1Lead')}</p>
      <form id="idform" class="stack" novalidate autocomplete="off">
        <fieldset class="field"><legend>${t('dob')}</legend>
          <div class="dob-grid">
            <select name="day" aria-label="${t('day')}"><option value="">${t('day')}</option>${Array.from({ length: 31 }, (_, i) => html`<option value="${i + 1}">${i + 1}</option>`)}</select>
            <select name="month" aria-label="${t('month')}"><option value="">${t('month')}</option>${MONTHS[i18n.lang].map((m, i) => html`<option value="${i + 1}">${m}</option>`)}</select>
            <select name="year" aria-label="${t('year')}"><option value="">${t('year')}</option>${years.map((y) => html`<option value="${y}">${i18n.lang === 'th' ? y + 543 : y}</option>`)}</select>
          </div>
        </fieldset>
        <label class="field"><span>${t('idLast4')}</span><input type="text" name="idLast4" maxlength="4" inputmode="text" autocapitalize="characters" autocomplete="off" pattern="[A-Za-z0-9]{4}"></label>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block">${icon('shield')} ${t('verify')}</button>
        <p class="fine" id="expiry"></p>
      </form>
    </section>`, 1);
  startCountdown(info.expiresAt);
  const form = $('#idform');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const err = $('.form-error', form);
    if (!d.day || !d.month || !d.year || !/^[A-Za-z0-9]{4}$/.test(d.idLast4)) {
      err.textContent = `${t('dob')} / ${t('idLast4')}`;
      err.hidden = false;
      return;
    }
    const dob = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    try {
      const res = await api.post('/api/claim/verify', { token: state.token, dob, idLast4: d.idLast4 });
      state.session = res.session;
      delete state.token;
      persist();
      clearInterval(countdown);
      route();
    } catch (ex) {
      if (ex.code === 'IDENTITY_MISMATCH') {
        err.textContent = t('attemptsLeft', { n: ex.body.attemptsRemaining });
        err.hidden = false;
      } else if (ex.code === 'CLAIM_LOCKED') fail(t('locked'));
      else fail(t('invalidLink'));
    }
  });
}

// ------------------------------------------------------------------ step 2: review + consent
async function consentStep() {
  let s;
  try {
    s = await api.get(`/api/claim/session?lang=${i18n.lang}`);
  } catch {
    return fail(t('sessionExpired'));
  }
  const snap = { ...s.snapshot, serial: '—', language: i18n.lang };
  const facility = i18n.lang === 'th' ? s.facility.nameTh : s.facility.nameEn;
  shell(html`
    <section class="stack">
      <h1>${t('step2')}</h1>
      <div class="notice notice-info">${icon('eye')}<p>${t('isThisYou')}</p></div>
      <div class="card-stage">${renderFront(snap, i18n.lang)}</div>
      <div class="card-stage">${renderBack(snap, null, i18n.lang)}</div>
      <form class="panel stack" id="consent" novalidate>
        <h2>${icon('shield')} ${t('consentTitle')}</h2>
        <p class="fine">${t('consentBody', { facility, days: s.retentionDays, phone: s.facility.phone })}</p>
        <label class="check"><input type="checkbox" name="health_data_processing"><span><strong>${t('consentHealth')}</strong></span></label>
        <label class="check"><input type="checkbox" name="digital_card"><span><strong>${t('consentCard')}</strong></span></label>
        <label class="check"><input type="checkbox" name="keep"><span><strong>${t('keepOnDevice')}</strong><small>${t('keepHint')}</small></span></label>
        <p class="fine">${t('consentVersion')} ${s.consentVersion}</p>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block" value="accept">${t('accept')}</button>
        <button class="btn btn-ghost btn-block" type="button" id="decline">${t('decline')}</button>
      </form>
    </section>`, 2);
  const form = $('#consent');
  $('#decline').addEventListener('click', () => {
    clear();
    shell(html`<div class="verify-card"><div class="verify-icon">i</div><p>${t('declined')}</p></div>`);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const err = $('.form-error', form);
    if (!d.health_data_processing || !d.digital_card) {
      err.textContent = t('mustConfirm');
      err.hidden = false;
      return;
    }
    try {
      const res = await api.post('/api/claim/complete', {
        consents: { health_data_processing: true, digital_card: true },
        language: i18n.lang,
      });
      // The device credential is stored locally only; it never appears in a URL.
      try {
        if (d.keep) localStorage.setItem('pt.holder', res.holderToken);
        else sessionStorage.setItem('pt.holder', res.holderToken);
      } catch { /* storage unavailable */ }
      clear();
      location.replace('/card');
    } catch (ex) {
      if (ex.status === 401) fail(t('sessionExpired'));
      else { err.textContent = ex.message; err.hidden = false; }
    }
  });
}

function route() {
  if (state.session) return consentStep();
  if (state.token) return identityStep();
  return fail(t('noToken'));
}

document.documentElement.lang = i18n.lang;
route();
registerServiceWorker();

