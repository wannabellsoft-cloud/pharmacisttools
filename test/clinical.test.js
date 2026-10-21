import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNaranjo, validateRecord, proposeCertainty, maskId } from '../shared/clinical.js';
import { thaiIdChecksumOk } from '../server/services/patients.js';

test('Naranjo scoring and categories', () => {
  const all = (a) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`q${i + 1}`, a]));
  assert.deepEqual(scoreNaranjo(all('unknown')), { score: 0, category: 'doubtful', answered: 10, complete: true });
  // Maximum: yes everywhere except q5/q6 which score on "no".
  const max = { ...all('yes'), q5: 'no', q6: 'no' };
  assert.equal(scoreNaranjo(max).score, 13);
  assert.equal(scoreNaranjo(max).category, 'definite');
  assert.equal(scoreNaranjo({ q1: 'yes', q2: 'yes', q3: 'yes', q8: 'yes' }).category, 'probable');
  assert.equal(scoreNaranjo({ q2: 'yes' }).category, 'possible');
  assert.equal(scoreNaranjo({ q2: 'no' }).score, -1);
});

test('a definite Naranjo score never proposes a confirmed allergy', () => {
  assert.equal(proposeCertainty(), 'suspected');
});

test('confirmed certainty requires documented clinical basis, not Naranjo', () => {
  const base = { drugGeneric: 'X', reactionType: 'allergy', clinicalStatus: 'active', severity: 'mild', assessmentDate: '2026-01-01', manifestations: ['rash'] };
  assert.deepEqual(validateRecord({ ...base, certainty: 'suspected' }), []);
  const codes = validateRecord({ ...base, certainty: 'confirmed' }).map((e) => e.code);
  assert.ok(codes.includes('CONFIRMATION_BASIS_REQUIRED'));
  assert.ok(codes.includes('CONFIRMATION_NOTE_REQUIRED'));
  assert.deepEqual(validateRecord({ ...base, certainty: 'confirmed', confirmationBasis: ['skin_test'], confirmationNote: 'Positive prick test 2026' }), []);
  assert.ok(validateRecord({ ...base, certainty: 'confirmed', confirmationBasis: ['naranjo'], confirmationNote: 'Naranjo 10' }).some((e) => e.code === 'INVALID'));
});

test('ID masking and Thai ID checksum', () => {
  assert.equal(maskId('1-1037-02071-81-1'), '•••••••••1811');
  assert.equal(thaiIdChecksumOk('1103702071811'), true);
  assert.equal(thaiIdChecksumOk('1103702071812'), false);
});
