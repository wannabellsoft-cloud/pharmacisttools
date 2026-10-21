// Card wording and helpers shared by the HTML card renderer and the PDF generator,
// so print preview, printed card, PDF and web card always say the same thing.
import { CERTAINTY, CLINICAL_STATUS, MANIFESTATIONS, REACTION_TYPES, SEVERITY, label } from './clinical.js';

export const CARD_TEXT = {
  title: { th: 'บัตรแพ้ยา', en: 'DRUG ALLERGY CARD' },
  subtitle: { th: 'โปรดแสดงบัตรนี้ทุกครั้งที่รับบริการทางการแพทย์', en: 'Show this card at every healthcare visit' },
  name: { th: 'ชื่อ-สกุล', en: 'Name' },
  hn: { th: 'HN', en: 'HN' },
  dob: { th: 'วันเกิด', en: 'DOB' },
  idNo: { th: 'เลขประจำตัว', en: 'ID' },
  drug: { th: 'ยาที่แพ้/สงสัย', en: 'Drug' },
  reaction: { th: 'อาการ', en: 'Reaction' },
  severity: { th: 'ความรุนแรง', en: 'Severity' },
  status: { th: 'สถานะ', en: 'Status' },
  assessed: { th: 'วันที่ประเมิน', en: 'Assessed' },
  verifiedBy: { th: 'เภสัชกรผู้ตรวจสอบ', en: 'Verified by pharmacist' },
  license: { th: 'ภ.', en: 'Lic.' },
  serial: { th: 'เลขที่บัตร', en: 'Card No.' },
  issued: { th: 'ออกบัตร', en: 'Issued' },
  scan: { th: 'สแกนเพื่อตรวจสอบความถูกต้องของบัตร', en: 'Scan to verify card authenticity' },
  more: { th: 'และอีก {n} รายการ — ดูด้านหลัง', en: '+{n} more — see reverse' },
  moreBack: { th: 'มีรายการเพิ่มเติม {n} รายการ — สแกน QR หรือดูเอกสารสรุป', en: '{n} more entries — scan QR or see summary sheet' },
  emergency: { th: 'กรณีฉุกเฉินติดต่อ', en: 'Contact' },
  preview: { th: 'ตัวอย่าง — ยังไม่มีผล', en: 'PREVIEW — NOT VALID' },
  revoked: { th: 'บัตรนี้ถูกยกเลิกแล้ว', en: 'This card has been revoked' },
  superseded: { th: 'มีบัตรฉบับใหม่กว่า', en: 'A newer card has been issued' },
  summaryTitle: { th: 'สรุปประวัติการแพ้ยา / อาการไม่พึงประสงค์จากยา', en: 'Drug allergy / ADR summary' },
  naranjo: { th: 'Naranjo', en: 'Naranjo' },
  naranjoNote: {
    th: 'คะแนน Naranjo ใช้ประเมินความน่าจะเป็นของความสัมพันธ์ระหว่างยาและอาการเท่านั้น ไม่ใช่การยืนยันการแพ้ยา',
    en: 'Naranjo score estimates causality likelihood only; it does not confirm an allergy.',
  },
  cutLine: { th: 'ตัดตามเส้นประ แล้วพับตรงกลาง', en: 'Cut along the dashed line, fold in the middle' },
  digitalTitle: { th: 'บัตรแพ้ยาดิจิทัล', en: 'Digital Drug Allergy Card' },
};

/** Returns the text for a key in "th", "en" or bilingual "bi" ("ไทย / English"). */
export function ct(key, lang, vars = {}) {
  const e = CARD_TEXT[key];
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  if (!e) return key;
  if (lang === 'bi') return `${fill(e.th)} / ${fill(e.en)}`;
  return fill(lang === 'th' ? e.th : e.en);
}

/** Same as label() but supports bilingual output. */
export function vocab(dict, key, lang) {
  if (lang === 'bi') {
    const th = label(dict, key, 'th');
    const en = label(dict, key, 'en');
    return th === en || th.includes(`(${en})`) ? th : `${th} (${en})`;
  }
  return label(dict, key, lang);
}

export const certaintyText = (k, lang) => vocab(CERTAINTY, k, lang);
export const statusText = (k, lang) => vocab(CLINICAL_STATUS, k, lang);
export const severityText = (k, lang) => vocab(SEVERITY, k, lang);
export const typeText = (k, lang) => {
  const t = REACTION_TYPES[k];
  if (!t) return k;
  if (lang === 'bi') return t.shortTh === t.shortEn ? t.shortEn : `${t.shortTh} / ${t.shortEn}`;
  return lang === 'th' ? t.shortTh : t.shortEn;
};
export const manifestationsText = (list = [], lang) =>
  list.map((m) => label(MANIFESTATIONS, m, lang === 'bi' ? 'en' : lang)).join(', ');

export function patientName(p, lang) {
  const th = [p.firstNameTh, p.lastNameTh].filter(Boolean).join(' ');
  const en = [p.firstNameEn, p.lastNameEn].filter(Boolean).join(' ');
  if (lang === 'th') return th || en;
  if (lang === 'en') return en || th;
  return th && en ? `${th} / ${en}` : th || en;
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Formats an ISO date. Thai uses the Buddhist Era year, as is customary on Thai medical documents. */
export function formatDate(iso, lang) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y) return '';
  if (lang === 'th') return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
  return `${String(d).padStart(2, '0')} ${EN_MONTHS[m - 1]} ${y}`;
}

/** Bilingual cards show Thai date first then the Gregorian year. */
export function formatDateFor(iso, lang) {
  return lang === 'bi' ? `${formatDate(iso, 'th')} (${formatDate(iso, 'en')})` : formatDate(iso, lang);
}

export const FRONT_MAX_DRUGS = 3;
