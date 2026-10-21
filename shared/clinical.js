// Clinical vocabulary and rules shared by the server and the browser.
// Kept dependency-free so it can be imported as an ES module in both places.

/** Naranjo ADR Probability Scale. Scores are [yes, no, unknown]. */
export const NARANJO_QUESTIONS = [
  { id: 'q1', score: [1, 0, 0], en: 'Are there previous conclusive reports on this reaction?', th: 'เคยมีรายงานที่สรุปได้แน่ชัดเกี่ยวกับอาการนี้มาก่อนหรือไม่' },
  { id: 'q2', score: [2, -1, 0], en: 'Did the adverse event appear after the suspected drug was administered?', th: 'อาการเกิดขึ้นหลังได้รับยาที่สงสัยหรือไม่' },
  { id: 'q3', score: [1, 0, 0], en: 'Did the reaction improve when the drug was discontinued or a specific antagonist was given?', th: 'อาการดีขึ้นเมื่อหยุดยาหรือได้รับยาต้านเฉพาะหรือไม่' },
  { id: 'q4', score: [2, -1, 0], en: 'Did the reaction reappear when the drug was readministered?', th: 'อาการกลับเป็นซ้ำเมื่อได้รับยาอีกครั้งหรือไม่' },
  { id: 'q5', score: [-1, 2, 0], en: 'Are there alternative causes that could on their own have caused the reaction?', th: 'มีสาเหตุอื่นที่อาจทำให้เกิดอาการนี้ได้หรือไม่' },
  { id: 'q6', score: [-1, 1, 0], en: 'Did the reaction reappear when a placebo was given?', th: 'อาการเกิดขึ้นอีกเมื่อได้รับยาหลอกหรือไม่' },
  { id: 'q7', score: [1, 0, 0], en: 'Was the drug detected in blood or other fluids in toxic concentrations?', th: 'ตรวจพบยาในเลือดหรือสารน้ำอื่นในระดับที่เป็นพิษหรือไม่' },
  { id: 'q8', score: [1, 0, 0], en: 'Was the reaction more severe when the dose was increased, or less severe when decreased?', th: 'อาการรุนแรงขึ้นเมื่อเพิ่มขนาดยา หรือลดลงเมื่อลดขนาดยาหรือไม่' },
  { id: 'q9', score: [1, 0, 0], en: 'Did the patient have a similar reaction to the same or similar drugs in any previous exposure?', th: 'ผู้ป่วยเคยมีอาการคล้ายกันเมื่อได้รับยานี้หรือยาที่คล้ายกันมาก่อนหรือไม่' },
  { id: 'q10', score: [1, 0, 0], en: 'Was the adverse event confirmed by any objective evidence?', th: 'มีหลักฐานเชิงวัตถุวิสัยยืนยันอาการไม่พึงประสงค์หรือไม่' },
];

const ANSWER_INDEX = { yes: 0, no: 1, unknown: 2 };

export const NARANJO_CATEGORIES = {
  definite: { en: 'Definite', th: 'ใช่แน่นอน (Definite)' },
  probable: { en: 'Probable', th: 'น่าจะใช่ (Probable)' },
  possible: { en: 'Possible', th: 'อาจจะใช่ (Possible)' },
  doubtful: { en: 'Doubtful', th: 'สงสัย/ไม่น่าใช่ (Doubtful)' },
};

/**
 * Scores a Naranjo questionnaire. The result describes the *probability that
 * the drug caused the event*; it is not an allergy diagnosis and must never be
 * used on its own to mark an allergy as confirmed.
 */
export function scoreNaranjo(answers = {}) {
  let score = 0;
  let answered = 0;
  for (const q of NARANJO_QUESTIONS) {
    const a = answers[q.id];
    if (!(a in ANSWER_INDEX)) continue;
    answered += 1;
    score += q.score[ANSWER_INDEX[a]];
  }
  let category = 'doubtful';
  if (score >= 9) category = 'definite';
  else if (score >= 5) category = 'probable';
  else if (score >= 1) category = 'possible';
  return { score, category, answered, complete: answered === NARANJO_QUESTIONS.length };
}

export const REACTION_TYPES = {
  allergy: { en: 'Drug allergy (hypersensitivity)', th: 'แพ้ยา (ภูมิไวเกิน)', shortEn: 'Allergy', shortTh: 'แพ้ยา' },
  adr: { en: 'Adverse drug reaction (non-allergic)', th: 'อาการไม่พึงประสงค์จากยา (ไม่ใช่การแพ้)', shortEn: 'ADR', shortTh: 'ADR' },
};

export const CERTAINTY = {
  suspected: { en: 'Suspected', th: 'สงสัย' },
  confirmed: { en: 'Confirmed', th: 'ยืนยันแล้ว' },
};

/** Acceptable grounds for marking an allergy/ADR as confirmed. Naranjo is deliberately absent. */
export const CONFIRMATION_BASIS = {
  skin_test: { en: 'Positive skin test', th: 'ผลทดสอบทางผิวหนังเป็นบวก' },
  provocation_test: { en: 'Drug provocation / challenge test', th: 'การทดสอบท้าทายด้วยยา' },
  in_vitro_test: { en: 'In-vitro test (e.g. specific IgE, LTT)', th: 'การทดสอบในหลอดทดลอง (เช่น specific IgE, LTT)' },
  documented_rechallenge: { en: 'Documented re-exposure with recurrence', th: 'มีบันทึกการได้รับยาซ้ำแล้วเกิดอาการซ้ำ' },
  specialist_diagnosis: { en: 'Allergist / physician diagnosis', th: 'วินิจฉัยโดยแพทย์ผู้เชี่ยวชาญ' },
  characteristic_reaction: { en: 'Characteristic reaction with clear temporal link, reviewed with physician', th: 'อาการจำเพาะชัดเจนสัมพันธ์กับเวลา ทบทวนร่วมกับแพทย์' },
};

export const CLINICAL_STATUS = {
  active: { en: 'Active', th: 'ยังมีผล (Active)' },
  inactive: { en: 'Inactive', th: 'ไม่มีผลแล้ว (Inactive)' },
  resolved: { en: 'Resolved', th: 'หายแล้ว (Resolved)' },
  refuted: { en: 'Refuted', th: 'พิสูจน์แล้วว่าไม่แพ้ (Refuted)' },
  entered_in_error: { en: 'Entered in error', th: 'บันทึกผิดพลาด' },
};

export const SEVERITY = {
  mild: { en: 'Mild', th: 'เล็กน้อย' },
  moderate: { en: 'Moderate', th: 'ปานกลาง' },
  severe: { en: 'Severe', th: 'รุนแรง' },
  life_threatening: { en: 'Life-threatening', th: 'รุนแรงถึงชีวิต' },
};

export const MANIFESTATIONS = {
  rash: { en: 'Rash', th: 'ผื่น' },
  maculopapular: { en: 'Maculopapular rash', th: 'ผื่นแดงนูน (MP rash)' },
  urticaria: { en: 'Urticaria', th: 'ลมพิษ' },
  pruritus: { en: 'Pruritus', th: 'คัน' },
  angioedema: { en: 'Angioedema', th: 'ปาก/ตาบวม (Angioedema)' },
  anaphylaxis: { en: 'Anaphylaxis', th: 'แพ้รุนแรง (Anaphylaxis)' },
  bronchospasm: { en: 'Bronchospasm', th: 'หลอดลมหดเกร็ง' },
  hypotension: { en: 'Hypotension', th: 'ความดันโลหิตต่ำ' },
  sjs_ten: { en: 'SJS / TEN', th: 'SJS / TEN' },
  dress: { en: 'DRESS', th: 'DRESS' },
  fde: { en: 'Fixed drug eruption', th: 'ผื่นจากยาชนิดซ้ำที่เดิม (FDE)' },
  agep: { en: 'AGEP', th: 'AGEP' },
  gi: { en: 'Nausea / vomiting / diarrhoea', th: 'คลื่นไส้ / อาเจียน / ท้องเสีย' },
  hepatotoxicity: { en: 'Hepatotoxicity', th: 'ตับอักเสบจากยา' },
  nephrotoxicity: { en: 'Nephrotoxicity', th: 'ไตเสียหายจากยา' },
  hematologic: { en: 'Blood dyscrasia', th: 'ความผิดปกติทางโลหิตวิทยา' },
  other: { en: 'Other', th: 'อื่น ๆ' },
};

/** Clinical statuses that should appear on a card. Refuted/erroneous entries never do. */
export const CARD_VISIBLE_STATUS = ['active', 'inactive', 'resolved'];

/**
 * Validates an allergy/ADR record before it is saved. Returns a list of
 * { field, code } errors. The same rules run in the browser and on the server.
 */
export function validateRecord(r) {
  const errors = [];
  const req = (field) => {
    if (r[field] === undefined || r[field] === null || String(r[field]).trim() === '') errors.push({ field, code: 'REQUIRED' });
  };
  ['drugGeneric', 'reactionType', 'certainty', 'clinicalStatus', 'severity', 'assessmentDate'].forEach(req);
  if (!Array.isArray(r.manifestations) || r.manifestations.length === 0) errors.push({ field: 'manifestations', code: 'REQUIRED' });
  else if (r.manifestations.some((m) => !(m in MANIFESTATIONS))) errors.push({ field: 'manifestations', code: 'INVALID' });
  if (r.reactionType && !(r.reactionType in REACTION_TYPES)) errors.push({ field: 'reactionType', code: 'INVALID' });
  if (r.certainty && !(r.certainty in CERTAINTY)) errors.push({ field: 'certainty', code: 'INVALID' });
  if (r.clinicalStatus && !(r.clinicalStatus in CLINICAL_STATUS)) errors.push({ field: 'clinicalStatus', code: 'INVALID' });
  if (r.severity && !(r.severity in SEVERITY)) errors.push({ field: 'severity', code: 'INVALID' });
  if (r.assessmentDate && (!/^\d{4}-\d{2}-\d{2}$/.test(r.assessmentDate) || new Date(r.assessmentDate) > new Date(Date.now() + 86_400_000))) {
    errors.push({ field: 'assessmentDate', code: 'INVALID' });
  }

  // Confirmation must rest on clinical evidence documented by the reviewer —
  // a high Naranjo score alone is never sufficient.
  if (r.certainty === 'confirmed') {
    const basis = Array.isArray(r.confirmationBasis) ? r.confirmationBasis : [];
    if (basis.length === 0) errors.push({ field: 'confirmationBasis', code: 'CONFIRMATION_BASIS_REQUIRED' });
    else if (basis.some((b) => !(b in CONFIRMATION_BASIS))) errors.push({ field: 'confirmationBasis', code: 'INVALID' });
    if (!r.confirmationNote || String(r.confirmationNote).trim().length < 5) errors.push({ field: 'confirmationNote', code: 'CONFIRMATION_NOTE_REQUIRED' });
  }
  return errors;
}

/**
 * Proposes a certainty from data on the record. It only ever proposes
 * "suspected"; "confirmed" must be chosen explicitly by the pharmacist with
 * documented evidence, regardless of the Naranjo category.
 */
export function proposeCertainty() {
  return 'suspected';
}

/** Masks a Thai national ID / passport number, keeping only the last 4 characters. */
export function maskId(id) {
  const s = String(id || '').replace(/[\s-]/g, '');
  if (s.length <= 4) return s ? '••••' : '';
  return `${'•'.repeat(Math.min(s.length - 4, 9))}${s.slice(-4)}`;
}

export function label(dict, key, lang) {
  const entry = dict[key];
  if (!entry) return key ?? '';
  return lang === 'th' ? entry.th : entry.en;
}
