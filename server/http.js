export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Wraps an async/sync route handler so thrown errors reach the error middleware. */
export const route = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

/** Very small fixed-window rate limiter (in-memory, per key). */
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, _res, next) => {
    const k = key(req);
    const now = Date.now();
    const entry = hits.get(k);
    if (!entry || entry.reset < now) hits.set(k, { count: 1, reset: now + windowMs });
    else if (++entry.count > max) return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.'));
    if (hits.size > 10_000) for (const [hk, v] of hits) if (v.reset < now) hits.delete(hk);
    next();
  };
}

export function securityHeaders(production) {
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Nothing containing patient data may be cached by browsers or intermediaries.
    if (/^\/(api|v|wallet)\//.test(req.path)) res.set('Cache-Control', 'no-store');
    next();
  };
}
