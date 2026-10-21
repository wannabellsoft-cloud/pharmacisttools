import {
  $, $$, html, raw, mount, icon, toast, dialog, formData, createApi, createRouter, downloadBlob, relTime, registerServiceWorker, ApiError,
} from './core.js';
import { renderFront, renderBack, renderA4, renderSummary, printCard } from './cardRender.js';
import {
  NARANJO_QUESTIONS, NARANJO_CATEGORIES, REACTION_TYPES, CERTAINTY, CONFIRMATION_BASIS, CLINICAL_STATUS, SEVERITY, MANIFESTATIONS,
  CARD_VISIBLE_STATUS, scoreNaranjo, validateRecord, maskId, label,
} from '/shared/clinical.js';
import { formatDate, patientName } from '/shared/cardText.js';

const TOKEN_KEY = 'pt.session';
const store = {
  get token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v) { try { if (v) sessionStorage.setItem(TOKEN_KEY, v); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } },
};
let me = null;
let appConfig = null;

const api = createApi({
  authHeader: () => (store.token ? `Bearer ${store.token}` : null),
  onUnauthorized: () => {
    store.token = null;
    me = null;
    if (!location.hash.startsWith('#/login')) location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1) || '/')}`;
  },
});

const app = document.getElementById('app');
const en = (dict, key) => label(dict, key, 'en');
const th = (dict, key) => label(dict, key, 'th');

const REASONS = {
  PENDING_REVIEW: 'Some allergy/ADR records are awaiting pharmacist review.',
  NO_VERIFIED_RECORDS: 'There is no verified allergy/ADR record to put on a card.',
  PATIENT_ERASED: 'Patient data has been erased.',
};

// ------------------------------------------------------------------ layout
function layout(content, { back } = {}) {
  mount(app, html`
    <header class="appbar">
      <a class="brand" href="#/"><img src="/icons/icon-192.png" alt=""><span>PharmaTools<small>เครื่องมือเภสัชกร</small></span></a>
      <span class="spacer"></span>
      ${me ? html`<div class="who"><strong>${me.displayName}</strong>${me.licenseNo}</div>
        ${me.role === 'admin' ? html`<a class="btn btn-ghost icon-btn" href="#/admin/audit" title="Audit log" aria-label="Audit log">${icon('log')}</a>` : ''}
        <button class="btn btn-ghost icon-btn" id="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>` : ''}
    </header>
    <main class="view" id="main" tabindex="-1">
      ${back ? html`<a class="crumb" href="${back[0]}">${icon('back')} ${back[1]}</a>` : ''}
      ${content}
    </main>`);
  $('#logout')?.addEventListener('click', async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    store.token = null;
    me = null;
    location.hash = '#/login';
  });
  window.scrollTo(0, 0);
  return $('#main');
}

function loading(back) {
  layout(html`<p class="muted">Loading…</p>`, { back });
}

function showError(err, back) {
  if (err instanceof ApiError && err.status === 401) return;
  layout(html`<div class="notice notice-bad">${icon('alert')}<div><strong>Something went wrong</strong><p>${err.message}</p></div></div>`, { back });
}

/** Wraps a view so loading/auth/errors are handled consistently. */
const view = (fn, { auth = true } = {}) => async (params, query) => {
  if (auth && !me) {
    if (!store.token) return void (location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1) || '/')}`);
    try {
      me = (await api.get('/api/auth/me')).pharmacist;
    } catch { return; }
  }
  if (!appConfig) appConfig = await api.get('/api/config').catch(() => ({ facility: {}, wallet: {} }));
  try {
    await fn(params, query);
  } catch (err) {
    showError(err);
  }
};

const pillForReview = (r) => r.reviewStatus === 'verified'
  ? html`<span class="pill pill-ok">${icon('check')} Verified</span>`
  : html`<span class="pill pill-warn">${icon('clock')} Pending review</span>`;
const pillForCertainty = (c) => html`<span class="pill pill-${c}">${en(CERTAINTY, c)} · ${th(CERTAINTY, c)}</span>`;
const pillForCard = (c) => {
  if (c.status === 'revoked') return html`<span class="pill pill-bad">Revoked</span>`;
  if (c.status === 'superseded') return html`<span class="pill">Superseded</span>`;
  if (c.outdated) return html`<span class="pill pill-warn">Active · out of date</span>`;
  return html`<span class="pill pill-ok">Active</span>`;
};

function fieldErrors(form, errors) {
  $$('.invalid', form).forEach((el) => el.classList.remove('invalid'));
  $$('.field-error', form).forEach((el) => el.remove());
  const messages = {
    REQUIRED: 'Required', INVALID: 'Invalid value', CHECKSUM: 'National ID check digit is invalid', DUPLICATE_HN: 'HN already exists',
    CONFIRMATION_BASIS_REQUIRED: 'Select the clinical evidence that confirms this reaction',
    CONFIRMATION_NOTE_REQUIRED: 'Document the confirming evidence (at least 5 characters)',
  };
  for (const e of errors) {
    const host = form.querySelector(`[data-field="${e.field}"]`);
    if (!host) continue;
    host.classList.add('invalid');
    const p = document.createElement('span');
    p.className = 'field-error';
    p.textContent = messages[e.code] || e.code;
    host.append(p);
  }
  form.querySelector('.invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ------------------------------------------------------------------ login
async function loginView(_p, query) {
  mount(app, html`<div class="auth-wrap"><form class="auth-card stack" id="login" novalidate>
    <a class="brand" href="#/"><img src="/icons/icon-192.png" alt=""><span>PharmaTools<small>เครื่องมือเภสัชกร</small></span></a>
    <h1>Pharmacist sign in</h1>
    <p class="muted">เข้าสู่ระบบสำหรับเภสัชกร · Access is logged.</p>
    <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required autocapitalize="none"></label>
    <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
    <p class="form-error" hidden></p>
    <button class="btn btn-primary btn-block">Sign in</button>
  </form></div>`);
  const form = $('#login');
  form.username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    try {
      const res = await api.post('/api/auth/login', formData(form));
      store.token = res.token;
      me = res.pharmacist;
      location.hash = `#${query.get('next') || '/'}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

// ------------------------------------------------------------------ home
async function homeView() {
  layout(html`
    <section class="hero">
      <div class="eyebrow">PharmaTools</div>
      <h1>สวัสดี, ${me.displayName}</h1>
      <p class="muted">Clinical tools for pharmacists. Choose a tool to begin.</p>
    </section>
    <div class="tiles">
      <a class="tile" href="#/allergy">
        <span class="tile-icon red">${icon('card')}</span>
        <div><h3>Drug Allergy Cards</h3><p>บัตรแพ้ยา — assess, verify and issue printed or digital (Wallet) allergy cards.</p></div>
      </a>
      <a class="tile" href="#/naranjo">
        <span class="tile-icon">${icon('calc')}</span>
        <div><h3>Naranjo ADR Probability</h3><p>Causality assessment for suspected adverse drug reactions.</p></div>
      </a>
      ${me.role === 'admin' ? html`<a class="tile" href="#/admin/audit">
        <span class="tile-icon">${icon('shield')}</span>
        <div><h3>Audit & Data Retention</h3><p>Tamper-evident audit trail and PDPA retention controls.</p></div>
      </a>` : ''}
    </div>`);
}

// ------------------------------------------------------------------ naranjo (standalone + embedded)
function naranjoFields(answers = {}) {
  return html`${NARANJO_QUESTIONS.map((q, i) => html`<div class="naranjo-q">
    <div class="q">${i + 1}. ${q.en}<small>${q.th}</small></div>
    <div class="segmented" role="radiogroup" aria-label="Question ${i + 1}">
      ${['yes', 'no', 'unknown'].map((a, idx) => html`<label><input type="radio" name="naranjo_${q.id}" value="${a}" ${answers[q.id] === a ? 'checked' : ''}>
        <span>${['Yes · ใช่', 'No · ไม่ใช่', "Don't know"][idx]} <small class="muted">&nbsp;(${q.score[idx] > 0 ? '+' : ''}${q.score[idx]})</small></span></label>`)}
    </div>
  </div>`)}`;
}

function readNaranjo(form) {
  const answers = {};
  for (const q of NARANJO_QUESTIONS) {
    const v = form.querySelector(`input[name="naranjo_${q.id}"]:checked`)?.value;
    if (v) answers[q.id] = v;
  }
  return answers;
}

function naranjoScoreBox(answers) {
  const s = scoreNaranjo(answers);
  return html`<div class="score-box">
    <div class="score-num">${s.answered ? s.score : '–'}</div>
    <div><strong>${s.answered ? `${en(NARANJO_CATEGORIES, s.category)} · ${th(NARANJO_CATEGORIES, s.category)}` : 'Not scored'}</strong>
    <div class="fine">${s.answered}/10 answered · ≥9 definite, 5–8 probable, 1–4 possible, ≤0 doubtful</div></div>
  </div>`;
}

async function naranjoView() {
  const main = layout(html`
    <div class="page-head"><div><div class="eyebrow">Tool</div><h1>Naranjo ADR Probability Scale</h1>
      <p>Estimates the likelihood that a drug caused an adverse event.</p></div></div>
    <div class="notice notice-info">${icon('alert')}<p>The Naranjo score is a causality estimate. It does <strong>not</strong> diagnose or confirm a drug allergy. คะแนนนี้ใช้ประเมินความสัมพันธ์ ไม่ใช่การยืนยันการแพ้ยา</p></div>
    <form class="panel" id="nform">${naranjoFields()}<div id="score" class="stack"></div></form>`, { back: ['#/', 'Home'] });
  const form = $('#nform', main);
  const update = () => mount($('#score', main), naranjoScoreBox(readNaranjo(form)));
  form.addEventListener('change', update);
  update();
}

// ------------------------------------------------------------------ patients
async function patientsView(_p, query) {
  const hn = query.get('hn') || '';
  loading(['#/', 'Home']);
  const { patients } = await api.get(`/api/patients${hn ? `?hn=${encodeURIComponent(hn)}` : ''}`);
  const main = layout(html`
    <div class="page-head">
      <div><div class="eyebrow">Drug Allergy Cards · บัตรแพ้ยา</div><h1>Patients</h1><p>Search by HN (exact match) or open a recent patient.</p></div>
      <a class="btn btn-primary" href="#/allergy/new">${icon('plus')} New patient</a>
    </div>
    <form class="panel row" id="search" role="search">
      <label class="sr-only" for="hn">HN</label>
      <input id="hn" type="search" name="hn" placeholder="Hospital number (HN)" value="${hn}" autocomplete="off" inputmode="text">
      <button class="btn btn-secondary">${icon('search')} Search</button>
    </form>
    <section class="panel">
      <div class="panel-head"><h2>${hn ? 'Search result' : 'Recent patients'}</h2></div>
      ${patients.length ? html`<ul class="list">${patients.map((p) => html`<li><a class="list-item" href="#/allergy/p/${p.id}">
        <span class="avatar">${(p.firstNameTh || p.firstNameEn || '?').slice(0, 1)}</span>
        <span class="grow"><span class="title">${patientName(p, 'bi')}</span><span class="sub">HN ${p.hn} · DOB ${formatDate(p.dob, 'en')} · ID ••••${p.idLast4}</span></span>
      </a></li>`)}</ul>` : html`<p class="muted">${hn ? 'No patient with this HN.' : 'No patients yet.'}</p>`}
    </section>`, { back: ['#/', 'Home'] });
  $('#search', main).addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/allergy?hn=${encodeURIComponent($('#hn', main).value.trim())}`;
  });
}

function patientFormFields(p = {}) {
  return html`
    <div class="form-grid cols-2">
      <label class="field" data-field="hn"><span>HN *</span><input type="text" name="hn" value="${p.hn || ''}" required autocomplete="off"></label>
      <label class="field" data-field="nationalId"><span>National ID / Passport *</span><input type="text" name="nationalId" value="${p.nationalId || ''}" required autocomplete="off" inputmode="numeric">
        <small>Used for the patient's identity check when claiming a digital card. Stored encrypted.</small></label>
      <label class="field" data-field="name"><span>ชื่อ (ไทย)</span><input type="text" name="firstNameTh" value="${p.firstNameTh || ''}" lang="th"></label>
      <label class="field"><span>นามสกุล (ไทย)</span><input type="text" name="lastNameTh" value="${p.lastNameTh || ''}" lang="th"></label>
      <label class="field"><span>First name (English)</span><input type="text" name="firstNameEn" value="${p.firstNameEn || ''}"></label>
      <label class="field"><span>Last name (English)</span><input type="text" name="lastNameEn" value="${p.lastNameEn || ''}"></label>
      <label class="field" data-field="dob"><span>Date of birth *</span><input type="date" name="dob" value="${p.dob || ''}" required></label>
      <label class="field"><span>Sex</span><select name="sex">
        ${[['', '—'], ['F', 'Female · หญิง'], ['M', 'Male · ชาย'], ['X', 'Other · อื่น ๆ']].map(([v, l]) => html`<option value="${v}" ${p.sex === v ? 'selected' : ''}>${l}</option>`)}
      </select></label>
      <label class="field"><span>Phone (optional)</span><input type="tel" name="phone" value="${p.phone || ''}" autocomplete="off"></label>
    </div>`;
}

async function patientFormView({ pid }) {
  const editing = Boolean(pid);
  const patient = editing ? (await api.get(`/api/patients/${pid}`)).patient : {};
  const back = editing ? [`#/allergy/p/${pid}`, 'Patient'] : ['#/allergy', 'Patients'];
  const main = layout(html`
    <div class="page-head"><div><div class="eyebrow">Patient</div><h1>${editing ? 'Edit patient' : 'New patient'}</h1>
      <p>Thai or English name required. Identifiers are encrypted at rest (PDPA).</p></div></div>
    <form class="panel stack" id="pform" novalidate>${patientFormFields(patient)}
      <div class="row row-end"><a class="btn btn-ghost" href="${back[0]}">Cancel</a><button class="btn btn-primary">${editing ? 'Save changes' : 'Create patient'}</button></div>
    </form>`, { back });
  const form = $('#pform', main);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = formData(form);
      const res = editing ? await api.put(`/api/patients/${pid}`, body) : await api.post('/api/patients', body);
      toast(editing ? 'Patient updated' : 'Patient created', 'ok');
      location.hash = `#/allergy/p/${res.patient.id}`;
    } catch (err) {
      if (err.body?.errors) fieldErrors(form, err.body.errors);
      else if (err.code === 'DUPLICATE_HN') fieldErrors(form, [{ field: 'hn', code: 'DUPLICATE_HN' }]);
      else toast(err.message, 'bad');
    }
  });
}

function recordCard(r, { actions = true } = {}) {
  const visible = CARD_VISIBLE_STATUS.includes(r.clinicalStatus);
  return html`<article class="record ${r.certainty === 'confirmed' ? 'is-confirmed' : ''} ${visible ? '' : 'is-muted'}">
    <div class="record-head">
      <div class="record-title">${r.drugGeneric}${r.drugBrand ? html` <span class="muted">(${r.drugBrand})</span>` : ''}</div>
      <div class="row">${pillForCertainty(r.certainty)} ${pillForReview(r)}</div>
    </div>
    <div class="record-meta">
      ${en(REACTION_TYPES, r.reactionType)} · ${(r.manifestations || []).map((m) => en(MANIFESTATIONS, m)).join(', ')} · ${en(SEVERITY, r.severity)}
      · <strong>${en(CLINICAL_STATUS, r.clinicalStatus)}</strong>${visible ? '' : ' (not shown on cards)'}
    </div>
    <div class="record-meta">Assessed ${formatDate(r.assessmentDate, 'en')}
      ${r.naranjo ? html` · Naranjo ${r.naranjo.score} (${en(NARANJO_CATEGORIES, r.naranjo.category)})` : ''}
      · v${r.version}${r.verifier ? html` · Verified by ${r.verifier.displayName} ${relTime(r.verifiedAt)}` : ''}</div>
    ${actions ? html`<div class="record-actions">
      ${r.reviewStatus !== 'verified' ? html`<a class="btn btn-primary btn-sm" href="#/allergy/r/${r.id}/verify">${icon('shield')} Review & verify</a>` : ''}
      <a class="btn btn-secondary btn-sm" href="#/allergy/r/${r.id}/edit">Edit</a>
    </div>` : ''}
  </article>`;
}

async function patientView({ pid }) {
  loading(['#/allergy', 'Patients']);
  const { patient, records, readiness, cards } = await api.get(`/api/patients/${pid}`);
  if (patient.erased) {
    layout(html`<div class="notice notice-bad">${icon('alert')}<p>This patient's data was erased under the data retention / erasure policy.</p></div>`, { back: ['#/allergy', 'Patients'] });
    return;
  }
  const main = layout(html`
    <div class="page-head">
      <div><div class="eyebrow">Patient · HN ${patient.hn}</div><h1>${patientName(patient, 'bi')}</h1>
        <p>DOB ${formatDate(patient.dob, 'en')} (${formatDate(patient.dob, 'th')}) · ID ${maskId(patient.nationalId)}</p></div>
      <div class="row"><a class="btn btn-secondary btn-sm" href="#/allergy/p/${pid}/edit">Edit patient</a></div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>Drug allergy / ADR records</h2><a class="btn btn-secondary btn-sm" href="#/allergy/p/${pid}/record/new">${icon('plus')} Add record</a></div>
      ${records.length ? records.map((r) => recordCard(r)) : html`<p class="muted">No allergy or ADR records yet.</p>`}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Allergy card</h2></div>
      ${readiness.ready
        ? html`<div class="notice notice-ok">${icon('check')}<p>All ${readiness.includedCount} record(s) are pharmacist-verified. A card can be issued.</p></div>
          <a class="btn btn-primary btn-block" href="#/allergy/p/${pid}/issue">${icon('card')} Issue drug allergy card</a>`
        : html`<div class="notice notice-warn">${icon('alert')}<div>${readiness.reasons.map((r) => html`<p>${REASONS[r] || r}</p>`)}<p class="fine">Cards can only be issued after pharmacist review of every record.</p></div></div>
          <button class="btn btn-primary btn-block" disabled>${icon('card')} Issue drug allergy card</button>`}
      ${cards.length ? html`<h3 class="mt">Issued cards</h3><ul class="list">${cards.map((c) => html`<li><a class="list-item" href="#/allergy/c/${c.id}">
        <span class="tile-icon ${c.kind === 'physical' ? 'red' : ''}">${icon(c.kind === 'physical' ? 'printer' : 'phone')}</span>
        <span class="grow"><span class="title">${c.kind === 'physical' ? 'Printed card' : 'Digital card'} · ${c.serial}</span>
          <span class="sub">Issued ${relTime(c.issuedAt)} · v${c.version}${c.format ? ` · ${c.format.toUpperCase()}` : ''}</span></span>
        ${pillForCard(c)}
      </a></li>`)}</ul>` : ''}
    </section>

    <details class="panel" id="consents"><summary><strong>Consent records (PDPA)</strong></summary><div class="stack" id="consent-body"><p class="muted">Loading…</p></div></details>
    <details class="panel" id="audit"><summary><strong>Audit trail</strong></summary><div id="audit-body"><p class="muted">Loading…</p></div></details>

    <section class="panel">
      <div class="panel-head"><h2>Data protection</h2></div>
      <p class="fine">Retention: data is kept until ${formatDate(patient.retainUntil, 'en')} and then erased automatically, unless updated.
      Erasure on request revokes all cards (including Wallet passes) and crypto-shreds identifiers and clinical content. The PII-free audit trail is retained.</p>
      <button class="btn btn-ghost" id="erase">${icon('ban')} Erase patient data…</button>
    </section>`, { back: ['#/allergy', 'Patients'] });

  $('#consents', main).addEventListener('toggle', async (e) => {
    if (!e.target.open) return;
    const { consents } = await api.get(`/api/patients/${pid}/consents`);
    mount($('#consent-body', main), consents.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Scope</th><th>Method</th><th>Version</th><th>Granted</th><th>Withdrawn</th></tr></thead><tbody>
      ${consents.map((c) => html`<tr><td>${c.scope}</td><td>${c.method === 'patient_self' ? 'Patient (own device)' : 'Recorded by pharmacist'}</td><td>${c.version}</td><td>${relTime(c.granted_at)}</td><td>${c.withdrawn_at ? relTime(c.withdrawn_at) : '—'}</td></tr>`)}
    </tbody></table></div>` : html`<p class="muted">No consents recorded.</p>`);
  }, { once: false });
  $('#audit', main).addEventListener('toggle', async (e) => {
    if (!e.target.open) return;
    const { entries } = await api.get(`/api/patients/${pid}/audit`);
    mount($('#audit-body', main), auditTable(entries));
  });
  $('#erase', main).addEventListener('click', async () => {
    const res = await dialog({
      title: 'Erase patient data?',
      body: html`<p>This revokes every printed, digital and Wallet card and permanently erases identifiers and clinical content. Confirm that this complies with your medical-records retention obligations.</p>
        <label class="field"><span>Reason</span><select name="reason"><option value="data_subject_request">Data subject request (PDPA)</option><option value="entered_in_error">Patient created in error</option></select></label>
        <label class="field"><span>Confirm with your password</span><input type="password" name="password" autocomplete="current-password" required></label>`,
      actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Erase permanently', value: 'erase', tone: 'danger' }],
      validate: (f) => (f.password.value ? null : 'Password is required.'),
    });
    if (!res) return;
    try {
      await api.post(`/api/patients/${pid}/erase`, res.form);
      toast('Patient data erased', 'ok');
      location.hash = '#/allergy';
    } catch (err) { toast(err.message, 'bad'); }
  });
}

function auditTable(entries) {
  if (!entries.length) return html`<p class="muted">No entries.</p>`;
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>
    ${entries.map((e) => html`<tr><td>${relTime(e.ts)}</td><td>${e.actor_type}${e.actorName ? html`<br><span class="muted">${e.actorName}</span>` : ''}</td>
      <td><span class="mono">${e.action}</span></td><td class="mono">${e.details ? JSON.stringify(e.details) : ''}</td></tr>`)}
  </tbody></table></div>`;
}

// ------------------------------------------------------------------ record form
function recordFormFields(r) {
  const opt = (dict, sel) => Object.keys(dict).map((k) => html`<option value="${k}" ${sel === k ? 'selected' : ''}>${en(dict, k)} · ${th(dict, k)}</option>`);
  const seg = (name, dict, sel) => html`<div class="segmented">${Object.keys(dict).map((k) => html`<label><input type="radio" name="${name}" value="${k}" ${sel === k ? 'checked' : ''}><span>${en(dict, k)}<br><small>${th(dict, k)}</small></span></label>`)}</div>`;
  return html`
    <section class="panel stack">
      <h2>Suspected drug</h2>
      <div class="form-grid cols-2">
        <label class="field" data-field="drugGeneric"><span>Generic name *</span><input type="text" name="drugGeneric" value="${r.drugGeneric || ''}" placeholder="e.g. Amoxicillin" autocomplete="off"></label>
        <label class="field"><span>Brand name</span><input type="text" name="drugBrand" value="${r.drugBrand || ''}" autocomplete="off"></label>
        <label class="field"><span>Drug class</span><input type="text" name="drugClass" value="${r.drugClass || ''}" placeholder="e.g. Penicillins" autocomplete="off"></label>
        <label class="field"><span>Onset date</span><input type="date" name="onsetDate" value="${r.onsetDate || ''}"></label>
      </div>
    </section>

    <section class="panel stack">
      <h2>Reaction</h2>
      <fieldset class="field" data-field="reactionType"><legend>Type *</legend>${seg('reactionType', REACTION_TYPES, r.reactionType || 'allergy')}</fieldset>
      <fieldset class="field" data-field="manifestations"><legend>Manifestations *</legend>
        <div class="chips">${Object.keys(MANIFESTATIONS).map((m) => html`<label class="chip"><input type="checkbox" name="manifestations" value="${m}" data-multi ${(r.manifestations || []).includes(m) ? 'checked' : ''}><span>${en(MANIFESTATIONS, m)} · ${th(MANIFESTATIONS, m)}</span></label>`)}</div>
      </fieldset>
      <label class="field"><span>Reaction description (shown on card)</span><input type="text" name="reactionNote" value="${r.reactionNote || ''}" maxlength="80" placeholder="Short description, e.g. ผื่นลมพิษทั่วตัว ปากบวม"></label>
      <fieldset class="field" data-field="severity"><legend>Severity *</legend>${seg('severity', SEVERITY, r.severity || 'moderate')}</fieldset>
    </section>

    <section class="panel stack">
      <div class="panel-head"><h2>Naranjo causality assessment</h2><span class="pill pill-brand">Optional</span></div>
      <div class="notice notice-info">${icon('alert')}<p>Naranjo estimates causality only. It is never used to classify an ADR as a confirmed allergy. ใช้ประเมินความสัมพันธ์ ไม่ใช่การยืนยันการแพ้ยา</p></div>
      <div id="naranjo">${naranjoFields(r.naranjo?.answers || {})}</div>
      <div id="naranjo-score"></div>
    </section>

    <section class="panel stack">
      <h2>Clinical classification</h2>
      <fieldset class="field" data-field="certainty"><legend>Certainty *</legend>
        <div class="segmented">
          <label><input type="radio" name="certainty" value="suspected" ${r.certainty !== 'confirmed' ? 'checked' : ''}><span>Suspected<br><small>สงสัย</small></span></label>
          <label><input type="radio" name="certainty" value="confirmed" ${r.certainty === 'confirmed' ? 'checked' : ''}><span>Confirmed<br><small>ยืนยันแล้ว</small></span></label>
        </div>
        <small>Default is <strong>suspected</strong>. Choose confirmed only with documented clinical evidence.</small>
      </fieldset>
      <div id="confirm-block" class="stack">
        <fieldset class="field" data-field="confirmationBasis"><legend>Confirming evidence *</legend>
          <div class="stack">${Object.keys(CONFIRMATION_BASIS).map((b) => html`<label class="check"><input type="checkbox" name="confirmationBasis" value="${b}" data-multi ${(r.confirmationBasis || []).includes(b) ? 'checked' : ''}>
            <span><strong>${en(CONFIRMATION_BASIS, b)}</strong><small>${th(CONFIRMATION_BASIS, b)}</small></span></label>`)}</div>
        </fieldset>
        <label class="field" data-field="confirmationNote"><span>Evidence documentation *</span><textarea name="confirmationNote" placeholder="Test, date, result, physician…">${r.confirmationNote || ''}</textarea></label>
      </div>
      <div class="form-grid cols-2">
        <label class="field" data-field="clinicalStatus"><span>Clinical status *</span><select name="clinicalStatus">${opt(CLINICAL_STATUS, r.clinicalStatus || 'active')}</select>
          <small>Refuted / entered-in-error records never appear on cards.</small></label>
        <label class="field" data-field="assessmentDate"><span>Assessment date *</span><input type="date" name="assessmentDate" value="${r.assessmentDate || new Date().toISOString().slice(0, 10)}"></label>
      </div>
      <label class="field"><span>Internal note (not printed)</span><textarea name="internalNote">${r.internalNote || ''}</textarea></label>
    </section>`;
}

async function recordFormView({ pid, rid }) {
  const editing = Boolean(rid);
  const record = editing ? (await api.get(`/api/records/${rid}`)).record : {};
  const patientId = pid || record.patientId;
  const back = [`#/allergy/p/${patientId}`, 'Patient'];
  const main = layout(html`
    <div class="page-head"><div><div class="eyebrow">Allergy / ADR record</div><h1>${editing ? `Edit ${record.drugGeneric}` : 'New allergy / ADR record'}</h1>
      <p>Saving sends the record for pharmacist review. Any change to a verified record requires re-verification.</p></div></div>
    <form id="rform" novalidate>${recordFormFields(record)}
      <div class="row row-end"><a class="btn btn-ghost" href="${back[0]}">Cancel</a><button class="btn btn-primary">Save for review</button></div>
    </form>`, { back });
  const form = $('#rform', main);
  const sync = () => {
    mount($('#naranjo-score', main), naranjoScoreBox(readNaranjo(form)));
    const confirmed = form.querySelector('input[name="certainty"]:checked')?.value === 'confirmed';
    $('#confirm-block', main).hidden = !confirmed;
  };
  form.addEventListener('change', sync);
  sync();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const body = {
      drugGeneric: d.drugGeneric, drugBrand: d.drugBrand, drugClass: d.drugClass, onsetDate: d.onsetDate,
      reactionType: d.reactionType, manifestations: d.manifestations || [], reactionNote: d.reactionNote, severity: d.severity,
      certainty: d.certainty, confirmationBasis: d.certainty === 'confirmed' ? d.confirmationBasis || [] : [],
      confirmationNote: d.certainty === 'confirmed' ? d.confirmationNote : '',
      clinicalStatus: d.clinicalStatus, assessmentDate: d.assessmentDate, internalNote: d.internalNote,
      naranjoAnswers: readNaranjo(form),
    };
    const errors = validateRecord(body);
    if (errors.length) return fieldErrors(form, errors);
    try {
      const res = editing ? await api.put(`/api/records/${rid}`, body) : await api.post(`/api/patients/${patientId}/records`, body);
      toast('Saved — pending pharmacist review', 'ok');
      location.hash = `#/allergy/r/${res.record.id}/verify`;
    } catch (err) {
      if (err.body?.errors) fieldErrors(form, err.body.errors);
      else toast(err.message, 'bad');
    }
  });
}

// ------------------------------------------------------------------ verification
async function verifyRecordView({ rid }) {
  const { record } = await api.get(`/api/records/${rid}`);
  const back = [`#/allergy/p/${record.patientId}`, 'Patient'];
  if (record.reviewStatus === 'verified') {
    layout(html`<div class="notice notice-ok">${icon('check')}<p>Version ${record.version} of this record is already verified.</p></div>${recordCard(record, { actions: false })}`, { back });
    return;
  }
  const n = record.naranjo;
  const cautions = [];
  if (n && record.certainty === 'suspected' && n.category === 'definite') cautions.push('Naranjo is "definite", but this does not confirm an allergy by itself. Keep as suspected unless confirmed by clinical evidence.');
  if (record.certainty === 'confirmed' && n && ['doubtful', 'possible'].includes(n.category)) cautions.push(`Marked confirmed while Naranjo is "${n.category}". Check that the documented evidence supports confirmation.`);
  if (record.certainty === 'confirmed') cautions.push('Confirmed allergies must be supported by the documented evidence below.');

  const main = layout(html`
    <div class="page-head"><div><div class="eyebrow">Pharmacist verification · v${record.version}</div><h1>Review ${record.drugGeneric}</h1>
      <p>Cards can only be issued from verified records.</p></div></div>
    ${recordCard({ ...record, verifier: null }, { actions: false })}
    <section class="panel stack mt">
      <h2>Clinical review</h2>
      <dl class="kv">
        <dt>Classification</dt><dd>${en(REACTION_TYPES, record.reactionType)} — <strong>${en(CERTAINTY, record.certainty)}</strong></dd>
        <dt>Reaction</dt><dd>${(record.manifestations || []).map((m) => en(MANIFESTATIONS, m)).join(', ')}${record.reactionNote ? ` — ${record.reactionNote}` : ''}</dd>
        ${record.certainty === 'confirmed' ? html`<dt>Evidence</dt><dd>${record.confirmationBasis.map((b) => en(CONFIRMATION_BASIS, b)).join(', ')}<br><span class="muted">${record.confirmationNote}</span></dd>` : ''}
        <dt>Naranjo</dt><dd>${n ? `${n.score} — ${en(NARANJO_CATEGORIES, n.category)} (causality only)` : 'Not assessed'}</dd>
        ${record.internalNote ? html`<dt>Internal note</dt><dd>${record.internalNote}</dd>` : ''}
      </dl>
      ${cautions.map((c) => html`<div class="notice notice-warn">${icon('alert')}<p>${c}</p></div>`)}
    </section>
    <form class="panel stack" id="vform" novalidate>
      <h2>Attestation</h2>
      <label class="check"><input type="checkbox" name="attest">
        <span><strong>I have reviewed this record against the patient history and source documents, and the classification (suspected vs confirmed) is clinically justified.</strong>
        <small>ข้าพเจ้าได้ทบทวนข้อมูลกับประวัติผู้ป่วยและเอกสารต้นฉบับแล้ว และการจัดประเภท (สงสัย/ยืนยัน) มีหลักฐานทางคลินิกรองรับ</small></span></label>
      <label class="field"><span>Review note (optional)</span><textarea name="note" maxlength="500"></textarea></label>
      <label class="field"><span>Confirm with your password</span><input type="password" name="password" autocomplete="current-password"></label>
      <p class="form-error" hidden></p>
      <div class="row row-end"><a class="btn btn-secondary" href="#/allergy/r/${rid}/edit">Edit record</a><button class="btn btn-primary">${icon('shield')} Verify as ${me.displayName}</button></div>
    </form>`, { back });
  const form = $('#vform', main);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const err = $('.form-error', form);
    if (!d.attest) { err.textContent = 'Please tick the attestation.'; err.hidden = false; return; }
    if (!d.password) { err.textContent = 'Please confirm with your password.'; err.hidden = false; return; }
    try {
      await api.post(`/api/records/${rid}/verify`, { ...d, expectedVersion: record.version });
      toast('Record verified', 'ok');
      const { readiness } = await api.get(`/api/patients/${record.patientId}`);
      location.hash = readiness.ready ? `#/allergy/p/${record.patientId}/issue` : `#/allergy/p/${record.patientId}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

// ------------------------------------------------------------------ issuance: exactly two options
async function issueView({ pid }) {
  const { patient, readiness, cards } = await api.get(`/api/patients/${pid}`);
  const back = [`#/allergy/p/${pid}`, 'Patient'];
  if (!readiness.ready) {
    layout(html`<div class="notice notice-warn">${icon('alert')}<div>${readiness.reasons.map((r) => html`<p>${REASONS[r] || r}</p>`)}</div></div>
      <a class="btn btn-primary" href="${back[0]}">Back to patient</a>`, { back });
    return;
  }
  const activeDigital = cards.find((c) => c.kind === 'digital' && c.status === 'active');
  const activePhysical = cards.find((c) => c.kind === 'physical' && c.status === 'active');
  layout(html`
    <div class="page-head"><div><div class="eyebrow">Issue card · ${patientName(patient, 'bi')}</div><h1>How should the patient receive the card?</h1>
      <p>Both formats use the same verified record (${readiness.includedCount} entr${readiness.includedCount === 1 ? 'y' : 'ies'}).</p></div></div>
    <div class="issue-options">
      <a class="issue-option physical" href="#/allergy/p/${pid}/issue/physical">
        <div class="issue-art"><div class="mini-card"><i></i><i></i><i></i></div></div>
        <h2>${icon('printer')} Print Drug Allergy Card <small>บัตรแพ้ยาแบบพิมพ์</small></h2>
        <ul><li>ID-1 card (85.60 × 53.98 mm) or A4 sheet</li><li>Front / back · Thai, English or bilingual</li><li>Print preview, print and export PDF</li></ul>
        ${activePhysical ? html`<span class="pill pill-warn">Issuing replaces printed card ${activePhysical.serial}</span>` : ''}
        <span class="go">Option 1 · Physical card →</span>
      </a>
      <a class="issue-option digital" href="#/allergy/p/${pid}/issue/digital">
        <div class="issue-art"><div class="mini-phone"><div></div></div></div>
        <h2>${icon('phone')} Digital Drug Allergy Card <small>บัตรแพ้ยาดิจิทัล</small></h2>
        <ul><li>Patient scans a secure, short-lived QR</li><li>Identity check on the patient's own phone</li><li>Apple Wallet · Google Wallet · Web card · PDF</li></ul>
        ${activeDigital ? html`<span class="pill pill-brand">Active digital card ${activeDigital.serial}${activeDigital.outdated ? ' · update pending' : ''}</span>` : ''}
        <span class="go">Option 2 · Digital card →</span>
      </a>
    </div>`, { back });
}

// ------------------------------------------------------------------ option 1: physical
function previewMarkup(snap, qrSvg, format, lang) {
  if (format === 'a4') return html`<div class="preview-wrap"><div class="a4-preview">${renderA4(snap, qrSvg, lang)}</div></div>`;
  return html`<div class="preview-wrap"><div class="card-flip">
    <div><p class="face-label">Front · ด้านหน้า</p><div class="card-stage">${renderFront(snap, lang)}</div></div>
    <div><p class="face-label">Back · ด้านหลัง</p><div class="card-stage">${renderBack(snap, qrSvg, lang)}</div></div>
  </div></div>`;
}

function physicalOptions({ format = 'id1', lang = 'bi' } = {}) {
  return html`
    <fieldset class="field"><legend>Format</legend><div class="segmented">
      <label><input type="radio" name="format" value="id1" ${format === 'id1' ? 'checked' : ''}><span>ID-1 card<br><small>85.60 × 53.98 mm</small></span></label>
      <label><input type="radio" name="format" value="a4" ${format === 'a4' ? 'checked' : ''}><span>A4 sheet<br><small>cut & fold + summary</small></span></label>
    </div></fieldset>
    <fieldset class="field"><legend>Language</legend><div class="segmented">
      <label><input type="radio" name="lang" value="th" ${lang === 'th' ? 'checked' : ''}><span>ไทย</span></label>
      <label><input type="radio" name="lang" value="en" ${lang === 'en' ? 'checked' : ''}><span>English</span></label>
      <label><input type="radio" name="lang" value="bi" ${lang === 'bi' ? 'checked' : ''}><span>ไทย + EN</span></label>
    </div></fieldset>
    <p class="fine" id="printer-hint"></p>`;
}

const PRINTER_HINT = {
  id1: 'Card printers (CR80): choose the 85.6 × 54 mm / CR80 media, enable duplex (page 1 front, page 2 back), scale 100%, backgrounds on. Full-bleed red band.',
  a4: 'Standard printers: A4, scale 100% / Actual size, backgrounds on. Cut along the dashed line, fold in the middle and laminate.',
};

async function physicalView({ pid }) {
  const back = [`#/allergy/p/${pid}/issue`, 'Issue card'];
  const { snapshot, readiness } = await api.get(`/api/patients/${pid}/card-preview?lang=bi`);
  if (!readiness.ready) return issueView({ pid });
  const main = layout(html`
    <div class="page-head"><div><div class="eyebrow">Option 1 · Physical card</div><h1>Print Drug Allergy Card</h1>
      <p>Choose format and language, check the print preview, then issue the card.</p></div></div>
    <div class="grid grid-2">
      <form class="panel stack" id="opts">
        ${physicalOptions()}
        <label class="check"><input type="checkbox" name="consent">
          <span><strong>Patient consents to receive a card that shows their health information.</strong>
          <small>ผู้ป่วยยินยอมรับบัตรที่แสดงข้อมูลสุขภาพของตน (PDPA)</small></span></label>
        <div class="notice notice-info">${icon('shield')}<p class="fine">The QR on the card opens a verification page that shows card status only — no health data. Issuing replaces any previous printed card.</p></div>
        <button class="btn btn-primary btn-block" id="issue">${icon('check')} Issue card</button>
      </form>
      <section class="stack">
        <div class="panel-head"><h2>Print preview</h2><span class="pill pill-warn">Preview — not valid</span></div>
        <div id="preview"></div>
      </section>
    </div>`, { back });
  const form = $('#opts', main);
  const current = () => ({ format: form.querySelector('[name=format]:checked').value, lang: form.querySelector('[name=lang]:checked').value });
  const render = () => {
    const { format, lang } = current();
    mount($('#preview', main), previewMarkup(snapshot, null, format, lang));
    $('#printer-hint', main).textContent = PRINTER_HINT[format];
  };
  form.addEventListener('change', render);
  render();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.consent.checked) return toast("Record the patient's consent first.", 'bad');
    const { format, lang } = current();
    try {
      const { card } = await api.post(`/api/patients/${pid}/cards/physical`, { format, language: lang, consent: true });
      toast(`Card ${card.serial} issued`, 'ok');
      location.hash = `#/allergy/c/${card.id}?print=1`;
    } catch (err) { toast(err.message, 'bad'); }
  });
}

// ------------------------------------------------------------------ option 2: digital
async function digitalView({ pid }) {
  const back = [`#/allergy/p/${pid}/issue`, 'Issue card'];
  const { patient, cards, readiness } = await api.get(`/api/patients/${pid}`);
  if (!readiness.ready) return issueView({ pid });
  const active = cards.find((c) => c.kind === 'digital' && c.status === 'active');
  const main = layout(html`
    <div class="page-head"><div><div class="eyebrow">Option 2 · Digital card</div><h1>Digital Drug Allergy Card</h1>
      <p>${patientName(patient, 'bi')} scans the QR with their own phone, verifies their identity and chooses Apple Wallet, Google Wallet, the web card or a PDF.</p></div></div>
    ${active ? html`<div class="notice ${active.outdated ? 'notice-warn' : 'notice-ok'}">${icon(active.outdated ? 'alert' : 'check')}<div>
      <p>Active digital card <strong>${active.serial}</strong> (v${active.version}). ${active.outdated ? 'Records changed since it was last updated — completing a new claim, or pushing an update, will refresh it everywhere.' : 'A new claim adds this card to another device.'}</p>
      <a href="#/allergy/c/${active.id}">Manage digital card →</a></div></div>` : ''}
    <div class="grid grid-2">
      <section class="panel stack">
        <h2>How it works</h2>
        <ol class="timeline" id="timeline">
          <li data-step="created"><span class="dot">1</span>Generate a single-use QR (valid ${appConfig.claimTtlMinutes} min)</li>
          <li data-step="scanned"><span class="dot">2</span>Patient scans and confirms date of birth + last 4 digits of ID</li>
          <li data-step="verified"><span class="dot">3</span>Patient reads and gives PDPA consent on their phone</li>
          <li data-step="completed"><span class="dot">4</span>Card saved — Wallet / web card / PDF</li>
        </ol>
        <div class="notice notice-info">${icon('shield')}<p class="fine">The QR contains no health data. The link is single-use, expires quickly, locks after ${appConfig.claimMaxAttempts} wrong attempts and only works after identity verification.</p></div>
      </section>
      <section class="panel qr-stage" id="qr-panel">
        <div class="qr-frame is-dim">${raw('<svg viewBox="0 0 10 10"></svg>')}</div>
        <button class="btn btn-primary" id="gen">${icon('qr')} Generate secure QR</button>
      </section>
    </div>`, { back });

  let timer = null;
  let poll = null;
  const stop = () => { clearInterval(timer); clearInterval(poll); };
  window.addEventListener('hashchange', stop, { once: true });

  const setStep = (status) => {
    const order = ['created', 'scanned', 'verified', 'completed'];
    const idx = { pending: 1, verified: 3, completed: 4 }[status] ?? 0;
    $$('#timeline li', main).forEach((li, i) => {
      li.classList.toggle('done', i < idx);
      li.classList.toggle('now', i === idx && idx < 4);
      li.dataset.state = order[i];
    });
  };

  async function generate() {
    stop();
    const { claim } = await api.post(`/api/patients/${pid}/claims`);
    const panel = $('#qr-panel', main);
    mount(panel, html`
      <div class="qr-frame">${raw(claim.qrSvg)}</div>
      <div class="countdown" id="cd" aria-live="polite"></div>
      <div class="progress"><i id="bar"></i></div>
      <p class="fine">Ask the patient to scan with their phone camera. Do not photograph or share this code.</p>
      <div class="row"><button class="btn btn-secondary btn-sm" id="regen">${icon('refresh')} New QR</button><button class="btn btn-ghost btn-sm" id="cancel">Cancel</button></div>`);
    setStep('pending');
    const total = new Date(claim.expiresAt) - Date.now();
    const tick = () => {
      const left = Math.max(0, new Date(claim.expiresAt) - Date.now());
      $('#cd', panel).textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
      $('#bar', panel).style.width = `${(left / total) * 100}%`;
    };
    tick();
    timer = setInterval(tick, 1000);
    poll = setInterval(async () => {
      try {
        const { claim: s } = await api.get(`/api/claims/${claim.id}`);
        if (s.status === 'verified') { setStep('verified'); $('.qr-frame', panel).classList.add('is-dim'); }
        if (s.status === 'completed') {
          stop();
          setStep('completed');
          mount(panel, html`<div class="verify-icon">✓</div><h2>Digital card saved</h2><p class="muted">The patient has their card. You can manage updates and revocation from the card page.</p>
            <a class="btn btn-primary" href="#/allergy/c/${s.cardId}">Open digital card</a>`);
        }
        if (['expired', 'locked', 'cancelled'].includes(s.status)) {
          stop();
          setStep('none');
          mount(panel, html`<div class="notice notice-warn">${icon('alert')}<p>${s.status === 'locked' ? 'Locked after too many failed identity checks.' : s.status === 'expired' ? 'The QR expired.' : 'Cancelled.'}</p></div>
            <button class="btn btn-primary" id="gen2">${icon('qr')} Generate new QR</button>`);
          $('#gen2', panel).addEventListener('click', () => generate().catch((e) => toast(e.message, 'bad')));
        }
      } catch { /* transient */ }
    }, 3000);
    $('#regen', panel).addEventListener('click', () => generate().catch((e) => toast(e.message, 'bad')));
    $('#cancel', panel).addEventListener('click', async () => {
      stop();
      await api.post(`/api/claims/${claim.id}/cancel`).catch(() => {});
      location.hash = `#/allergy/p/${pid}`;
    });
  }
  $('#gen', main).addEventListener('click', () => generate().catch((e) => toast(e.message, 'bad')));
}

// ------------------------------------------------------------------ card detail / management
async function cardView({ cid }, query) {
  const { card } = await api.get(`/api/cards/${cid}`);
  renderCardDetail(card, query.get('print') === '1');
}

function renderCardDetail(card, justIssued = false) {
  const snap = card.snapshot;
  const back = [`#/allergy/p/${card.patientId}`, 'Patient'];
  const physical = card.kind === 'physical';
  const active = card.status === 'active';
  const main = layout(html`
    <div class="page-head">
      <div><div class="eyebrow">${physical ? 'Printed card' : 'Digital card'} · v${card.version}</div><h1>${card.serial}</h1>
        <p>Issued ${relTime(card.issuedAt)}${card.updatedAt !== card.issuedAt ? ` · updated ${relTime(card.updatedAt)}` : ''}</p></div>
      ${pillForCard(card)}
    </div>
    ${card.status === 'revoked' ? html`<div class="notice notice-bad">${icon('ban')}<p>Revoked ${relTime(card.revokedAt)}${card.revokeReason ? ` — ${card.revokeReason}` : ''}. The QR now reports this card as revoked${physical ? '' : ' and Wallet passes have been voided'}.</p></div>` : ''}
    ${card.status === 'superseded' ? html`<div class="notice">${icon('alert')}<p>A newer printed card replaced this one. Its QR reports "newer card issued".</p></div>` : ''}
    ${active && card.outdated ? html`<div class="notice notice-warn">${icon('alert')}<div><p>The patient's allergy records changed after this card was issued.</p>
      ${physical ? html`<p>Printed cards cannot change. <a href="#/allergy/p/${card.patientId}/issue/physical">Issue a new printed card</a> (this one will be superseded).</p>`
        : card.patientReady ? html`<button class="btn btn-primary btn-sm" id="refresh">${icon('refresh')} Push update to web card & Wallet</button>`
          : html`<p>Verify the pending records first, then push the update.</p>`}</div></div>` : ''}

    ${snap ? html`<div class="grid grid-2">
      <section class="stack">
        ${physical ? html`<form class="panel stack" id="print-opts">${physicalOptions({ format: card.format || 'id1', lang: card.language })}
          <div class="row">
            <button class="btn btn-primary" type="button" id="print" ${active ? '' : 'disabled'}>${icon('printer')} Print</button>
            <button class="btn btn-secondary" type="button" id="pdf" ${active ? '' : 'disabled'}>${icon('pdf')} Export PDF</button>
          </div>
        </form>` : html`<section class="panel">
          <h2>Patient devices</h2>
          <p class="muted">${card.holders.filter((h) => !h.revoked_at).length} active web-card device(s) · ${card.walletPasses.filter((w) => w.status === 'active').length} active Wallet pass(es)</p>
          ${card.walletPasses.length ? html`<ul class="list">${card.walletPasses.map((w) => html`<li class="list-item">${icon('wallet')}<span class="grow">
            <span class="title">${w.platform === 'apple' ? 'Apple Wallet' : 'Google Wallet'}${w.discreet ? ' · discreet' : ''}</span>
            <span class="sub">Confirmed by patient ${relTime(w.confirmed_at)} · updated ${relTime(w.updated_at)}</span></span>
            <span class="pill ${w.status === 'active' ? 'pill-ok' : 'pill-bad'}">${w.status}</span></li>`)}</ul>` : ''}
        </section>`}
        <section class="panel"><h2>Entries</h2>${renderSummary(snap, card.language)}</section>
      </section>
      <section class="stack"><div class="panel-head"><h2>${physical ? 'Print preview' : 'Card'}</h2></div><div id="preview"></div></section>
    </div>` : html`<div class="notice">${icon('alert')}<p>Card content has been deleted (consent withdrawn or data erased).</p></div>`}

    ${active ? html`<section class="panel mt">
      <div class="panel-head"><h2>Revoke</h2></div>
      <p class="fine">Revoking marks the QR as revoked${physical ? '' : ', disables the web card on all devices and voids Wallet passes'}. Use when the card is lost or its information is wrong.</p>
      <button class="btn btn-ghost" id="revoke">${icon('ban')} Revoke card…</button>
    </section>` : ''}`, { back });

  if (snap) {
    const form = $('#print-opts', main);
    const current = () => (form ? { format: form.querySelector('[name=format]:checked').value, lang: form.querySelector('[name=lang]:checked').value } : { format: 'id1', lang: card.language });
    const render = () => {
      const { format, lang } = current();
      mount($('#preview', main), previewMarkup(snap, card.qrSvg, format, lang));
      if ($('#printer-hint', main)) $('#printer-hint', main).textContent = PRINTER_HINT[format];
    };
    form?.addEventListener('change', render);
    render();
    $('#print', main)?.addEventListener('click', () => {
      const { format, lang } = current();
      api.post(`/api/cards/${card.id}/events`, { type: 'print', format }).catch(() => {});
      printCard(snap, card.qrSvg, { format, lang });
    });
    $('#pdf', main)?.addEventListener('click', async () => {
      try {
        const res = await api.get(`/api/cards/${card.id}/pdf?format=${current().format}`, { raw: true });
        await downloadBlob(res, `allergy-card-${card.serial}.pdf`);
      } catch (err) { toast(err.message, 'bad'); }
    });
    if (justIssued && physical) toast('Card issued — check the preview, then Print or Export PDF.', 'ok');
  }
  $('#refresh', main)?.addEventListener('click', async () => {
    try {
      const res = await api.post(`/api/cards/${card.id}/refresh`);
      toast(`Updated to v${res.card.version}`, 'ok');
      renderCardDetail(res.card);
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('#revoke', main)?.addEventListener('click', async () => {
    const res = await dialog({
      title: `Revoke ${card.serial}?`,
      body: html`<label class="field"><span>Reason</span><select name="reason">
          <option value="lost_or_stolen">Lost or stolen</option><option value="incorrect_information">Incorrect information</option>
          <option value="patient_request">Patient request</option><option value="replaced">Replaced</option></select></label>
        <label class="field"><span>Confirm with your password</span><input type="password" name="password" autocomplete="current-password"></label>`,
      actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Revoke card', value: 'revoke', tone: 'danger' }],
      validate: (f) => (f.password.value ? null : 'Password is required.'),
    });
    if (!res) return;
    try {
      const out = await api.post(`/api/cards/${card.id}/revoke`, res.form);
      toast('Card revoked', 'ok');
      renderCardDetail(out.card);
    } catch (err) { toast(err.message, 'bad'); }
  });
}

// ------------------------------------------------------------------ QR verification (signed-in pharmacist)
async function verifyCardView({ cid }, query) {
  const { card } = await api.get(`/api/verify/${cid}?s=${encodeURIComponent(query.get('s') || '')}`);
  const tone = card.status === 'active' ? (card.outdated ? 'warn' : 'ok') : 'bad';
  layout(html`
    <div class="notice notice-${tone}">${icon(tone === 'ok' ? 'check' : 'alert')}<div>
      <strong>${card.status === 'active' ? 'Authentic and active card' : card.status === 'superseded' ? 'Superseded — a newer card exists' : 'Revoked card'}</strong>
      ${card.outdated ? html`<p>Records were updated after this card was issued — check the current record.</p>` : ''}
    </div></div>
    ${card.snapshot ? html`<div class="card-stage">${renderFront(card.snapshot)}</div><section class="panel mt">${renderSummary(card.snapshot)}</section>
      <a class="btn btn-secondary" href="#/allergy/p/${card.patientId}">Open patient record</a>` : ''}`, { back: ['#/', 'Home'] });
}

// ------------------------------------------------------------------ admin
async function auditView() {
  const { entries, chain } = await api.get('/api/admin/audit');
  const main = layout(html`
    <div class="page-head"><div><div class="eyebrow">Administration</div><h1>Audit log & retention</h1>
      <p>Hash-chained audit trail. Entries contain identifiers and codes only — no names, IDs or clinical text.</p></div></div>
    <div class="notice ${chain.ok ? 'notice-ok' : 'notice-bad'}">${icon(chain.ok ? 'check' : 'alert')}<p>${chain.ok ? `Integrity verified across ${chain.count} entries.` : `Integrity check FAILED at entry #${chain.brokenAt}.`}</p></div>
    <section class="panel"><div class="panel-head"><h2>Data retention (PDPA)</h2><button class="btn btn-secondary btn-sm" id="ret">${icon('refresh')} Run retention now</button></div>
      <p class="fine">Runs hourly: expires claim links, purges stale tokens and sessions, retires idle web-card devices and erases patients past their retention date (${appConfig.retentionDays} days).</p>
      <pre class="mono" id="ret-out" hidden></pre></section>
    <section class="panel"><h2>Latest events</h2>${auditTable(entries)}</section>`, { back: ['#/', 'Home'] });
  $('#ret', main).addEventListener('click', async () => {
    const { result } = await api.post('/api/admin/retention/run');
    const out = $('#ret-out', main);
    out.textContent = JSON.stringify(result, null, 2);
    out.hidden = false;
  });
}

// ------------------------------------------------------------------ boot
const router = createRouter([
  ['/login', view(loginView, { auth: false })],
  ['/', view(homeView)],
  ['/naranjo', view(naranjoView)],
  ['/allergy', view(patientsView)],
  ['/allergy/new', view(patientFormView)],
  ['/allergy/p/:pid', view(patientView)],
  ['/allergy/p/:pid/edit', view(patientFormView)],
  ['/allergy/p/:pid/record/new', view(recordFormView)],
  ['/allergy/r/:rid/edit', view(recordFormView)],
  ['/allergy/r/:rid/verify', view(verifyRecordView)],
  ['/allergy/p/:pid/issue', view(issueView)],
  ['/allergy/p/:pid/issue/physical', view(physicalView)],
  ['/allergy/p/:pid/issue/digital', view(digitalView)],
  ['/allergy/c/:cid', view(cardView)],
  ['/verify/:cid', view(verifyCardView)],
  ['/admin/audit', view(auditView)],
], { onNotFound: () => { location.hash = '#/'; } });

router.resolve();
registerServiceWorker();
