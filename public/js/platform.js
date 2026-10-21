/** Detects the patient's platform to choose the right Wallet. */
export function detectPlatform(nav = navigator) {
  const ua = nav.userAgent || '';
  const uaPlatform = nav.userAgentData?.platform || '';
  // iPadOS reports itself as Macintosh; touch support tells them apart.
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (nav.maxTouchPoints || 0) > 1);
  const android = /Android/i.test(ua) || /Android/i.test(uaPlatform);
  return ios ? 'ios' : android ? 'android' : 'other';
}
