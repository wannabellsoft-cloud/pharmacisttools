// Renders a card snapshot as HTML. Used by print preview, printing, the
// pharmacist card view and the patient's Digital Web Card, so every format
// shows identical content. Mirrors server/services/pdf.js.
import { html, raw } from './core.js';
import { CONFIRMATION_BASIS, NARANJO_CATEGORIES, label } from '/shared/clinical.js';
import {
  ct, certaintyText, formatDate, manifestationsText, patientName, severityText, statusText, typeText, FRONT_MAX_DRUGS,
} from '/shared/cardText.js';

const short = (lang) => (lang === 'bi' ? 'en' : lang);

function badge(certainty, lang) {
  return html`<span class="cf-badge cf-badge-${certainty}">${certaintyText(certainty, short(lang)).toUpperCase()}</span>`;
}

function watermark(snap) {
  return snap.preview ? html`<div class="cf-watermark" aria-hidden="true">${ct('preview', 'bi')}</div>` : '';
}

export function renderFront(snap, lang = snap.language || 'bi') {
  const sl = short(lang);
  const shown = snap.entries.slice(0, FRONT_MAX_DRUGS);
  const more = snap.entries.length - shown.length;
  return html`<article class="card-face cf-front" aria-label="${ct('title', 'bi')} — front">
    <header class="cf-band">
      <span class="cf-alert" aria-hidden="true">!</span>
      <div class="cf-title">
        ${lang === 'en' ? html`<strong>${ct('title', 'en')}</strong>` : html`<strong>${ct('title', 'th')}</strong>`}
        ${lang === 'bi' ? html`<small>${ct('title', 'en')}</small>` : ''}
      </div>
      <div class="cf-facility">
        <span>${lang === 'en' ? snap.facility.nameEn : snap.facility.nameTh}</span>
        ${lang === 'bi' ? html`<small>${snap.facility.nameEn}</small>` : ''}
      </div>
    </header>
    <section class="cf-patient">
      <span class="cf-label">${ct('name', lang)}</span>
      <div class="cf-name">${patientName(snap.patient, lang)}</div>
      <div class="cf-ids">
        <span>${ct('hn', sl)} ${snap.patient.hn}</span>
        <span>${ct('dob', sl)} ${formatDate(snap.patient.dob, sl)}</span>
        <span>${ct('idNo', sl)} ${snap.patient.idMasked}</span>
      </div>
    </section>
    <section class="cf-drugs ${shown.length >= 3 ? 'is-compact' : ''}">
      <span class="cf-label">${ct('drug', lang)}</span>
      <ul>
        ${shown.map((e) => html`<li>
          <span class="cf-drug">${`${e.drugGeneric}${e.drugBrand ? ` (${e.drugBrand})` : ''}`.toUpperCase()}</span>
          <span class="cf-type">${typeText(e.reactionType, lang)}</span>
          ${badge(e.certainty, lang)}
        </li>`)}
      </ul>
      ${more > 0 ? html`<p class="cf-more">${ct('more', sl, { n: more })}</p>` : ''}
    </section>
    <footer class="cf-foot">${ct('subtitle', lang)}</footer>
    ${watermark(snap)}
  </article>`;
}

export function renderBack(snap, qrSvg, lang = snap.language || 'bi') {
  const sl = short(lang);
  const shown = snap.entries.slice(0, FRONT_MAX_DRUGS);
  const more = snap.entries.length - shown.length;
  const v = snap.verifiedBy;
  return html`<article class="card-face cf-back" aria-label="${ct('title', 'bi')} — back">
    <div class="cf-topline"></div>
    <div class="cf-back-grid">
      <div class="cf-entries ${shown.length >= 3 ? 'is-compact' : ''}">
        ${shown.map((e) => html`<div class="cf-entry">
          <div class="cf-entry-title">${e.drugGeneric} · ${typeText(e.reactionType, lang)} · ${certaintyText(e.certainty, sl)}</div>
          <div class="cf-entry-line">${ct('reaction', sl)}: ${manifestationsText(e.manifestations, lang)}${e.reactionNote ? ` — ${e.reactionNote}` : ''}</div>
          <div class="cf-entry-meta">${ct('severity', sl)}: ${severityText(e.severity, sl)} · ${ct('status', sl)}: ${statusText(e.clinicalStatus, sl)} · ${ct('assessed', sl)} ${formatDate(e.assessmentDate, sl)}</div>
        </div>`)}
        ${more > 0 ? html`<p class="cf-more">${ct('moreBack', sl, { n: more })}</p>` : ''}
      </div>
      <div class="cf-qr">
        <div class="cf-qr-box ${qrSvg ? '' : 'is-placeholder'}">${qrSvg ? raw(qrSvg) : 'QR'}</div>
        <div class="cf-serial">${snap.serial}</div>
        <div class="cf-scan">${ct('scan', sl)}</div>
      </div>
    </div>
    <footer class="cf-verify">
      <div class="cf-verify-by">${ct('verifiedBy', sl)}: ${v ? `${v.name} (${ct('license', sl)} ${v.licenseNo})` : '-'}</div>
      <div>${ct('assessed', sl)} ${formatDate(snap.assessmentDate, sl)} · ${ct('issued', sl)} ${formatDate(snap.issuedAt, sl)}</div>
      <div>${ct('emergency', sl)} ${lang === 'en' ? snap.facility.nameEn : snap.facility.nameTh} ${snap.facility.phone}</div>
    </footer>
    ${watermark(snap)}
  </article>`;
}

/** Full detail list (A4 summary, pharmacist view and web card details). */
export function renderSummary(snap, lang = snap.language || 'bi') {
  const sl = short(lang);
  return html`<ol class="summary-list">
    ${snap.entries.map((e) => html`<li class="summary-item summary-${e.certainty}">
      <div class="summary-head">
        <strong>${e.drugGeneric}${e.drugBrand ? ` (${e.drugBrand})` : ''}</strong>
        ${e.drugClass ? html`<span class="muted"> — ${e.drugClass}</span>` : ''}
        ${badge(e.certainty, lang)}
      </div>
      <dl class="summary-kv">
        <dt>${ct('status', lang)}</dt><dd>${typeText(e.reactionType, 'bi')} · ${certaintyText(e.certainty, 'bi')} · ${statusText(e.clinicalStatus, lang)}</dd>
        <dt>${ct('reaction', lang)}</dt><dd>${manifestationsText(e.manifestations, sl)}${e.reactionNote ? ` — ${e.reactionNote}` : ''}</dd>
        <dt>${ct('severity', lang)}</dt><dd>${severityText(e.severity, lang)}</dd>
        <dt>${ct('assessed', lang)}</dt><dd>${formatDate(e.assessmentDate, sl)}</dd>
        ${e.certainty === 'confirmed' && e.confirmationBasis?.length ? html`<dt>Basis</dt><dd>${e.confirmationBasis.map((b) => label(CONFIRMATION_BASIS, b, sl)).join(', ')}</dd>` : ''}
        ${e.naranjoScore !== null && e.naranjoScore !== undefined ? html`<dt>${ct('naranjo', 'en')}</dt><dd>${e.naranjoScore} (${label(NARANJO_CATEGORIES, e.naranjoCategory, 'en')}) <span class="muted">— ${ct('naranjoNote', sl)}</span></dd>` : ''}
        ${e.verifiedBy ? html`<dt>${ct('verifiedBy', lang)}</dt><dd>${e.verifiedBy.name} (${ct('license', sl)} ${e.verifiedBy.licenseNo}) · ${formatDate(e.verifiedAt, sl)}</dd>` : ''}
      </dl>
    </li>`)}
  </ol>`;
}

/** A4 sheet: front + back side by side (cut and fold), then the full summary. */
export function renderA4(snap, qrSvg, lang = snap.language || 'bi') {
  return html`<section class="a4-sheet">
    <header class="a4-head">
      <h1>${ct('title', 'th')} / ${ct('title', 'en')}</h1>
      <p>${ct('cutLine', 'th')} · ${ct('cutLine', 'en')} · Print at 100% / Actual size</p>
    </header>
    <div class="fold-pair">
      <div class="fold-cell">${renderFront(snap, lang)}</div>
      <div class="fold-cell">${renderBack(snap, qrSvg, lang)}</div>
    </div>
    <h2>${ct('summaryTitle', lang === 'en' ? 'en' : 'th')}</h2>
    <p class="muted">${patientName(snap.patient, 'bi')} · HN ${snap.patient.hn} · ${ct('idNo', 'en')} ${snap.patient.idMasked}</p>
    ${renderSummary(snap, lang)}
    <p class="a4-foot">${ct('serial', 'en')} ${snap.serial} · ${snap.facility.nameEn} ${snap.facility.phone}<br>
    เอกสารนี้มีข้อมูลสุขภาพซึ่งเป็นข้อมูลส่วนบุคคลอ่อนไหว (PDPA) โปรดเก็บรักษาอย่างปลอดภัย · Contains sensitive personal health data. Keep secure.</p>
  </section>`;
}

/** Builds the printable DOM for a format and opens the browser print dialog. */
export function printCard(snap, qrSvg, { format, lang }) {
  const root = document.getElementById('print-root');
  const link = document.getElementById('print-css');
  link.href = format === 'a4' ? '/css/print-a4.css' : '/css/print-id1.css';
  root.className = `print-${format}`;
  root.innerHTML = String(format === 'a4'
    ? renderA4(snap, qrSvg, lang)
    : html`<div class="print-page">${renderFront(snap, lang)}</div><div class="print-page">${renderBack(snap, qrSvg, lang)}</div>`);
  const cleanup = () => {
    root.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // Give the stylesheet a moment to apply before opening the dialog.
  const go = () => setTimeout(() => window.print(), 50);
  if (link.sheet && link.dataset.loaded === link.href) go();
  else link.addEventListener('load', () => { link.dataset.loaded = link.href; go(); }, { once: true });
}
