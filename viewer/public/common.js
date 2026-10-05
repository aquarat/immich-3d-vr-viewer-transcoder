/* Shared between the player and the probe page: the Immich API client, the
 * diagnostic sink, and the service worker scope claim.
 *
 * Classic scripts, no modules and no build step — everything here lands on
 * window deliberately.
 */
'use strict';

const API = '/api';

/* ------------------------------------------------------------- telemetry */

const telemetry = {
  session: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  rows: [],
  lines: [],
  pending: null,
  sink: null,          // optional: page-provided display hook
  device: {
    ua: navigator.userAgent,
    dpr: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    cores: navigator.hardwareConcurrency ?? null,
    memoryGB: navigator.deviceMemory ?? null,
    secure: window.isSecureContext,
    href: location.href,
  },
  row(key, value, status, note) {
    this.rows.push({ key, value: String(value), status, note });
    if (status === 'fail') this.schedule(600);
  },
  line(text) {
    this.lines.push(`${new Date().toISOString().slice(11, 23)}  ${text}`);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
    this.sink?.(text);
  },
  schedule(delay) {
    if (this.pending) return;
    this.pending = setTimeout(() => { this.pending = null; this.flush('failure'); }, delay);
  },
  flush(reason, useBeacon = false) {
    if (!this.rows.length && !this.lines.length) return;
    const body = JSON.stringify({
      reason, session: this.session, at: new Date().toISOString(),
      device: this.device, rows: this.rows, log: this.lines,
    });
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon('log', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('log', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
        }).catch(() => {});
      }
    } catch { /* a collector that is down must never break the app */ }
  },
};

function log(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  telemetry.line(line);
  console.log(line);
}

window.addEventListener('pagehide', () => telemetry.flush('pagehide', true));
window.addEventListener('error', (e) => {
  telemetry.line(`!uncaught: ${e.message} @ ${e.filename}:${e.lineno}`);
  telemetry.schedule(300);
});
window.addEventListener('unhandledrejection', (e) => {
  telemetry.line(`!unhandled rejection: ${e.reason?.message || e.reason}`);
  telemetry.schedule(300);
});

/* --------------------------------------------------------- service worker */

/* Immich's worker is registered at "/" and intercepts
 * /api/assets/<id>/(original|thumbnail), deduping by URL alone and returning a
 * clone of the first response for five minutes. That is wrong for the
 * successive Range requests a <video> element makes and fails the load outright.
 * A worker at /vr wins on scope length. The scope is '/vr' rather than '/vr/'
 * because the page can be loaded without the trailing slash, which needs the
 * Service-Worker-Allowed header nginx sets on sw.js. */
async function claimServiceWorkerScope() {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  try {
    await navigator.serviceWorker.register('sw.js', { scope: '/vr' });
    const ours = () => !!navigator.serviceWorker.controller?.scriptURL.endsWith('/vr/sw.js');
    if (!ours()) {
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
    return ours() ? 'ours' : (navigator.serviceWorker.controller?.scriptURL || 'none');
  } catch (err) {
    return `failed: ${err.message}`;
  }
}

/* ------------------------------------------------------------ immich api */

const immich = {
  key: localStorage.getItem('immich-vr.apikey') || '',

  headers() {
    return this.key ? { 'x-api-key': this.key } : {};
  },

  async get(path) {
    const res = await fetch(`${API}${path}`, { credentials: 'same-origin', headers: this.headers() });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  },

  async post(path, body) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  },

  me() { return this.get('/users/me'); },
  albums() { return this.get('/albums'); },

  /* Album membership, not tags. Immich's metadata extraction calls
   * replaceAssetTags(), which replaces an asset's whole tag set from the file's
   * own XMP — so a tag applied by hand survives only until the next extraction
   * pass. Albums are not derived from file metadata and survive.
   *
   * GET /albums/:id carries assetCount but not the assets themselves in this
   * version, so membership is read through search instead. */
  async assetsByAlbum(albumId, { size = 1000, max = 5000 } = {}) {
    const out = [];
    let page = 1;
    for (;;) {
      const res = await this.post('/search/metadata', { albumIds: [albumId], size, page });
      const found = res.assets || res;
      const items = found.items || [];
      out.push(...items);
      if (!found.nextPage || !items.length || out.length >= max) break;
      page = Number(found.nextPage) || page + 1;
    }
    return out;
  },

  // Video playback must use the original: these assets have no transcodes, and
  // the configured policy would halve the per-eye resolution of an SBS frame.
  originalUrl(id) { return `${API}/assets/${id}/original`; },
  thumbUrl(id, size = 'thumbnail') { return `${API}/assets/${id}/thumbnail?size=${size}`; },
};
