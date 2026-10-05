/* Immich VR — step 1 capability probe.
 *
 * Deliberately dependency-free and build-free: it is a diagnostic that has to run
 * on a headset browser we cannot debug interactively, so everything it learns is
 * written to the 2D page, which stays readable after the session ends.
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const API = '/api';
const LS_KEY = 'immich-vr.apikey';

const logEl = $('#log');
function log(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p, null, 2))).join(' ');
  const t = new Date().toISOString().slice(11, 23);
  logEl.textContent += `${t}  ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  telemetry.line(line);
  console.log(line);
}

/* ------------------------------------------------------------- telemetry */

/* There are no usable devtools on the headset, so the report has to leave the
 * device. Everything report() and log() produce is mirrored into a buffer and
 * posted to /vr/log, which appends it as one JSON line per delivery.
 *
 * Failures flush promptly; everything else rides along at the end of a phase or
 * on pagehide. Nothing here is allowed to throw into the probe's path: a broken
 * collector must never be the reason a diagnostic run fails. */
const telemetry = {
  session: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  rows: [],
  lines: [],
  pending: null,
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
    this.lines.push(text);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
  },
  schedule(delay) {
    if (this.pending) return;
    this.pending = setTimeout(() => { this.pending = null; this.flush('failure'); }, delay);
  },

  payload(reason) {
    return {
      reason,
      session: this.session,
      at: new Date().toISOString(),
      device: this.device,
      rows: this.rows,
      log: this.lines,
    };
  },

  flush(reason, useBeacon = false) {
    if (!this.rows.length && !this.lines.length) return;
    const body = JSON.stringify(this.payload(reason));
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon('log', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      /* a collector that is down must not break the probe */
    }
  },
};

window.addEventListener('pagehide', () => telemetry.flush('pagehide', true));
window.addEventListener('error', (e) => {
  telemetry.line(`!uncaught: ${e.message} @ ${e.filename}:${e.lineno}`);
  telemetry.schedule(300);
});
window.addEventListener('unhandledrejection', (e) => {
  telemetry.line(`!unhandled rejection: ${e.reason?.message || e.reason}`);
  telemetry.schedule(300);
});

/* Media elements report every failure as code 4, so capture the surrounding
 * state — that is where the actual cause shows up. */
function videoState(video) {
  let buffered = [];
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      buffered.push([video.buffered.start(i), video.buffered.end(i)]);
    }
  } catch { /* buffered throws when nothing is loaded */ }
  let played = [];
  try {
    for (let i = 0; i < video.played.length; i++) {
      played.push([+video.played.start(i).toFixed(2), +video.played.end(i).toFixed(2)]);
    }
  } catch { /* played throws before anything has played */ }
  return {
    errorCode: video.error?.code ?? null,
    errorMessage: video.error?.message ?? null,
    networkState: video.networkState,
    readyState: video.readyState,
    currentSrc: video.currentSrc,
    size: `${video.videoWidth}x${video.videoHeight}`,
    duration: Number.isFinite(video.duration) ? +video.duration.toFixed(3) : null,
    currentTime: +video.currentTime.toFixed(3),
    muted: video.muted,
    volume: video.volume,
    buffered,
    played,
  };
}

function report(target, key, value, status = 'info', note) {
  const row = document.createElement('div');
  row.className = `r ${status}`;
  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'v';
  v.textContent = String(value);
  row.append(k, v);
  if (note) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = note;
    row.append(n);
  }
  target.append(row);
  telemetry.row(key, value, status, note);
  return row;
}

const bytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} kB`);

/* ------------------------------------------------------------------ state */

let fixtures = [];
let apiKey = localStorage.getItem(LS_KEY) || '';
let session = null;
let sessionCleanup = null;

/* --------------------------------------------------------------- 1 · auth */

function authHeaders() {
  return apiKey ? { 'x-api-key': apiKey } : {};
}

function originalUrl(id) {
  return `${API}/assets/${id}/original`;
}

async function probeAuth() {
  const out = $('#auth-report');
  out.textContent = '';
  report(out, 'origin', location.origin, 'info');
  report(out, 'secure context', window.isSecureContext ? 'yes' : 'NO — WebXR will refuse',
    window.isSecureContext ? 'ok' : 'fail',
    window.isSecureContext ? undefined : 'WebXR requires HTTPS. Reach this page over https://, with a certificate the headset trusts.');

  // Which way in? A page reached through a CDN or tunnel such as Cloudflare streams
  // every byte of video out to the internet and back, which matters for 20 Mbps
  // originals. Cloudflare stamps cf-ray on everything it proxies, which tells the
  // two paths apart; other proxies are reported by their Server header.
  try {
    const res = await fetch('index.html', { method: 'HEAD', cache: 'no-store' });
    const ray = res.headers.get('cf-ray');
    const via = res.headers.get('server');
    if (ray) {
      report(out, 'network path', `via Cloudflare (cf-ray ${ray})`, 'warn',
        'Video will stream out to the internet and back. If you are at home, a local DNS entry ' +
        'pointing your Immich hostname at the server avoids that (and the headset may need ' +
        'secure/private DNS turned off to honour it).');
    } else {
      report(out, 'network path', `direct${via ? ` (server: ${via})` : ''}`, 'ok',
        'No Cloudflare in the path.');
    }
  } catch (err) {
    report(out, 'network path', `could not determine — ${err.message}`, 'warn');
  }

  // Immich registers a service worker at scope "/", which therefore also covers
  // /vr/. Its fetch handler only calls respondWith for
  // /api/assets/<id>/(original|thumbnail) — which is exactly the URL this app
  // plays video from. It dedupes by URL and clones the Response, so a 200 MB
  // original may be teed through memory rather than range-requested by the
  // browser. Worth knowing before blaming the headset for a stall.
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration('./');
      const controller = navigator.serviceWorker.controller;
      if (controller) {
        const immich = !controller.scriptURL.includes('/vr/');
        report(out, 'service worker', controller.scriptURL, immich ? 'warn' : 'ok',
          immich ? "Immich's worker controls this page and intercepts /api/assets/<id>/original. " +
                   'If video stalls or cannot seek, this is the first suspect — registering our own ' +
                   'worker at /vr/ scope would take precedence.'
                 : undefined);
      } else {
        report(out, 'service worker', reg ? 'registered, not controlling' : 'none', 'ok');
      }
    } catch (err) {
      report(out, 'service worker', `check failed — ${err.message}`, 'info');
    }
  }

  // Cookie auth: the only method a <video src> can use.
  try {
    const res = await fetch(`${API}/users/me`, { credentials: 'same-origin' });
    if (res.ok) {
      const me = await res.json();
      report(out, 'session cookie', `ok — ${me.email}`, 'ok', 'Video playback will authenticate.');
    } else {
      report(out, 'session cookie', `${res.status} ${res.statusText}`, 'fail',
        'Log into Immich in this browser, then re-check. Without this, video elements get a 401.');
    }
  } catch (err) {
    report(out, 'session cookie', `error — ${err.message}`, 'fail');
  }

  // API key: usable for fetch() only, but worth knowing it is valid.
  if (apiKey) {
    try {
      const res = await fetch(`${API}/users/me`, { headers: authHeaders() });
      report(out, 'x-api-key header', res.ok ? 'ok' : `${res.status} ${res.statusText}`,
        res.ok ? 'ok' : 'fail');
    } catch (err) {
      report(out, 'x-api-key header', `error — ${err.message}`, 'fail');
    }

    // If Immich honours a query-string key, step 2 can authenticate <video> without
    // a cookie. Worth one request to find out rather than guessing.
    for (const param of ['apiKey', 'key']) {
      try {
        const res = await fetch(`${API}/users/me?${param}=${encodeURIComponent(apiKey)}`,
          { credentials: 'omit' });
        report(out, `?${param}= query auth`, res.ok ? 'accepted' : `rejected (${res.status})`,
          res.ok ? 'ok' : 'info',
          res.ok ? 'Video elements can authenticate without a cookie.' : undefined);
      } catch (err) {
        report(out, `?${param}= query auth`, `error — ${err.message}`, 'warn');
      }
    }
  } else {
    report(out, 'x-api-key header', 'no key stored', 'info');
  }

  // Range support decides whether seeking works at all.
  const first = fixtures[0];
  if (first) {
    try {
      const res = await fetch(originalUrl(first.id), {
        credentials: 'same-origin',
        headers: { Range: 'bytes=0-1023' },
      });
      const ok = res.status === 206;
      report(out, 'range requests', `${res.status} ${res.statusText}`, ok ? 'ok' : 'warn',
        `content-type: ${res.headers.get('content-type') || 'none'} · ` +
        `accept-ranges: ${res.headers.get('accept-ranges') || 'none'}`);
    } catch (err) {
      report(out, 'range requests', `error — ${err.message}`, 'fail');
    }
  }
}

/* ------------------------------------------------------- 2 · capabilities */

async function probeCaps() {
  const out = $('#caps-report');
  out.textContent = '';

  report(out, 'user agent', navigator.userAgent, 'info');

  if (!navigator.xr) {
    report(out, 'navigator.xr', 'absent', 'fail', 'No WebXR in this browser. Open on the headset.');
    return;
  }
  report(out, 'navigator.xr', 'present', 'ok');

  for (const mode of ['immersive-vr', 'immersive-ar']) {
    try {
      const supported = await navigator.xr.isSessionSupported(mode);
      report(out, mode, supported ? 'supported' : 'not supported', supported ? 'ok' : 'info');
      if (mode === 'immersive-vr' && supported) $('#enter').disabled = false;
    } catch (err) {
      report(out, mode, `error — ${err.message}`, 'warn');
    }
  }

  // The headline question: are media layers exposed at all?
  const hasMedia = typeof window.XRMediaBinding === 'function';
  report(out, 'XRMediaBinding', hasMedia ? 'present' : 'absent', hasMedia ? 'ok' : 'fail',
    hasMedia ? undefined : 'Falls back to the WebGL two-eye path, with the quality cost Meta warns about.');

  if (hasMedia) {
    const methods = ['createQuadLayer', 'createCylinderLayer', 'createEquirectLayer'];
    const present = methods.filter((m) => typeof XRMediaBinding.prototype[m] === 'function');
    report(out, 'media layer types', present.join(', ') || 'none',
      present.length === methods.length ? 'ok' : 'warn');
  }

  const hasGL = typeof window.XRWebGLBinding === 'function';
  report(out, 'XRWebGLBinding', hasGL ? 'present' : 'absent', hasGL ? 'ok' : 'warn');
  if (hasGL) {
    const methods = ['createProjectionLayer', 'createQuadLayer', 'createEquirectLayer',
      'createCubeLayer', 'createCylinderLayer'];
    const present = methods.filter((m) => typeof XRWebGLBinding.prototype[m] === 'function');
    report(out, 'WebGL layer types', present.join(', ') || 'none', present.length ? 'ok' : 'warn');
  }

  for (const iface of ['XRLayer', 'XRQuadLayer', 'XREquirectLayer', 'XRCompositionLayer']) {
    report(out, iface, typeof window[iface] !== 'undefined' ? 'defined' : 'undefined',
      typeof window[iface] !== 'undefined' ? 'ok' : 'info');
  }
}

/* ------------------------------------------------------------- 3 · codecs */

const CODECS = [
  { label: 'H.264 High (avc1.640028)', type: 'video/mp4; codecs="avc1.640028"' },
  { label: 'HEVC Main hvc1 (camcorder SBS)', type: 'video/mp4; codecs="hvc1.1.6.L120.B0"' },
  { label: 'HEVC Main hev1', type: 'video/mp4; codecs="hev1.1.6.L120.B0"' },
  { label: 'AV1 Main (av01.0.08M.08)', type: 'video/mp4; codecs="av01.0.08M.08"' },
];

// The two shapes that actually matter in this library.
const PROFILES = [
  { label: 'SBS 3840x1080@60 HEVC ~19.6 Mbps',
    type: 'video/mp4; codecs="hvc1.1.6.L120.B0"', width: 3840, height: 1080, framerate: 59.94, bitrate: 19595492 },
  { label: '360 4096x2048@30 H.264',
    type: 'video/mp4; codecs="avc1.640028"', width: 4096, height: 2048, framerate: 30, bitrate: 15000000 },
  { label: 'SBS 3840x1080@60 H.264 (transcode option)',
    type: 'video/mp4; codecs="avc1.640028"', width: 3840, height: 1080, framerate: 59.94, bitrate: 25000000 },
];

async function probeCodecs() {
  const out = $('#codec-report');
  out.textContent = '';
  const v = document.createElement('video');

  for (const c of CODECS) {
    const answer = v.canPlayType(c.type) || 'no';
    report(out, c.label, answer, answer === 'probably' ? 'ok' : answer === 'maybe' ? 'warn' : 'fail');
  }

  if (!navigator.mediaCapabilities?.decodingInfo) {
    report(out, 'mediaCapabilities', 'unavailable', 'warn');
    return;
  }
  for (const p of PROFILES) {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: { contentType: p.type, width: p.width, height: p.height, bitrate: p.bitrate, framerate: p.framerate },
      });
      const status = info.supported ? (info.smooth ? 'ok' : 'warn') : 'fail';
      report(out, p.label,
        `supported:${info.supported} smooth:${info.smooth} efficient:${info.powerEfficient}`, status,
        info.supported && !info.smooth ? 'Decodes, but not at full rate — expect judder or a transcode.' : undefined);
    } catch (err) {
      report(out, p.label, `error — ${err.message}`, 'warn');
    }
  }
}

/* ---------------------------------------------------------- 4 · VR probes */

function fixtureLayout(fixture) {
  const forced = $('#stereo').value;
  if (forced !== 'auto') return forced;
  if (fixture.stereo === 'left-right') return 'stereo-left-right';
  return 'mono';
}


/* Preflight the media URL over plain HTTP before asking a <video> element to
 * load it. A media element reports every failure as MEDIA_ERR_SRC_NOT_SUPPORTED
 * (code 4) whether the cause was a 401, a broken Range response or a codec it
 * cannot decode, which makes the element itself useless as a diagnostic. */
async function preflight(out, url) {
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Range: 'bytes=0-65535' },
      cache: 'no-store',
    });
    const ct = res.headers.get('content-type') || 'none';
    const cr = res.headers.get('content-range') || 'none';
    const ok = res.status === 206;
    report(out, 'media preflight', `${res.status} ${res.statusText}`,
      ok ? 'ok' : res.status === 200 ? 'warn' : 'fail',
      `content-type: ${ct} · content-range: ${cr}`);
    if (res.status === 401 || res.status === 403) {
      report(out, 'diagnosis', 'not authenticated for media', 'fail',
        'The session cookie is not reaching the asset endpoint. Log into Immich in this browser.');
      return false;
    }
    if (res.status === 200) {
      report(out, 'diagnosis', 'no range support on this path', 'warn',
        'Playback may work but seeking will not.');
    }
    if (!ct.startsWith('video/') && !ct.startsWith('application/octet-stream')) {
      report(out, 'diagnosis', `unexpected content-type: ${ct}`, 'fail',
        'Something is answering in place of the asset — a login page or an error document.');
      return false;
    }
    return res.status === 206 || res.status === 200;
  } catch (err) {
    report(out, 'media preflight', `failed — ${err.message}`, 'fail');
    return false;
  }
}

const MEDIA_ERR = {
  1: 'MEDIA_ERR_ABORTED — fetch aborted',
  2: 'MEDIA_ERR_NETWORK — network failed mid-load',
  3: 'MEDIA_ERR_DECODE — data corrupt or codec unsupported after starting',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED — source rejected before decode',
};

async function enterXR() {
  const out = $('#session-report');
  out.textContent = '';
  const fixture = fixtures.find((f) => f.id === $('#asset').value);
  const mode = $('#mode').value;
  if (!fixture) return;

  log(`entering immersive-vr · fixture="${fixture.label}" · path=${mode}`);

  const video = $('#video');
  const url = originalUrl(fixture.id);
  const reachable = await preflight(out, url);

  video.src = url;
  video.loop = true;
  // Entering an immersive session is a user activation, so unmuted playback is
  // normally allowed. xr.js falls back to muted if the browser refuses, and says
  // that it did.
  video.muted = !$('#sound').checked;
  video.load();

  let decoded = false;
  try {
    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const bad = () => {
        cleanup();
        const code = video.error?.code;
        reject(new Error(MEDIA_ERR[code] || `unknown media error (${code})`));
      };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', ok);
        video.removeEventListener('error', bad);
      };
      video.addEventListener('loadedmetadata', ok, { once: true });
      video.addEventListener('error', bad, { once: true });
      setTimeout(() => { cleanup(); reject(new Error('timed out after 20s')); }, 20000);
    });
    decoded = true;
    report(out, 'video decode', `${video.videoWidth}x${video.videoHeight}`, 'ok',
      `Expected ${fixture.width}x${fixture.height}.`);
    const claimed = fixture.seconds;
    const actual = video.duration;
    const agrees = !claimed || !Number.isFinite(actual) || Math.abs(actual - claimed) < Math.max(0.5, claimed * 0.05);
    report(out, 'duration', `${Number.isFinite(actual) ? actual.toFixed(2) : '?'} s`,
      agrees ? 'ok' : 'warn',
      claimed ? `Fixture claims ${claimed} s.${agrees ? '' : ' The label is wrong, not the playback.'}` : undefined);
    log(`video metadata ok: ${video.videoWidth}x${video.videoHeight}`);
    log('video element state:', JSON.stringify(videoState(video)));
  } catch (err) {
    report(out, 'video decode', `failed — ${err.message}`, 'fail',
      reachable
        ? 'The bytes arrived over HTTP but the element refused them. With a preflight of 206 and a ' +
          'video content-type, suspect the codec, or a service worker rewriting the response.'
        : 'The preflight above already failed, so this is not a codec problem.');
    log('video failed:', err.message);
    log('video element state:', JSON.stringify(videoState(video)));
    telemetry.flush('decode-failure');
  }

  // Enter the session regardless. A failed decode still gets a grid and a status
  // board explaining why, and a working exit — better than a black void.
  $('#enter').disabled = true;
  $('#exit').disabled = false;
  try {
    const handle = await XRProbe.run({
      playlist: [fixture],
      index: 0,
      urlFor: (it) => originalUrl(it.id),
      mode,
      forcedLayout: $('#stereo').value,
      widthM: Number($('#width').value),
      distM: Number($('#dist').value),
      showGrid: $('#grid').checked,
      wantSound: $('#sound').checked,
      passthrough: $('#passthrough').checked,
      video,
      report: (k, v, s, n) => report(out, k, v, s, n),
      log,
      flush: (reason) => telemetry.flush(reason),
      onEnd: ({ frames, uploadMs }) => {
        report(out, 'frames served', String(frames), 'info');
        if (mode === 'webgl' && frames) {
          report(out, 'avg texture upload', `${(uploadMs / frames).toFixed(2)} ms/frame`, 'info',
            'The per-frame cost the media layer path avoids.');
        }
        session = null;
        $('#enter').disabled = false;
        $('#exit').disabled = true;
        log('video element state at exit:', JSON.stringify(videoState($('#video'))));
        telemetry.flush('session-end');
      },
    });
    session = handle.session;
  } catch (err) {
    report(out, 'requestSession', `failed — ${err.message}`, 'fail');
    log('requestSession failed:', err.message);
    $('#enter').disabled = false;
    $('#exit').disabled = true;
  }
}

/* Take this scope back from Immich's service worker, which intercepts
 * /api/assets/<id>/original and dedupes by URL alone — wrong for the successive
 * Range requests a <video> element makes. A worker registered at /vr/ has a
 * longer matching scope, so it wins for these pages, and it handles no fetches. */
async function claimServiceWorkerScope(out) {
  if (!('serviceWorker' in navigator)) {
    report(out, 'service worker', 'unsupported', 'info');
    return;
  }
  try {
    // Scope '/vr' rather than './': the page may be loaded as /vr with no
    // trailing slash, which is not inside scope /vr/. Needs the
    // Service-Worker-Allowed header nginx sets on sw.js.
    await navigator.serviceWorker.register('sw.js', { scope: '/vr' });

    // Our worker calls clients.claim() on activate, so it takes control of this
    // page without a reload — but that is asynchronous, so wait for the
    // controllerchange rather than assuming. Bounded: navigator.serviceWorker
    // .ready can hang indefinitely, and blocking boot on it left the whole page
    // blank once already.
    const isOurs = () => !!navigator.serviceWorker.controller?.scriptURL.endsWith('/vr/sw.js');
    if (!isOurs()) {
      await Promise.race([
        new Promise((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }

    const ctrl = navigator.serviceWorker.controller;
    if (isOurs()) {
      report(out, 'service worker', 'ours (/vr/sw.js)', 'ok',
        "Immich's worker is out of the path for this page, so media requests go straight to the network.");
    } else if (ctrl) {
      report(out, 'service worker', `Immich's — ${ctrl.scriptURL}`, 'warn',
        'It intercepts /api/assets/<id>/original and dedupes by URL, which breaks the range ' +
        'requests a video element makes. Reload once to hand this page to ours.');
    } else {
      report(out, 'service worker', 'none controlling this page', 'ok',
        'Nothing is intercepting requests. Reload to activate ours, though nothing needs it.');
    }
  } catch (err) {
    report(out, 'service worker', `registration failed — ${err.message}`, 'warn');
  }
}

/* ------------------------------------------------------------- fixtures */

/* Test clips. A test-assets.json beside this page, if present, names them
 * explicitly; otherwise they are picked from the same albums the player uses —
 * the shortest clip of five seconds or more from each, which loads quickly and
 * is enough to judge stereo, plus the longest side-by-side clip as a soak test. */
const PROBE_ALBUMS = [
  { album: 'VR 3D-SBS', label: 'SBS', projection: 'flat', stereo: 'left-right', soak: true },
  { album: 'VR 360', label: '360', projection: 'equirect360', stereo: 'mono' },
  { album: 'VR Spatial', label: 'spatial MV-HEVC (expect flat)', projection: 'flat', stereo: 'mv-hevc' },
];

async function loadFixtures() {
  try {
    const res = await fetch('test-assets.json', { cache: 'no-store' });
    if (res.ok) {
      const list = (await res.json()).assets || [];
      if (list.length) return list;
    }
  } catch { /* optional file */ }

  const opts = { credentials: 'same-origin', headers: authHeaders() };
  const albums = await (await fetch(`${API}/albums`, opts)).json();
  const out = [];
  for (const c of PROBE_ALBUMS) {
    const album = albums.find((a) => a.albumName === c.album);
    if (!album) continue;
    const res = await fetch(`${API}/search/metadata`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ albumIds: [album.id], type: 'VIDEO', size: 500, withExif: true }),
    });
    if (!res.ok) continue;
    const vids = (((await res.json()).assets || {}).items || [])
      .filter((a) => a.duration > 0)
      .sort((a, b) => a.duration - b.duration);
    const picks = [vids.find((a) => a.duration >= 5000) || vids[0]];
    if (c.soak && vids.length > 1) picks.push(vids[vids.length - 1]);
    for (const a of new Set(picks.filter(Boolean))) {
      out.push({
        id: a.id,
        label: `${c.label}, ${Math.round(a.duration / 1000)}s — ${a.originalFileName}`,
        kind: 'video',
        projection: c.projection,
        stereo: c.stereo,
        width: a.width || 1920,
        height: a.height || 1080,
        codec: '',
        seconds: a.duration / 1000,
        bytes: a.exifInfo?.fileSizeInByte,
      });
    }
  }
  if (!out.length) {
    throw new Error('no test-assets.json, and none of the VR albums were found — run tools/backfill-albums.py');
  }
  return out;
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  $('#width-out').value = `${$('#width').value} m`;
  $('#dist-out').value = `${$('#dist').value} m`;
  $('#width').addEventListener('input', (e) => { $('#width-out').value = `${e.target.value} m`; });
  $('#dist').addEventListener('input', (e) => { $('#dist-out').value = `${e.target.value} m`; });

  $('#apikey').value = apiKey;
  $('#save-key').addEventListener('click', () => {
    apiKey = $('#apikey').value.trim();
    localStorage.setItem(LS_KEY, apiKey);
    log('api key saved to localStorage');
    probeAuth();
  });
  $('#clear-key').addEventListener('click', () => {
    apiKey = ''; $('#apikey').value = '';
    localStorage.removeItem(LS_KEY);
    probeAuth();
  });
  $('#recheck').addEventListener('click', probeAuth);
  $('#enter').addEventListener('click', enterXR);
  $('#exit').addEventListener('click', () => session?.end());
  $('#clear-log').addEventListener('click', () => { logEl.textContent = ''; });
  $('#copy-log').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(logEl.textContent); log('log copied'); }
    catch (err) { log('clipboard refused:', err.message); }
  });

  try {
    fixtures = await loadFixtures();
    const sel = $('#asset');
    for (const f of fixtures) {
      const opt = document.createElement('option');
      opt.value = f.id;
      const size = f.bytes ? `, ${bytes(f.bytes)}` : '';
      opt.textContent = `${f.label} — ${f.width}x${f.height}${f.codec ? ` ${f.codec}` : ''}${size}`;
      sel.append(opt);
    }
    log(`loaded ${fixtures.length} fixtures`);
  } catch (err) {
    log('could not load fixtures:', err.message);
  }

  // Each phase is isolated: a probe that throws must not take the rest of the
  // page with it. A blank report is the one outcome with no diagnostic value.
  for (const [name, fn] of [
    ['service worker', () => claimServiceWorkerScope($('#auth-report'))],
    ['auth', probeAuth],
    ['capabilities', probeCaps],
    ['codecs', probeCodecs],
  ]) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 15s')), 15000)),
      ]);
    } catch (err) {
      log(`!${name} probe failed: ${err.message}`);
      report($('#auth-report'), `${name} probe`, `failed — ${err.message}`, 'fail');
    }
  }
  log('static probes complete — put the headset on and press Enter VR');
  telemetry.flush('boot');
}

boot().catch((err) => {
  log(`!boot failed: ${err.message}`);
  try {
    report($('#auth-report'), 'boot', `failed — ${err.message}`, 'fail',
      'The page could not finish starting. This row and the log below are what there is to go on.');
    telemetry.flush('boot-failure');
  } catch { /* nothing left to report with */ }
});
