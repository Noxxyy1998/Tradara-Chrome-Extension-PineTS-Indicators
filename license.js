// License keys for Auto-Trading.
// Keys are created only by the admin's separate License Generator, which holds the PRIVATE signing key.
// The extension contains only the PUBLIC key below: it can check that a key is genuine, but can't create one.
'use strict';

(() => {
  if (typeof window !== 'undefined' && window.PTOLicense) return;

  // Public key (ECDSA P-256). Safe to publish.
  const PUBLIC_KEYS = {
    '6d9addef3643': { kty: 'EC', crv: 'P-256', x: 'vvdvfW2hfgrfE0PEeSn_tgz2QA0-URWljnxLiD7K-Q8', y: 'ZbGjvMmqHm4rylEu_BCH_TlqbMlJHghKIasLLDNQ7ZU' },
  };

  // License IDs you've cancelled (e.g. refunds or shared keys). Add the ID here and publish an update.
  const REVOKED = [];

  const b64urlToBytes = (s) => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };

  async function verify(raw) {
    const key = String(raw || '').replace(/\s+/g, '');
    const m = /^PTO1-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key);
    if (!m) return { ok: false, error: "That doesn't look like a license key (it should start with PTO1-)." };
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[1]))); }
    catch (_) { return { ok: false, error: 'This license key is damaged. Copy it again exactly as you received it.' }; }
    const jwk = PUBLIC_KEYS[payload.kid];
    if (!jwk) return { ok: false, error: 'This license key was not issued for this extension.' };
    let valid = false;
    try {
      const pub = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlToBytes(m[2]), new TextEncoder().encode(`PTO1.${m[1]}`));
    } catch (_) { valid = false; }
    if (!valid) return { ok: false, error: 'This license key is not valid.' };
    if (REVOKED.includes(payload.id)) return { ok: false, error: 'This license has been cancelled. Contact the seller.' };
    if (payload.exp && Date.now() > payload.exp) return { ok: false, error: `This license expired on ${new Date(payload.exp).toLocaleDateString()}.`, payload };
    if (!Array.isArray(payload.f) || !payload.f.includes('autotrade')) return { ok: false, error: "This license doesn't include Auto-Trading." };
    return { ok: true, payload };
  }

  async function activate(raw) {
    const r = await verify(raw);
    if (r.ok) await chrome.storage.local.set({ license: String(raw).replace(/\s+/g, '') });
    return r;
  }
  async function status() {
    const { license } = await chrome.storage.local.get('license');
    if (!license) return { ok: false, none: true };
    return verify(license);
  }
  async function remove() { await chrome.storage.local.remove('license'); }

  const api = { verify, activate, status, remove };
  if (typeof window !== 'undefined') window.PTOLicense = api;
})();
