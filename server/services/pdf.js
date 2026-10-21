import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { NARANJO_CATEGORIES, CONFIRMATION_BASIS, label } from '../../shared/clinical.js';
import {
  ct, certaintyText, formatDate, manifestationsText, patientName, severityText, statusText, typeText, FRONT_MAX_DRUGS,
} from '../../shared/cardText.js';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const MM = 72 / 25.4;
// ISO/IEC 7810 ID-1
export const CARD_W = 85.6 * MM;
export const CARD_H = 53.98 * MM;
const SAFE = 3 * MM;

const C = {
  red: '#b01c2e', redDark: '#8a1324', redSoft: '#fdecee', amber: '#a15c00', amberSoft: '#fff4e0',
  ink: '#111827', muted: '#4b5563', line: '#d1d5db', paper: '#ffffff',
};

function registerFonts(doc) {
  doc.registerFont('R', path.join(FONT_DIR, 'Sarabun_400Regular.ttf'));
  doc.registerFont('S', path.join(FONT_DIR, 'Sarabun_600SemiBold.ttf'));
  doc.registerFont('B', path.join(FONT_DIR, 'Sarabun_700Bold.ttf'));
}

/** Draws single-line text shrunk to fit `width` (down to minSize), then ellipsized. */
function fitText(doc, text, x, y, width, { font = 'R', size = 8, minSize = 5, color = C.ink, align = 'left' } = {}) {
  let s = size;
  doc.font(font);
  while (s > minSize && doc.fontSize(s).widthOfString(text) > width) s -= 0.25;
  doc.fillColor(color).fontSize(s).text(text, x, y, { width, align, lineBreak: false, ellipsis: true, height: s * 1.4 });
  return s;
}

function drawQr(doc, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  doc.save().rect(x - cell, y - cell, size + 2 * cell, size + 2 * cell).fill(C.paper);
  doc.fillColor('#000000');
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) doc.rect(x + c * cell, y + r * cell, cell + 0.01, cell + 0.01);
    }
  }
  doc.fill().restore();
}

function warningIcon(doc, x, y, s) {
  doc.save().moveTo(x + s / 2, y).lineTo(x + s, y + s * 0.88).lineTo(x, y + s * 0.88).closePath().fill(C.paper);
  doc.fillColor(C.red).font('B').fontSize(s * 0.7).text('!', x, y + s * 0.14, { width: s, align: 'center', lineBreak: false });
  doc.restore();
}

function certaintyBadge(doc, certainty, lang, xRight, y) {
  const text = certaintyText(certainty, lang === 'bi' ? 'en' : lang).toUpperCase();
  doc.font('B').fontSize(5.6);
  const w = doc.widthOfString(text) + 6;
  const x = xRight - w;
  if (certainty === 'confirmed') {
    doc.roundedRect(x, y, w, 9, 4.5).fill(C.red);
    doc.fillColor(C.paper);
  } else {
    doc.roundedRect(x, y, w, 9, 4.5).fillAndStroke(C.amberSoft, C.amber);
    doc.fillColor(C.amber);
  }
  doc.text(text, x, y + 1.2, { width: w, align: 'center', lineBreak: false });
  return w;
}

function watermark(doc, x, y, w, h, text) {
  doc.save();
  doc.rotate(-18, { origin: [x + w / 2, y + h / 2] });
  doc.font('B').fontSize(14).fillColor(C.red).fillOpacity(0.18).text(text, x - 20, y + h / 2 - 9, { width: w + 40, align: 'center', lineBreak: false });
  doc.restore();
  doc.fillOpacity(1);
}

/** Front of the card, origin at (x, y). */
export function drawFront(doc, snap, lang, x, y) {
  const W = CARD_W;
  const H = CARD_H;
  const shortLang = lang === 'bi' ? 'en' : lang;
  doc.save().rect(x, y, W, H).clip();
  doc.rect(x, y, W, H).fill(C.paper);

  // Header band (full bleed for card printers)
  const bandH = 15 * MM * 0.78;
  doc.rect(x, y, W, bandH).fill(C.red);
  warningIcon(doc, x + SAFE, y + 3.2 * MM * 0.8, 6.5 * MM * 0.8);
  const tx = x + SAFE + 7 * MM;
  if (lang === 'en') {
    fitText(doc, ct('title', 'en'), tx, y + 9.5, W * 0.5, { font: 'B', size: 11, color: C.paper });
  } else {
    fitText(doc, ct('title', 'th'), tx, y + 2.5, W * 0.45, { font: 'B', size: 12.5, color: C.paper });
    if (lang === 'bi') fitText(doc, ct('title', 'en'), tx, y + 20, W * 0.45, { font: 'S', size: 6.4, color: '#ffe4e6' });
  }
  const facility = lang === 'en' ? snap.facility.nameEn : snap.facility.nameTh;
  fitText(doc, facility, x + W * 0.52, y + 8, W * 0.48 - SAFE, { font: 'S', size: 6.4, minSize: 4.5, color: C.paper, align: 'right' });
  if (lang === 'bi') fitText(doc, snap.facility.nameEn, x + W * 0.52, y + 17, W * 0.48 - SAFE, { size: 5, minSize: 4, color: '#ffe4e6', align: 'right' });

  // Patient identification
  let cy = y + bandH + 3.5;
  const inner = W - 2 * SAFE;
  fitText(doc, ct('name', lang), x + SAFE, cy, inner, { size: 4.8, color: C.muted });
  cy += 6.2;
  fitText(doc, patientName(snap.patient, lang === 'bi' ? 'bi' : lang), x + SAFE, cy, inner, { font: 'B', size: 9, minSize: 6 });
  cy += 12;
  const ids = [
    `${ct('hn', shortLang)} ${snap.patient.hn}`,
    `${ct('dob', shortLang)} ${formatDate(snap.patient.dob, shortLang)}`,
    `${ct('idNo', shortLang)} ${snap.patient.idMasked}`,
  ].join('   ');
  fitText(doc, ids, x + SAFE, cy, inner, { font: 'S', size: 6, minSize: 4.5, color: C.muted });
  cy += 9;
  doc.moveTo(x + SAFE, cy).lineTo(x + W - SAFE, cy).lineWidth(0.6).stroke(C.line);
  cy += 3;

  // Drugs
  fitText(doc, ct('drug', lang), x + SAFE, cy, inner, { size: 4.8, color: C.muted });
  cy += 6.5;
  const shown = snap.entries.slice(0, FRONT_MAX_DRUGS);
  const rowH = shown.length >= 3 ? 11.6 : 14;
  for (const e of shown) {
    const badgeW = certaintyBadge(doc, e.certainty, lang, x + W - SAFE, cy + 1.2);
    const name = `${e.drugGeneric}${e.drugBrand ? ` (${e.drugBrand})` : ''}`.toUpperCase();
    const type = typeText(e.reactionType, lang);
    doc.font('R').fontSize(5);
    const typeW = doc.widthOfString(type) + 4;
    const nameMax = inner - badgeW - typeW - 4;
    const used = fitText(doc, name, x + SAFE, cy - 0.5, nameMax, { font: 'B', size: 9.5, minSize: 6.5, color: C.redDark });
    doc.font('B').fontSize(used);
    const nameW = Math.min(doc.widthOfString(name), nameMax);
    fitText(doc, type, x + SAFE + nameW + 3, cy + 2, typeW, { size: 5, color: C.muted });
    cy += rowH;
  }
  if (snap.entries.length > FRONT_MAX_DRUGS) {
    fitText(doc, ct('more', shortLang, { n: snap.entries.length - FRONT_MAX_DRUGS }), x + SAFE, cy - 1, inner, { font: 'S', size: 5.2, color: C.red });
  }

  // Footer
  const fh = 9.5;
  doc.rect(x, y + H - fh, W, fh).fill(C.redSoft);
  fitText(doc, ct('subtitle', lang), x + SAFE, y + H - fh + 1.6, inner, { font: 'S', size: 5.4, minSize: 4, color: C.redDark, align: 'center' });

  if (snap.preview) watermark(doc, x, y, W, H, ct('preview', 'bi'));
  doc.restore();
}

/** Back of the card, origin at (x, y). */
export function drawBack(doc, snap, lang, x, y) {
  const W = CARD_W;
  const H = CARD_H;
  const shortLang = lang === 'bi' ? 'en' : lang;
  doc.save().rect(x, y, W, H).clip();
  doc.rect(x, y, W, H).fill(C.paper);
  doc.rect(x, y, W, 4).fill(C.red);

  const qrSize = 19 * MM;
  const qrX = x + W - SAFE - qrSize;
  const qrY = y + 4 + 2.5 * MM;
  const colW = W - 2 * SAFE - qrSize - 2.5 * MM;
  let cy = y + 7.5;

  const shown = snap.entries.slice(0, FRONT_MAX_DRUGS);
  const compact = shown.length >= 3;
  for (const e of shown) {
    fitText(doc, `${e.drugGeneric} · ${typeText(e.reactionType, lang)} · ${certaintyText(e.certainty, shortLang)}`, x + SAFE, cy, colW, { font: 'B', size: 6.2, minSize: 4.6, color: C.redDark });
    cy += 7.6;
    const reaction = `${ct('reaction', shortLang)}: ${manifestationsText(e.manifestations, lang)}${e.reactionNote ? ` — ${e.reactionNote}` : ''}`;
    fitText(doc, reaction, x + SAFE, cy, colW, { size: 5.2, minSize: 4.2 });
    cy += 6.6;
    fitText(doc, `${ct('severity', shortLang)}: ${severityText(e.severity, shortLang)} · ${ct('status', shortLang)}: ${statusText(e.clinicalStatus, shortLang)} · ${ct('assessed', shortLang)} ${formatDate(e.assessmentDate, shortLang)}`, x + SAFE, cy, colW, { size: 4.8, minSize: 4, color: C.muted });
    cy += compact ? 7.4 : 9;
  }
  if (snap.entries.length > FRONT_MAX_DRUGS) {
    fitText(doc, ct('moreBack', shortLang, { n: snap.entries.length - FRONT_MAX_DRUGS }), x + SAFE, cy, colW, { font: 'S', size: 4.8, color: C.red });
  }

  // QR + serial
  if (snap.preview) {
    doc.save().rect(qrX, qrY, qrSize, qrSize).dash(2, { space: 2 }).lineWidth(0.6).stroke(C.muted).undash().restore();
    fitText(doc, 'QR', qrX, qrY + qrSize / 2 - 6, qrSize, { font: 'B', size: 10, color: C.muted, align: 'center' });
  } else {
    drawQr(doc, snap.verifyUrl, qrX, qrY, qrSize);
  }
  fitText(doc, snap.serial, qrX - 4, qrY + qrSize + 2, qrSize + 8, { font: 'S', size: 4.8, minSize: 3.8, align: 'center' });
  doc.font('R').fontSize(3.9).fillColor(C.muted).text(ct('scan', shortLang), qrX - 4, qrY + qrSize + 8.5, { width: qrSize + 8, align: 'center', height: 12 });

  // Verification footer
  const fy = y + H - 20;
  doc.moveTo(x + SAFE, fy - 2).lineTo(x + SAFE + colW, fy - 2).lineWidth(0.5).stroke(C.line);
  const v = snap.verifiedBy;
  fitText(doc, `${ct('verifiedBy', shortLang)}: ${v ? `${v.name} (${ct('license', shortLang)} ${v.licenseNo})` : '-'}`, x + SAFE, fy, colW, { font: 'S', size: 5, minSize: 4 });
  fitText(doc, `${ct('assessed', shortLang)} ${formatDate(snap.assessmentDate, shortLang)} · ${ct('issued', shortLang)} ${formatDate(snap.issuedAt, shortLang)}`, x + SAFE, fy + 6.2, colW, { size: 4.6, minSize: 3.8, color: C.muted });
  fitText(doc, `${ct('emergency', shortLang)} ${lang === 'en' ? snap.facility.nameEn : snap.facility.nameTh} ${snap.facility.phone}`, x + SAFE, fy + 12, colW, { size: 4.6, minSize: 3.8, color: C.muted });

  if (snap.preview) watermark(doc, x, y, W, H, ct('preview', 'bi'));
  doc.restore();
}

function cropMarks(doc, x, y, w, h) {
  const m = 4 * MM;
  const g = 1 * MM;
  doc.save().lineWidth(0.3).strokeColor('#000000');
  for (const [cx, cy, dx, dy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]) {
    doc.moveTo(cx + dx * g, cy).lineTo(cx + dx * (g + m), cy).stroke();
    doc.moveTo(cx, cy + dy * g).lineTo(cx, cy + dy * (g + m)).stroke();
  }
  doc.restore();
}

function drawA4(doc, snap, lang) {
  const pageW = doc.page.width;
  const margin = 15 * MM;
  const shortLang = lang === 'bi' ? 'en' : lang;
  const totalW = CARD_W * 2;
  const x0 = (pageW - totalW) / 2;
  const y0 = margin + 40;

  doc.font('B').fontSize(13).fillColor(C.ink).text(ct('title', 'th') + ' / ' + ct('title', 'en'), margin, margin, { width: pageW - 2 * margin });
  doc.font('R').fontSize(7.5).fillColor(C.muted).text(`${ct('cutLine', 'th')} · ${ct('cutLine', 'en')} · 100% / Actual size`, margin, margin + 15, { width: pageW - 2 * margin });

  drawFront(doc, snap, lang, x0, y0);
  drawBack(doc, snap, lang, x0 + CARD_W, y0);
  doc.save().rect(x0, y0, totalW, CARD_H).dash(3, { space: 2 }).lineWidth(0.4).stroke('#6b7280').undash();
  doc.moveTo(x0 + CARD_W, y0 - 6).lineTo(x0 + CARD_W, y0 + CARD_H + 6).dash(1, { space: 2 }).lineWidth(0.4).stroke('#9ca3af').undash().restore();
  cropMarks(doc, x0, y0, totalW, CARD_H);

  // Detailed summary
  let y = y0 + CARD_H + 26;
  doc.font('B').fontSize(11).fillColor(C.ink).text(ct('summaryTitle', lang === 'en' ? 'en' : 'th'), margin, y);
  y += 16;
  doc.font('R').fontSize(8).fillColor(C.muted)
    .text(`${patientName(snap.patient, 'bi')} · HN ${snap.patient.hn} · ${ct('dob', shortLang)} ${formatDate(snap.patient.dob, shortLang)} · ${ct('idNo', shortLang)} ${snap.patient.idMasked}`, margin, y, { width: pageW - 2 * margin });
  y += 16;

  const width = pageW - 2 * margin;
  for (const [i, e] of snap.entries.entries()) {
    if (y > doc.page.height - 120) {
      doc.addPage();
      y = margin;
    }
    const top = y;
    doc.font('B').fontSize(10).fillColor(C.redDark)
      .text(`${i + 1}. ${e.drugGeneric}${e.drugBrand ? ` (${e.drugBrand})` : ''}${e.drugClass ? ` — ${e.drugClass}` : ''}`, margin + 8, y + 6, { width: width - 120 });
    certaintyBadge(doc, e.certainty, lang, margin + width - 8, y + 7);
    y = doc.y + 2;
    const lines = [
      `${typeText(e.reactionType, 'bi')} · ${certaintyText(e.certainty, 'bi')}`,
      `${ct('reaction', 'bi')}: ${manifestationsText(e.manifestations, shortLang)}${e.reactionNote ? ` — ${e.reactionNote}` : ''}`,
      `${ct('severity', 'bi')}: ${severityText(e.severity, 'bi')} · ${ct('status', 'bi')}: ${statusText(e.clinicalStatus, 'bi')}`,
      `${ct('assessed', 'bi')}: ${formatDate(e.assessmentDate, shortLang)}`,
      e.certainty === 'confirmed' && e.confirmationBasis?.length
        ? `Basis: ${e.confirmationBasis.map((b) => label(CONFIRMATION_BASIS, b, shortLang)).join(', ')}`
        : '',
      e.naranjoScore !== null && e.naranjoScore !== undefined
        ? `${ct('naranjo', 'en')}: ${e.naranjoScore} (${label(NARANJO_CATEGORIES, e.naranjoCategory, 'en')}) — ${ct('naranjoNote', shortLang)}`
        : '',
      e.verifiedBy ? `${ct('verifiedBy', 'bi')}: ${e.verifiedBy.name} (${ct('license', 'en')} ${e.verifiedBy.licenseNo}) · ${formatDate(e.verifiedAt, shortLang)}` : '',
    ].filter(Boolean);
    doc.font('R').fontSize(8).fillColor(C.ink);
    for (const l of lines) {
      doc.text(l, margin + 8, y, { width: width - 16 });
      y = doc.y + 1;
    }
    y += 6;
    doc.save().roundedRect(margin, top, width, y - top, 6).lineWidth(0.6).stroke(e.certainty === 'confirmed' ? C.red : C.amber).restore();
    y += 8;
  }

  doc.font('R').fontSize(7).fillColor(C.muted).text(
    `${ct('serial', 'en')} ${snap.serial} · ${ct('issued', 'en')} ${formatDate(snap.issuedAt, 'en')} · ${snap.facility.nameEn} ${snap.facility.phone}\n` +
    'เอกสารนี้มีข้อมูลสุขภาพซึ่งเป็นข้อมูลส่วนบุคคลอ่อนไหวตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 โปรดเก็บรักษาอย่างปลอดภัย / ' +
    'This document contains sensitive personal health data protected under the Thai PDPA. Keep it secure.',
    margin, Math.min(y + 4, doc.page.height - margin - 30), { width },
  );
  if (snap.preview) watermark(doc, margin, 300, width, 200, ct('preview', 'bi'));
}

/** Renders a card snapshot to PDF. format: "id1" (two pages, duplex for card printers) or "a4". */
export function renderCardPdf(snap, { format = 'id1', language } = {}) {
  const lang = language || snap.language || 'bi';
  const doc = new PDFDocument({
    size: format === 'a4' ? 'A4' : [CARD_W, CARD_H],
    margin: 0,
    autoFirstPage: true,
    info: { Title: `Drug Allergy Card ${snap.serial}`, Author: snap.facility.nameEn, Subject: 'Drug allergy card', Creator: 'PharmaTools' },
    pdfVersion: '1.7',
  });
  registerFonts(doc);
  if (format === 'a4') {
    drawA4(doc, snap, lang);
  } else {
    drawFront(doc, snap, lang, 0, 0);
    doc.addPage({ size: [CARD_W, CARD_H], margin: 0 });
    drawBack(doc, snap, lang, 0, 0);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
