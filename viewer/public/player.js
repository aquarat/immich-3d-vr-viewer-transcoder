/* The viewer. Collections come from Immich tags, so what appears here is
 * whatever is tagged in Immich — curate it there and this follows.
 */
'use strict';

const $ = (sel) => document.querySelector(sel);

/* Each collection names an Immich album and says how its media is shaped.
 * Immich has no stereo metadata of its own, so this mapping is the whole
 * convention. Albums rather than tags because metadata extraction replaces an
 * asset's tags from the file's own XMP, which quietly eats anything applied by
 * hand; album membership is not derived from file metadata. */
const COLLECTIONS = [
  { album: 'VR 3D-SBS', label: '3D side-by-side', projection: 'flat', stereo: 'left-right' },
  { album: 'VR 360', label: '360°', projection: 'equirect360', stereo: 'mono' },
  {
    album: 'VR Spatial',
    label: 'Spatial',
    projection: 'flat',
    stereo: 'mono',
    note: 'iPhone MV-HEVC. The browser decodes the base view only, so these look flat ' +
          'until the server-side side-by-side conversion runs.',
  },
];

let albumsByName = new Map();
const loadedCounts = new Map();
let collection = null;
let assets = [];
let selected = 0;
let handle = null;
let switchedTo = null;      // a collection picked in the headset's browser

/* What the in-VR browser can offer: every collection that has an album, and a
 * way to load one on demand. */
function catalogFor() {
  const known = COLLECTIONS.filter((c) => albumsByName.has(c.album));
  return {
    collections: known.map((c) => ({ name: c.album, label: c.label })),
    current: collection.album,
    load: async (name) => {
      const c = COLLECTIONS.find((x) => x.album === name);
      const found = await immich.assetsByAlbum(albumsByName.get(name).id);
      return found.filter((a) => a.type === 'VIDEO' || a.type === 'IMAGE').map((a) => toItem(a, c));
    },
  };
}

/* --------------------------------------------------------------- display */

function status(key, value, level = 'info', note) {
  const out = $('#status');
  const row = document.createElement('div');
  row.className = `r ${level}`;
  const k = document.createElement('div'); k.className = 'k'; k.textContent = key;
  const v = document.createElement('div'); v.className = 'v'; v.textContent = String(value);
  row.append(k, v);
  if (note) {
    const n = document.createElement('div'); n.className = 'note'; n.textContent = note;
    row.append(n);
  }
  out.append(row);
  telemetry.row(key, value, level, note);
  // A lost WebGL context stays lost for the life of the page, and every
  // subsequent session fails at getContext. Only a reload clears it.
  if (level === 'fail' && /webgl/i.test(key)) {
    $('#reload').hidden = false;
    $('#selection').textContent =
      'WebGL is unavailable — close the Quest Browser completely and reopen it. ' +
      'Video plays without it; photos and the grid do not.';
  }
}

telemetry.sink = (line) => {
  const el = $('#log');
  el.textContent += `${line}\n`;
  el.scrollTop = el.scrollHeight;
};

const seconds = (ms) => (typeof ms === 'number' && ms > 0 ? `${(ms / 1000).toFixed(0)}s` : '');

function renderCollections() {
  const bar = $('#collections');
  bar.textContent = '';
  for (const c of COLLECTIONS) {
    const album = albumsByName.get(c.album);
    const btn = document.createElement('button');
    btn.className = 'chip';
    const n = loadedCounts.get(c.album) ?? album?.assetCount;
    btn.textContent = album ? `${c.label}${n === undefined ? '' : ` · ${n}`}` : `${c.label} · none`;
    btn.disabled = !album;
    btn.setAttribute('aria-pressed', String(collection?.album === c.album));
    btn.addEventListener('click', () => selectCollection(c));
    bar.append(btn);
  }
}

/* Thumbnails load only while they are near the viewport, and are released
 * again once well clear of it. A collection here can be several hundred assets,
 * and decoding that many images at once on the headset exhausts the renderer —
 * which showed up as WebGL2 being unavailable when the session tried to start,
 * followed by the tab reloading. */
let thumbObserver = null;

function renderGrid() {
  const view = $('#grid-view');
  thumbObserver?.disconnect();
  view.textContent = '';
  $('#empty').hidden = assets.length > 0;
  if (!assets.length) {
    $('#empty').textContent = `Album "${collection?.album}" is empty. Run tools/backfill-albums.py, or add assets to it in Immich.`;
    return;
  }

  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const img = e.target.querySelector('img');
      if (!img) continue;
      if (e.isIntersecting) {
        if (!img.src) img.src = img.dataset.src;
      } else if (img.src) {
        img.removeAttribute('src');
      }
    }
  }, { rootMargin: '400px 0px' });

  assets.forEach((a, i) => {
    const fig = document.createElement('figure');
    fig.className = 'thumb';
    fig.setAttribute('aria-selected', String(i === selected));
    fig.tabIndex = 0;
    const img = document.createElement('img');
    img.alt = a.originalFileName || '';
    img.dataset.src = immich.thumbUrl(a.id);
    const cap = document.createElement('figcaption');
    const mark = a.type === 'IMAGE' ? '◍ ' : '';
    cap.textContent = `${mark}${a.originalFileName || a.id.slice(0, 8)} ${seconds(a.duration)}`;
    fig.append(img, cap);
    const pick = () => { selected = i; markSelected(); updateSelection(); };
    fig.addEventListener('click', pick);
    // Double tap goes straight in, rather than tap-then-find-the-button.
    fig.addEventListener('dblclick', () => { pick(); enter(); });
    fig.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); pick(); enter(); }
      else if (e.key === ' ') { e.preventDefault(); pick(); }
    });
    view.append(fig);
    thumbObserver.observe(fig);
  });
}

/* Re-rendering the whole grid to move a highlight would throw away every loaded
 * thumbnail, so selection is updated in place. */
function markSelected() {
  const figs = $('#grid-view').children;
  for (let i = 0; i < figs.length; i++) {
    figs[i].setAttribute('aria-selected', String(i === selected));
  }
  figs[selected]?.scrollIntoView({ block: 'nearest' });
}

function updateSelection() {
  const a = assets[selected];
  $('#selection').textContent = a
    ? `starting at ${selected + 1} of ${assets.length} — ${a.originalFileName || a.id}`
    : '';
}

/* ------------------------------------------------------------------ data */

function toItem(asset, c = collection) {
  return {
    id: asset.id,
    kind: asset.type === 'IMAGE' ? 'image' : 'video',
    label: asset.originalFileName || asset.id.slice(0, 8),
    // Falling back to 16:9 keeps a missing dimension from producing a zero-area
    // quad; the layer would be rejected outright.
    width: asset.width || 1920,
    height: asset.height || 1080,
    projection: c.projection,
    stereo: c.stereo,
    seconds: typeof asset.duration === 'number' ? asset.duration / 1000 : null,
    codec: '',
  };
}

async function selectCollection(c) {
  collection = c;
  selected = 0;
  renderCollections();
  const album = albumsByName.get(c.album);
  if (!album) return;
  $('#grid-view').textContent = '';
  $('#empty').hidden = false;
  $('#empty').textContent = 'loading…';
  try {
    const found = await immich.assetsByAlbum(album.id);
    assets = found.filter((a) => a.type === 'VIDEO' || a.type === 'IMAGE');
    loadedCounts.set(c.album, assets.length);
    renderCollections();
    const videos = assets.filter((a) => a.type === 'VIDEO').length;
    log(`${c.album}: ${found.length} assets, ${videos} video, ${assets.length - videos} photo`);
  } catch (err) {
    assets = [];
    status(c.album, `could not list — ${err.message}`, 'fail');
  }
  renderGrid();
  updateSelection();
  $('#enter').disabled = !assets.length;
}

/* ---------------------------------------------------------------- the vr */

/* Hand the renderer its memory back before asking for an XR context and a
 * 3840x1080 decoder. The grid is rebuilt on exit. */
function releaseThumbs() {
  thumbObserver?.disconnect();
  for (const img of $('#grid-view').querySelectorAll('img[src]')) img.removeAttribute('src');
}

async function enter() {
  if (!assets.length) return;
  $('#enter').disabled = true;
  $('#exit').disabled = false;
  releaseThumbs();
  const playlist = assets.map((a) => toItem(a, collection));
  switchedTo = null;
  log(`entering VR · ${collection.album} · ${playlist.length} items · starting at ${selected + 1}`);
  try {
    handle = await XRProbe.run({
      playlist,
      index: selected,
      urlFor: (it) => immich.originalUrl(it.id),
      mode: $('#mode').value,
      forcedLayout: $('#stereo').value,
      widthM: Number($('#width').value),
      distM: Number($('#dist').value),
      showGrid: $('#grid').checked,
      wantSound: $('#sound').checked,
      passthrough: $('#passthrough').checked,
      maxTexture: Number($('#texture').value),
      photoPath: $('#photo-path').value,
      video: $('#video'),
      report: (k, v, s, n) => status(k, v, s, n),
      log,
      flush: (reason) => telemetry.flush(reason),
      catalog: catalogFor(),
      thumbUrlFor: (it) => immich.thumbUrl(it.id),
      onCollection: (name) => { switchedTo = COLLECTIONS.find((c) => c.album === name) || null; },
      onIndex: (i) => {
        selected = i;
        if (!switchedTo) { markSelected(); updateSelection(); }
      },
      onEnd: async () => {
        handle = null;
        $('#enter').disabled = false;
        $('#exit').disabled = true;
        // If a different collection was picked in the headset, come back to it,
        // with the clip that was playing selected.
        if (switchedTo && switchedTo !== collection) {
          const last = selected;
          await selectCollection(switchedTo);
          selected = Math.min(last, Math.max(0, assets.length - 1));
          markSelected();
        } else {
          renderGrid();
        }
        switchedTo = null;
        updateSelection();
        telemetry.flush('session-end');
      },
    });
  } catch (err) {
    status('enter vr', `failed — ${err.message}`, 'fail');
    log(`!enter vr failed: ${err.message}`);
    $('#enter').disabled = false;
    $('#exit').disabled = true;
    renderGrid();
    telemetry.flush('enter-failure');
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  $('#width-out').value = `${$('#width').value} m`;
  $('#dist-out').value = `${$('#dist').value} m`;
  $('#width').addEventListener('input', (e) => { $('#width-out').value = `${e.target.value} m`; });
  $('#dist').addEventListener('input', (e) => { $('#dist-out').value = `${e.target.value} m`; });
  $('#enter').addEventListener('click', enter);
  $('#exit').addEventListener('click', () => handle?.end());
  $('#reload').addEventListener('click', () => location.reload());

  const noteLayout = () => {
    let has = false;
    try { has = !!localStorage.getItem('immich-vr.layout'); } catch { /* unavailable */ }
    $('#layout-note').textContent = has
      ? 'Using the positions you last arranged in the headset; distance applies after a reset.'
      : 'Default positions: video ahead, controls docked beneath it.';
  };
  noteLayout();
  $('#reset-layout').addEventListener('click', () => {
    try { localStorage.removeItem('immich-vr.layout'); } catch { /* unavailable */ }
    noteLayout();
    log('layout reset to defaults');
  });

  const sw = await claimServiceWorkerScope();
  if (sw !== 'ours') {
    status('service worker', sw, 'warn',
      "Immich's worker breaks the range requests video playback needs. Reload once to hand this page to ours.");
  }

  if (!navigator.xr) {
    status('webxr', 'not available in this browser', 'fail',
      'Open this page in the Quest Browser.');
  } else if (!(await navigator.xr.isSessionSupported('immersive-vr'))) {
    status('webxr', 'immersive-vr not supported', 'fail');
  }

  try {
    const me = await immich.me();
    $('#who').textContent = me.email;
  } catch (err) {
    $('#who').textContent = 'not signed in';
    status('immich', `not authenticated — ${err.message}`, 'fail',
      'Log into Immich in this browser, then reload.');
    return;
  }

  try {
    const albums = await immich.albums();
    albumsByName = new Map(albums.map((a) => [a.albumName, a]));
    const known = COLLECTIONS.filter((c) => albumsByName.has(c.album));
    renderCollections();
    if (!known.length) {
      status('collections', 'no VR albums found', 'fail',
        `Expected albums: ${COLLECTIONS.map((c) => c.album).join(', ')}. ` +
        'Run tools/backfill-albums.py --apply to create them.');
      return;
    }
    await selectCollection(known[0]);
  } catch (err) {
    status('albums', `could not load — ${err.message}`, 'fail');
  }
  telemetry.flush('boot');
}

boot().catch((err) => {
  status('boot', `failed — ${err.message}`, 'fail');
  telemetry.flush('boot-failure');
});
