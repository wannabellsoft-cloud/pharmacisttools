// Small shared runtime for PharmaTools pages: safe HTML templating, API client,
// toasts, modal dialogs and a hash router. No framework, CSP-friendly.

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const raw = (s) => new Safe(String(s ?? ''));

export function esc(v) {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(esc).join('');
  if (v === null || v === undefined || v === false) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Tagged template that escapes every interpolation unless wrapped in raw() or produced by html``. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += esc(v) + strings[i + 1]; });
  return new Safe(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function mount(el, content) {
  el.innerHTML = String(content);
  return el;
}

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.body = body?.error || {};
  }
}

export function createApi({ authHeader, onUnauthorized } = {}) {
  async function request(method, path, body, { raw: wantRaw = false } = {}) {
    const headers = {};
    const auth = authHeader?.();
    if (auth) headers.authorization = auth;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' });
    if (wantRaw && res.ok) return res;
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      if (res.status === 401 && onUnauthorized) onUnauthorized(json);
      throw new ApiError(res.status, json);
    }
    return json;
  }
  return {
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b = {}, o) => request('POST', p, b, o),
    put: (p, b = {}) => request('PUT', p, b),
  };
}

/** Downloads a binary response (e.g. a PDF) without exposing it in a URL. */
export async function downloadBlob(res, fallbackName) {
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ------------------------------------------------------------------ UI helpers
export function toast(message, tone = 'info') {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.textContent = message;
  host.append(el);
  while (host.children.length > 2) host.firstElementChild.remove();
  setTimeout(() => el.classList.add('out'), 3000);
  setTimeout(() => el.remove(), 3500);
}

/**
 * Opens a modal dialog. `body` is safe HTML; `actions` are [{ label, value, tone }].
 * `validate(form)` may return an error string to keep the dialog open.
 * Resolves with { value, form } or null when dismissed.
 */
export function dialog({ title, body, actions = [{ label: 'OK', value: 'ok', tone: 'primary' }], validate }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    mount(d, html`<form method="dialog" class="modal-form">
      <h2 class="modal-title">${title}</h2>
      <div class="modal-body">${body}</div>
      <p class="form-error" hidden></p>
      <div class="modal-actions">${actions.map((a) => html`<button class="btn btn-${a.tone || 'ghost'}" value="${a.value}">${a.label}</button>`)}</div>
    </form>`);
    document.body.append(d);
    const form = $('form', d);
    const err = $('.form-error', d);
    form.addEventListener('submit', (e) => {
      const value = e.submitter?.value;
      if (value && value !== 'cancel' && validate) {
        const msg = validate(form, value);
        if (msg) {
          e.preventDefault();
          err.textContent = msg;
          err.hidden = false;
          return;
        }
      }
      d.dataset.value = value || '';
    });
    d.addEventListener('close', () => {
      const value = d.dataset.value;
      const data = Object.fromEntries(new FormData(form));
      d.remove();
      resolve(value && value !== 'cancel' ? { value, form: data } : null);
    });
    d.showModal();
    $('input, select, textarea', d)?.focus();
  });
}

export function formData(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi !== undefined) {
        data[el.name] = data[el.name] || [];
        if (el.checked) data[el.name].push(el.value);
      } else data[el.name] = el.checked;
    } else if (el.type === 'radio') {
      if (el.checked) data[el.name] = el.value;
    } else data[el.name] = el.value.trim();
  }
  return data;
}

// ------------------------------------------------------------------ router
export function createRouter(routes, { onNotFound } = {}) {
  const compiled = routes.map(([pattern, handler]) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/?]+)'; })}$`);
    return { re, keys, handler };
  });
  async function resolve() {
    const full = location.hash.replace(/^#/, '') || '/';
    const [pathPart, query = ''] = full.split('?');
    for (const r of compiled) {
      const m = r.re.exec(pathPart);
      if (m) {
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return r.handler(params, new URLSearchParams(query));
      }
    }
    return onNotFound?.();
  }
  window.addEventListener('hashchange', resolve);
  return { resolve, go: (p) => { location.hash = p; } };
}

export const ICONS = {
  card: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19M6 15h5"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>',
  printer: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9V3.5h11V9M6.5 17.5h-2a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-2"/><rect x="6.5" y="14" width="11" height="7" rx="1"/></svg>',
  qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 4 6v5.6c0 4.6 3.3 8.6 8 9.6 4.7-1 8-5 8-9.6V6z"/><path d="m8.8 12 2.2 2.2 4.4-4.4"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M12 12v6M9.5 15.5 12 18l2.5-2.5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 7V5.5a2 2 0 0 0-2-2H5a2.5 2.5 0 0 0 0 5h14a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H5a2.5 2.5 0 0 1-2.5-2.5V6"/><path d="M16.5 14.5h.01"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  logout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  calc: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="2.5" width="15" height="19" rx="2"/><path d="M8 6.5h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15v3M8 18h4"/></svg>',
  log: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/></svg>',
  ban: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m5.3 5.3 13.4 13.4"/></svg>',
};

export const icon = (name, cls = 'i') => raw(`<span class="${cls}">${ICONS[name] ?? ''}</span>`);

export function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
