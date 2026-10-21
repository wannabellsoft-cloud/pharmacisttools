# PharmaTools

A mobile-first progressive web app (PWA) of clinical tools for pharmacists. It currently includes:

- **Drug Allergy Card Issuance** (บัตรแพ้ยา): assess and verify drug allergies and ADRs, then issue either a printed card or a digital card for Apple Wallet, Google Wallet, the web or PDF.
- **Naranjo ADR Probability Scale**: causality assessment.

Stack: vanilla JS (ES modules, no build step), Node.js ≥ 22.5, Express, built-in `node:sqlite`, `pdfkit`, `qrcode` and `node-forge`.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000; seeds demo / demo-pharmacist (admin) and reviewer / demo-reviewer
npm test             # API, clinical-rule and Wallet tests
```

To create real accounts (production): `npm run create-pharmacist -- <username> "<display name>" <license no> [admin]`.

Copy `.env.example` and set at least `NODE_ENV=production`, `MASTER_KEY` and `PUBLIC_BASE_URL` (HTTPS).

## Workflow

1. **Patient**: register by HN. Identifiers are encrypted at rest, and HN lookup is exact-match only, using a keyed blind index.
2. **Allergy/ADR record**: enter the suspected drug, the manifestations, severity and an optional Naranjo questionnaire. Then classify the record:
   - **Type**: allergy (hypersensitivity) or non-allergic ADR.
   - **Certainty**: *suspected* or *confirmed*.
   - **Clinical status**: active, inactive, resolved, refuted or entered in error.
3. **Pharmacist verification**: the pharmacist attests to the review and re-enters their password. Each verification is bound to a record version, and editing a verified record sends it back for review. Set `REQUIRE_INDEPENDENT_REVIEWER=true` to enforce four-eyes review.
4. **Issue card**: this screen is only available when every record is verified. It shows exactly two options:
   - **Option 1: Print Drug Allergy Card**
     - Formats: ID-1 (85.60 × 53.98 mm, two duplex pages for CR80 card printers, full-bleed) or A4 (front and back side by side to cut and fold, plus a full summary).
     - Languages: Thai, English or bilingual.
     - Shows a live print preview with a "not valid" watermark before issue. After issue: Print and Export PDF (server-rendered with embedded Sarabun, so Thai renders correctly).
     - Each card carries patient identification, the suspected drug, reaction, certainty, clinical status, assessment date, the verifying pharmacist with license number, and a signed QR.
   - **Option 2: Digital Drug Allergy Card**
     - The pharmacist shows a single-use QR that expires in 10 minutes.
     - The patient scans it on their own phone, verifies their identity (date of birth + last 4 characters of their ID; the claim locks after 5 failures), reviews the card and gives explicit PDPA consent.
     - The phone gets a device credential, and the page detects iOS or Android:
       - **iOS**: Add to Apple Wallet (a signed `.pkpass` built on the backend).
       - **Android**: Add to Google Wallet.
       - **Always**: the Digital Web Card (works offline if the patient chose to keep it on the device) and a PDF.
     - Adding to Wallet needs an extra explicit confirmation, with an optional *discreet mode* that hides the name and drugs on the front of the pass.
5. **Manage cards**:
   - **Updates**: after changes are re-verified, *Push update* refreshes the web card and Wallet passes. Apple passes update through the PassKit web service plus APNs; Google objects update through a REST `PUT`. A printed card can't be updated, so you issue a new one and the old one becomes *superseded*.
   - **Revocation**: voids Apple passes, sets Google objects to `INACTIVE`, disables the web card on every device, and makes the QR report "revoked".

## Clinical safeguards

- The Naranjo score is shown and stored as **causality only**. Certainty defaults to *suspected*, and nothing ever derives *confirmed* from the score.
- *Confirmed* requires documented evidence, enforced by the same rule on both client and server (`shared/clinical.js`). Accepted evidence: skin test, provocation test, in-vitro test, documented re-exposure, specialist diagnosis, or a characteristic reaction reviewed with a physician.
- Refuted and entered-in-error records never appear on cards. The review screen flags inconsistencies, for example "Naranjo definite but suspected", or "confirmed with a doubtful/possible Naranjo".
- Cards are distinguished visually: *confirmed* is a solid red badge and *suspected* is an amber outline.

## Security & PDPA design

| Concern | Implementation |
|---|---|
| Data at rest | AES-256-GCM per row, with AAD bound to the row ID. Keys are derived from `MASTER_KEY` using HKDF. |
| Public QR on cards | `/v/{cardId}?s={HMAC}` shows **status only** (active / superseded / revoked, serial, issuer). It never shows names, drugs or IDs. Full details require a pharmacist sign-in. |
| Claim link | 256-bit random token, stored hashed. It is carried in the URL **fragment** (never sent to servers or in Referer), moved out of the URL immediately, single-use, valid for 10 minutes, and locks after 5 failed attempts. Error messages are generic, so a token cannot be probed. |
| Wallet content | Only name (optional), drugs, reactions, status, assessment date and verifier. No national ID, HN or DOB. `sharingProhibited`. Downloads go through single-use links that expire in 2 minutes. The Google save JWT references the object by ID only. |
| Consent | Explicit, versioned consent records for printed card, health-data processing, digital card, Apple Wallet and Google Wallet. Patients can withdraw from the web card, which revokes everywhere and deletes the digital card content. |
| Retention | An hourly job expires and purges claims, tokens and sessions, retires idle devices, and crypto-shreds patients past `RECORD_RETENTION_DAYS`. Pharmacists can also erase a patient on request. |
| Audit | Append-only, SHA-256 hash-chained log with no PII (codes and IDs only; IP addresses pseudonymised). Admins can verify integrity in the UI. |
| Transport/browser | Strict CSP (no inline script or style), `no-store` on all API, QR and Wallet routes, `no-referrer`, HSTS in production. The service worker caches the static shell only, never patient data. |
| Auth | scrypt password hashes, hashed bearer session tokens kept in sessionStorage (not cookies, so there is no CSRF surface), password step-up for verify, revoke and erase, and rate limits on login and claim routes. |

## Wallet setup

**Apple Wallet**

- Create a Pass Type ID and certificate in the Apple Developer portal, then export the certificate and key as PEM.
- Download the Apple WWDR intermediate certificate (G4).
- Set the `APPLE_*` variables. The web service is served at `${PUBLIC_BASE_URL}/wallet/apple` and must be reachable over HTTPS.
- Pass signing is covered by tests: a detached PKCS#7 signature over `manifest.json` that verifies with OpenSSL. The tests use self-signed certificates, so test with a real certificate on a device before going live.

**Google Wallet**

- Health information on Google Wallet must use a pass type that Google has approved for your issuer account (private/health pass programme).
- The integration stays **disabled** until `GOOGLE_WALLET_HEALTH_PASS_APPROVED=true` is set.
- The implementation:
  - creates the class and object server-side through the Wallet REST API (service-account OAuth);
  - returns a "skinny" save JWT that references the object by ID only;
  - updates and revokes passes with `PUT`.
- The resource names are kept in `PASS_TYPES` in `server/services/googleWallet.js`. If Google gives you a different resource type for your approved pass, map it there and select it with `GOOGLE_WALLET_PASS_TYPE`.

## Project layout

```
server/        Express app, crypto, audit, auth, services (patients, cards, claims, holders, wallet, pdf, retention)
shared/        Clinical vocabulary/rules and card wording, used by both server and browser
public/        PWA: pharmacist app (index.html), patient claim (claim.html), Digital Web Card (card.html)
scripts/       create-pharmacist, generate-icons
test/          node:test suites
```

Fonts: Sarabun (SIL Open Font License, see `public/fonts/OFL.txt`).
