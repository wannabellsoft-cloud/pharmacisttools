// Strings for patient-facing pages (claim flow and Digital Web Card).
const S = {
  appName: { th: 'บัตรแพ้ยาดิจิทัล', en: 'Digital Drug Allergy Card' },
  loading: { th: 'กำลังโหลด…', en: 'Loading…' },
  invalidLink: { th: 'ลิงก์นี้ไม่ถูกต้องหรือหมดอายุแล้ว โปรดขอ QR ใหม่จากเภสัชกร', en: 'This link is invalid or has expired. Please ask the pharmacist for a new QR code.' },
  noToken: { th: 'ไม่พบลิงก์รับบัตร โปรดสแกน QR จากเภสัชกรอีกครั้ง', en: 'No claim link found. Please scan the pharmacist\'s QR code again.' },
  step1: { th: 'ยืนยันตัวตน', en: 'Verify your identity' },
  step1Lead: { th: 'เพื่อปกป้องข้อมูลสุขภาพของคุณ โปรดยืนยันว่าคุณเป็นเจ้าของบัตร', en: 'To protect your health information, please confirm you are the card holder.' },
  dob: { th: 'วันเดือนปีเกิด', en: 'Date of birth' },
  day: { th: 'วัน', en: 'Day' },
  month: { th: 'เดือน', en: 'Month' },
  year: { th: 'ปี (พ.ศ.)', en: 'Year' },
  idLast4: { th: 'เลข 4 ตัวท้ายของบัตรประชาชน / หนังสือเดินทาง', en: 'Last 4 characters of your national ID / passport' },
  verify: { th: 'ยืนยันตัวตน', en: 'Verify' },
  attemptsLeft: { th: 'ข้อมูลไม่ตรงกับเวชระเบียน เหลือโอกาสอีก {n} ครั้ง', en: 'Details do not match our records. {n} attempt(s) left.' },
  locked: { th: 'ลองผิดเกินจำนวนครั้งที่กำหนด โปรดขอ QR ใหม่จากเภสัชกร', en: 'Too many unsuccessful attempts. Please ask the pharmacist for a new QR code.' },
  expiresIn: { th: 'ลิงก์หมดอายุใน', en: 'Link expires in' },
  step2: { th: 'ตรวจสอบข้อมูลและให้ความยินยอม', en: 'Review and consent' },
  isThisYou: { th: 'โปรดตรวจสอบว่าข้อมูลบนบัตรถูกต้อง หากไม่ถูกต้อง อย่าดำเนินการต่อ และแจ้งเภสัชกร', en: 'Check that the card information is correct. If anything is wrong, stop and tell the pharmacist.' },
  consentTitle: { th: 'การคุ้มครองข้อมูลส่วนบุคคล (PDPA)', en: 'Personal data protection (PDPA)' },
  consentBody: {
    th: '{facility} ในฐานะผู้ควบคุมข้อมูล จะประมวลผลข้อมูลสุขภาพ (ประวัติการแพ้ยา) ซึ่งเป็นข้อมูลส่วนบุคคลอ่อนไหว เพื่อออกบัตรแพ้ยาดิจิทัลและให้บุคลากรทางการแพทย์ตรวจสอบความถูกต้องของบัตร ข้อมูลถูกเข้ารหัสและเก็บไว้ไม่เกิน {days} วันนับจากการปรับปรุงล่าสุด หรือจนกว่าคุณจะถอนความยินยอม คุณมีสิทธิขอเข้าถึง แก้ไข ลบ หรือถอนความยินยอมได้ทุกเมื่อจากหน้าบัตรนี้หรือติดต่อ {phone}',
    en: '{facility}, as data controller, will process your health data (drug allergy history), which is sensitive personal data, to issue your digital allergy card and let healthcare staff verify it. Data is encrypted and kept for up to {days} days after the last update, or until you withdraw consent. You may request access, correction or deletion, or withdraw consent at any time from this card page or by calling {phone}.',
  },
  consentHealth: { th: 'ข้าพเจ้ายินยอมโดยชัดแจ้งให้ประมวลผลข้อมูลสุขภาพของข้าพเจ้าตามวัตถุประสงค์ข้างต้น', en: 'I explicitly consent to the processing of my health data for the purposes above.' },
  consentCard: { th: 'ข้าพเจ้าต้องการรับบัตรแพ้ยาดิจิทัลบนอุปกรณ์ส่วนตัวของข้าพเจ้า', en: 'I want to receive my digital drug allergy card on my personal device.' },
  keepOnDevice: { th: 'จดจำบัตรบนอุปกรณ์นี้ (ไม่ต้องสแกนใหม่)', en: 'Keep the card on this device (no need to scan again)' },
  keepHint: { th: 'ไม่ควรเลือกหากเป็นอุปกรณ์สาธารณะหรือใช้ร่วมกับผู้อื่น', en: 'Do not choose this on a shared or public device.' },
  consentVersion: { th: 'ฉบับ', en: 'Version' },
  accept: { th: 'ยินยอมและรับบัตร', en: 'Consent and get my card' },
  decline: { th: 'ไม่ยินยอม', en: 'Decline' },
  declined: { th: 'คุณไม่ได้ให้ความยินยอม ไม่มีการสร้างบัตรดิจิทัล คุณยังสามารถรับบัตรแบบพิมพ์จากเภสัชกรได้', en: 'You did not consent, so no digital card was created. You can still ask for a printed card.' },
  sessionExpired: { th: 'หมดเวลาการทำรายการ โปรดสแกน QR ใหม่', en: 'Your session expired. Please scan a new QR code.' },
  // card page
  yourCard: { th: 'บัตรแพ้ยาของคุณ', en: 'Your allergy card' },
  saveCard: { th: 'บันทึกบัตร', en: 'Save your card' },
  appleWallet: { th: 'เพิ่มใน Apple Wallet', en: 'Add to Apple Wallet' },
  googleWallet: { th: 'เพิ่มใน Google Wallet', en: 'Add to Google Wallet' },
  walletUnavailable: { th: 'สถานพยาบาลยังไม่เปิดใช้งาน Wallet — ใช้บัตรบนเว็บหรือ PDF แทน', en: 'Wallet is not enabled at this facility yet — use the web card or PDF.' },
  webCard: { th: 'บัตรบนเว็บ', en: 'Digital Web Card' },
  webCardHint: { th: 'เปิดหน้านี้ได้ทุกเมื่อ หรือ “เพิ่มไปยังหน้าจอโฮม”', en: 'Open this page anytime, or “Add to Home Screen”.' },
  pdf: { th: 'ดาวน์โหลด PDF', en: 'Download PDF' },
  pdfHint: { th: 'พิมพ์หรือเก็บไว้เป็นไฟล์', en: 'Print it or keep it as a file' },
  otherOptions: { th: 'ตัวเลือกอื่น', en: 'Other options' },
  confirmWalletTitle: { th: 'ยืนยันการบันทึกลง Wallet', en: 'Confirm saving to Wallet' },
  confirmWalletBody: {
    th: 'ข้อมูลการแพ้ยาของคุณจะถูกเก็บใน {wallet} บนอุปกรณ์นี้ และอาจมองเห็นได้เมื่อปลดล็อกโทรศัพท์ บัตรจะอัปเดตหรือถูกยกเลิกโดยอัตโนมัติเมื่อเภสัชกรแก้ไขข้อมูล คุณลบบัตรออกจาก Wallet ได้ทุกเมื่อ',
    en: 'Your allergy information will be stored in {wallet} on this device and may be visible whenever the phone is unlocked. The pass updates or is cancelled automatically when the pharmacist changes your record. You can remove it from Wallet at any time.',
  },
  confirmWalletCheck: { th: 'ข้าพเจ้าเข้าใจและยืนยันการบันทึกบัตรลง Wallet', en: 'I understand and confirm saving the card to Wallet.' },
  discreet: { th: 'โหมดส่วนตัว: ไม่แสดงชื่อและชื่อยาที่หน้าบัตร (ดูได้ที่รายละเอียด)', en: 'Discreet mode: hide my name and drug names on the front of the pass (visible in details).' },
  confirm: { th: 'ยืนยัน', en: 'Confirm' },
  cancel: { th: 'ยกเลิก', en: 'Cancel' },
  mustConfirm: { th: 'โปรดติ๊กยืนยันก่อน', en: 'Please tick the confirmation first.' },
  details: { th: 'รายละเอียด', en: 'Details' },
  privacy: { th: 'ความเป็นส่วนตัวและข้อมูลของคุณ', en: 'Privacy and your data' },
  forget: { th: 'ลบบัตรออกจากอุปกรณ์นี้', en: 'Remove card from this device' },
  forgetBody: { th: 'บัตรจะถูกลบออกจากอุปกรณ์นี้เท่านั้น บัตรใน Wallet และอุปกรณ์อื่นยังใช้ได้', en: 'The card is removed from this device only. Wallet passes and other devices keep working.' },
  withdraw: { th: 'ถอนความยินยอมและลบบัตรดิจิทัล', en: 'Withdraw consent and delete digital card' },
  withdrawBody: {
    th: 'บัตรดิจิทัลจะถูกยกเลิกในทุกอุปกรณ์และทุก Wallet และลบข้อมูลบัตรดิจิทัล ข้อมูลการแพ้ยาในเวชระเบียนของสถานพยาบาลจะยังคงเก็บรักษาตามกฎหมาย',
    en: 'Your digital card will be cancelled on every device and Wallet, and the digital card data deleted. Allergy information in the facility\'s medical record is kept as required by law.',
  },
  withdrawCheck: { th: 'ข้าพเจ้าต้องการถอนความยินยอมและลบบัตรดิจิทัล', en: 'I want to withdraw consent and delete my digital card.' },
  withdrawn: { th: 'ถอนความยินยอมแล้ว บัตรดิจิทัลถูกยกเลิกและลบออกแล้ว', en: 'Consent withdrawn. Your digital card has been cancelled and deleted.' },
  done: { th: 'เรียบร้อย', en: 'Done' },
  revoked: { th: 'บัตรนี้ถูกยกเลิกแล้ว', en: 'This card has been cancelled' },
  revokedBody: { th: 'โปรดติดต่อเภสัชกรเพื่อรับบัตรฉบับปัจจุบัน', en: 'Please contact your pharmacist for a current card.' },
  noCard: { th: 'ไม่มีบัตรบนอุปกรณ์นี้', en: 'No card on this device' },
  noCardBody: { th: 'ขอ QR รับบัตรดิจิทัลจากเภสัชกร', en: 'Ask your pharmacist for a digital card QR code.' },
  offline: { th: 'ออฟไลน์ — แสดงข้อมูลที่บันทึกไว้ล่าสุด', en: 'Offline — showing the last saved copy' },
  updated: { th: 'อัปเดตล่าสุด', en: 'Last updated' },
  showClinicians: { th: 'แสดงบัตรนี้ต่อแพทย์ เภสัชกร หรือพยาบาลทุกครั้งที่รับบริการ', en: 'Show this card to doctors, pharmacists and nurses at every visit.' },
};

export function createI18n(storageKey = 'pt.lang') {
  let lang = 'th';
  try { lang = localStorage.getItem(storageKey) || (navigator.language?.startsWith('th') ? 'th' : 'en'); } catch { /* ignore */ }
  return {
    get lang() { return lang; },
    set lang(v) { lang = v; try { localStorage.setItem(storageKey, v); } catch { /* ignore */ } document.documentElement.lang = v; },
    t(key, vars = {}) {
      const e = S[key];
      const s = e ? e[lang] ?? e.en : key;
      return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
    },
  };
}

export const MONTHS = {
  th: ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
