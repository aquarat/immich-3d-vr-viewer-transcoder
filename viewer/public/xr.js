/* Immersive runtime for the probe.
 *
 * Design rule after the first headset run: the session must NEVER present an
 * empty layer stack. A black void with no input handling is unrecoverable
 * without force-quitting the browser. So a WebGL projection layer carrying a
 * floor grid and a status board is created first and kept for the life of the
 * session; the media layer, if it can be made at all, composites on top of it.
 * Failures are drawn into that board rather than only logged to the 2D page.
 */
'use strict';

(function (global) {

  /* ---------------------------------------------------------------- matrices */

  const mul = (a, b) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                       a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  };
  const translate = (x, y, z) => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
  const IDENTITY = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  const rotY = (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
  };
  const scale = (x, y, z) => new Float32Array([x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1]);

  /* ------------------------------------------------------------------ shaders */

  const compile = (gl, type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const link = (gl, vsSrc, fsSrc) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  };

  const SOLID_VS = `#version 300 es
    in vec3 pos; uniform mat4 mvp;
    void main(){ gl_Position = mvp * vec4(pos, 1.0); }`;
  const SOLID_FS = `#version 300 es
    precision mediump float; uniform vec4 color; out vec4 o;
    void main(){ o = color; }`;
  const TEX_VS = `#version 300 es
    in vec2 pos; out vec2 uv; uniform mat4 mvp; uniform vec4 uvXform;
    void main(){ uv = (pos * 0.5 + 0.5) * uvXform.zw + uvXform.xy;
                 uv.y = 1.0 - uv.y;
                 gl_Position = mvp * vec4(pos, 0.0, 1.0); }`;
  const TEX_FS = `#version 300 es
    precision mediump float; in vec2 uv; uniform sampler2D tex; out vec4 o;
    void main(){ o = texture(tex, uv); }`;
  // Explicit texture coordinates, unlike the quad program, which derives them
  // from position and flips Y.
  const MESH_VS = `#version 300 es
    in vec3 pos; in vec2 tc; out vec2 uv; uniform mat4 mvp; uniform vec4 uvXform;
    void main(){ uv = tc * uvXform.zw + uvXform.xy; gl_Position = mvp * vec4(pos, 1.0); }`;

  /* -------------------------------------------------------------------- scene */

  function createScene(gl) {
    const solid = link(gl, SOLID_VS, SOLID_FS);
    const textured = link(gl, TEX_VS, TEX_FS);
    const mesh = link(gl, MESH_VS, TEX_FS);

    /* An equirectangular sphere, drawn from the inside and centred on the head.
     *
     * The mapping is derived rather than guessed: the viewer looks down -Z, so
     * the image centre (u = 0.5) must land at (0, 0, -R), and turning right
     * (towards +X) must advance u. That gives theta = (u - 0.5) * 2pi with
     * x = sin(theta), z = -cos(theta); v runs from 0 at the top, which is the
     * first row of the decoded image. */
    const SEG_W = 64, SEG_H = 32;
    const spherePos = [], sphereUv = [], sphereIdx = [];
    for (let i = 0; i <= SEG_H; i++) {
      const v = i / SEG_H, phi = v * Math.PI;
      for (let j = 0; j <= SEG_W; j++) {
        const u = j / SEG_W, theta = (u - 0.5) * 2 * Math.PI;
        spherePos.push(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
        sphereUv.push(u, v);
      }
    }
    for (let i = 0; i < SEG_H; i++) {
      for (let j = 0; j < SEG_W; j++) {
        const a = i * (SEG_W + 1) + j, b = a + SEG_W + 1;
        sphereIdx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const spherePosBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, spherePosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(spherePos), gl.STATIC_DRAW);
    const sphereUvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, sphereUvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sphereUv), gl.STATIC_DRAW);
    const sphereIdxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(sphereIdx), gl.STATIC_DRAW);
    const sphereCount = sphereIdx.length;

    // Floor grid, 20 m across at 0.5 m spacing, plus a waist-height horizon ring
    // so there is a depth cue even when looking straight ahead.
    const lines = [];
    const EXT = 10, STEP = 0.5;
    for (let i = -EXT; i <= EXT; i += STEP) {
      lines.push(i, 0, -EXT, i, 0, EXT);
      lines.push(-EXT, 0, i, EXT, 0, i);
    }
    for (let a = 0; a < 64; a++) {
      const t0 = (a / 64) * Math.PI * 2, t1 = ((a + 1) / 64) * Math.PI * 2;
      lines.push(Math.cos(t0) * 6, 1.3, Math.sin(t0) * 6, Math.cos(t1) * 6, 1.3, Math.sin(t1) * 6);
    }
    const gridBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    const gridCount = lines.length / 3;

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    // Status board: a 2D canvas uploaded as a texture. Reading an error in the
    // headset beats taking it off to find out why the screen was black.
    const board = document.createElement('canvas');
    board.width = 1024; board.height = 384;
    const ctx = board.getContext('2d');
    const boardTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, boardTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let boardDirty = true;
    let boardLines = [];
    let progress = null;   // { bufferedFrac, playFrac, label } or null to hide

    const videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    function setStatus(linesIn) {
      boardLines = linesIn;
      boardDirty = true;
    }

    let lastProgressDraw = 0;
    function setProgress(next) {
      // Redraw only on a visible change: the board is a canvas upload, and doing
      // that every frame for a moving bar is not worth the bandwidth.
      const now = Date.now();
      let changed = !progress !== !next || (next && progress && (
        Math.abs(next.bufferedFrac - progress.bufferedFrac) > 0.005 ||
        Math.abs(next.playFrac - progress.playFrac) > 0.004 ||
        next.label !== progress.label));
      // The indeterminate sweep animates with no state change, so tick it.
      if (next && next.bufferedFrac < 0 && now - lastProgressDraw > 80) changed = true;
      progress = next;
      if (changed) { boardDirty = true; lastProgressDraw = now; }
    }

    function redrawBoard() {
      ctx.fillStyle = '#12131a';
      ctx.fillRect(0, 0, board.width, board.height);
      ctx.strokeStyle = '#3b4256';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, board.width - 4, board.height - 4);
      ctx.textBaseline = 'top';
      let y = 28;
      boardLines.forEach((line, i) => {
        const head = i === 0;
        ctx.fillStyle = head ? '#e6e8f0' : (line.startsWith('!') ? '#f87171' : '#9aa0b4');
        ctx.font = head ? '600 40px system-ui, sans-serif' : '30px system-ui, sans-serif';
        ctx.fillText(line.replace(/^!/, ''), 32, y);
        y += head ? 56 : 40;
      });
      if (progress) {
        const x = 32, w = board.width - 64, y = board.height - 72, h = 22;
        ctx.fillStyle = '#9aa0b4';
        ctx.font = '26px system-ui, sans-serif';
        ctx.fillText(progress.label, x, y - 34);
        ctx.fillStyle = '#262a37';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#3b4256';                     // buffered
        ctx.fillRect(x, y, w * Math.min(1, Math.max(0, progress.bufferedFrac)), h);
        ctx.fillStyle = '#60a5fa';                     // playhead
        ctx.fillRect(x, y, w * Math.min(1, Math.max(0, progress.playFrac)), h);
        if (progress.bufferedFrac < 0) {
          // Indeterminate: nothing known yet, so sweep rather than sit at zero.
          const t = (Date.now() % 1400) / 1400;
          ctx.fillStyle = '#60a5fa';
          ctx.fillRect(x + (w - w * 0.25) * t, y, w * 0.25, h);
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, boardTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, board);
      boardDirty = false;
    }

    function drawGrid(viewProj) {
      gl.useProgram(solid);
      gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
      const loc = gl.getAttribLocation(solid, 'pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(gl.getUniformLocation(solid, 'mvp'), false, viewProj);
      gl.uniform4f(gl.getUniformLocation(solid, 'color'), 0.30, 0.34, 0.45, 1.0);
      gl.drawArrays(gl.LINES, 0, gridCount);
    }

    function drawQuad(viewProj, model, tex, uvXform) {
      gl.useProgram(textured);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      const loc = gl.getAttribLocation(textured, 'pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(textured, 'tex'), 0);
      gl.uniform4fv(gl.getUniformLocation(textured, 'uvXform'), uvXform);
      gl.uniformMatrix4fv(gl.getUniformLocation(textured, 'mvp'), false, mul(viewProj, model));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function drawBoard(viewProj) {
      if (boardDirty) redrawBoard();
      // 2.4 m wide, behind and below the media panel so the two do not fight.
      drawQuad(viewProj, mul(translate(0, 0.55, -2.4), scale(1.2, 0.45, 1)),
        boardTex, [0, 0, 1, 1]);
    }

    function drawSphere(viewProj, model, tex, uvXform) {
      gl.useProgram(mesh);
      gl.bindBuffer(gl.ARRAY_BUFFER, spherePosBuf);
      const pl = gl.getAttribLocation(mesh, 'pos');
      gl.enableVertexAttribArray(pl);
      gl.vertexAttribPointer(pl, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, sphereUvBuf);
      const tl = gl.getAttribLocation(mesh, 'tc');
      gl.enableVertexAttribArray(tl);
      gl.vertexAttribPointer(tl, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIdxBuf);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(mesh, 'tex'), 0);
      gl.uniform4fv(gl.getUniformLocation(mesh, 'uvXform'), uvXform);
      gl.uniformMatrix4fv(gl.getUniformLocation(mesh, 'mvp'), false, mul(viewProj, model));
      gl.drawElements(gl.TRIANGLES, sphereCount, gl.UNSIGNED_SHORT, 0);
    }

    return { drawGrid, drawBoard, drawQuad, drawSphere, setStatus, setProgress, videoTex };
  }


  /* ---------------------------------------------------------------- controls */

  /* The control panel is a media layer, not something we render.
   *
   * In passthrough the only thing proven stable on this browser is an
   * XRMediaBinding layer — anything drawn through WebGL there costs the context
   * after one frame. So the panel is drawn with plain Canvas2D, turned into a
   * video with captureStream(), and composited exactly like the clip itself. No
   * WebGL context is involved at any point, which also means it cannot wedge
   * the GPU process the way the drawn paths have. */
  function createPanel() {
    const W = 1024, H = 256;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.display = 'none';
    video.srcObject = canvas.captureStream(30);
    document.body.append(video);

    const BAR = { x: 40, y: 96, w: W - 80, h: 24 };
    const ROW = { y: 150, h: 86 };
    const buttons = [
      { id: 'prev', x: 40, w: 110 },
      { id: 'play', x: 172, w: 150 },
      { id: 'next', x: 344, w: 110 },
      { id: 'browse', x: 476, w: 150 },
      { id: 'link', x: 648, w: 130 },
      { id: 'exit', x: 804, w: 180 },
    ];

    function hit(px, py) {
      if (px >= BAR.x && px <= BAR.x + BAR.w && py >= BAR.y - 18 && py <= BAR.y + BAR.h + 18) {
        return { id: 'seek', frac: Math.min(1, Math.max(0, (px - BAR.x) / BAR.w)) };
      }
      for (const b of buttons) {
        if (px >= b.x && px <= b.x + b.w && py >= ROW.y && py <= ROW.y + ROW.h) return { id: b.id };
      }
      // Everything that is not a control is a handle to move the panel by.
      return { id: 'drag' };
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    // Icons as paths rather than glyphs: the headset's fonts are not something
    // to rely on for symbols.
    function icon(id, cx, cy, paused) {
      ctx.fillStyle = '#e6e8f0';
      ctx.beginPath();
      if (id === 'play' && paused) {
        ctx.moveTo(cx - 16, cy - 22); ctx.lineTo(cx + 22, cy); ctx.lineTo(cx - 16, cy + 22);
        ctx.closePath(); ctx.fill();
      } else if (id === 'play') {
        ctx.fillRect(cx - 18, cy - 22, 13, 44); ctx.fillRect(cx + 5, cy - 22, 13, 44);
      } else if (id === 'prev') {
        ctx.fillRect(cx - 22, cy - 18, 7, 36);
        ctx.moveTo(cx + 20, cy - 18); ctx.lineTo(cx - 12, cy); ctx.lineTo(cx + 20, cy + 18);
        ctx.closePath(); ctx.fill();
      } else if (id === 'next') {
        ctx.fillRect(cx + 15, cy - 18, 7, 36);
        ctx.moveTo(cx - 20, cy - 18); ctx.lineTo(cx + 12, cy); ctx.lineTo(cx - 20, cy + 18);
        ctx.closePath(); ctx.fill();
      } else if (id === 'browse') {
        for (const [ox, oy] of [[-19, -19], [3, -19], [-19, 3], [3, 3]]) ctx.fillRect(cx + ox, cy + oy, 16, 16);
      } else if (id === 'link') {
        ctx.strokeStyle = '#e6e8f0'; ctx.lineWidth = 6;
        const gap = paused ? 0 : 9;   // `paused` doubles as "unlinked" here
        ctx.beginPath(); ctx.ellipse(cx - 12 - gap, cy, 18, 12, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(cx + 12 + gap, cy, 18, 12, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }

    const fmt = (t) => {
      if (!Number.isFinite(t)) return '–:––';
      const m = Math.floor(t / 60), sec = Math.floor(t % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    };

    function draw(st) {
      ctx.fillStyle = '#12131a';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#3b4256'; ctx.lineWidth = 4;
      roundRect(2, 2, W - 4, H - 4, 22); ctx.stroke();

      ctx.textBaseline = 'middle';
      ctx.fillStyle = st.hover === 'drag' || st.moving ? '#e6e8f0' : '#5b6178';
      for (let gx = 0; gx < 2; gx++) {
        for (let gy = 0; gy < 3; gy++) {
          ctx.beginPath(); ctx.arc(34 + gx * 12, 38 + gy * 12, 3.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.fillStyle = '#e6e8f0';
      ctx.font = '600 30px system-ui, sans-serif';
      const label = st.moving || st.title;
      const title = label.length > 40 ? `${label.slice(0, 39)}…` : label;
      ctx.fillText(title, 72, 50);
      ctx.fillStyle = '#9aa0b4';
      ctx.font = '26px system-ui, sans-serif';
      const right = st.isStill ? `${st.index} / ${st.count}`
        : `${fmt(st.time)} / ${fmt(st.duration)}   ${st.index} / ${st.count}`;
      ctx.textAlign = 'right';
      ctx.fillText(right, W - 40, 50);
      ctx.textAlign = 'left';

      if (!st.isStill) {
        const bh = st.hover === 'seek' ? BAR.h + 8 : BAR.h;
        const by = BAR.y + (BAR.h - bh) / 2;
        ctx.fillStyle = '#262a37'; roundRect(BAR.x, by, BAR.w, bh, bh / 2); ctx.fill();
        if (st.duration > 0) {
          ctx.fillStyle = '#3b4256';
          roundRect(BAR.x, by, BAR.w * Math.min(1, st.buffered / st.duration), bh, bh / 2); ctx.fill();
          ctx.fillStyle = '#60a5fa';
          roundRect(BAR.x, by, Math.max(bh, BAR.w * Math.min(1, st.time / st.duration)), bh, bh / 2); ctx.fill();
        }
        if (st.hover === 'seek' && st.cursor) {
          ctx.fillStyle = '#e6e8f0';
          ctx.fillRect(st.cursor.x - 2, by - 8, 4, bh + 16);
        }
      }

      for (const b of buttons) {
        if (st.isStill && b.id === 'play') continue;
        const hovered = st.hover === b.id;
        ctx.fillStyle = b.id === 'exit' ? (hovered ? '#b91c1c' : '#7f1d1d') : (hovered ? '#49506a' : '#262a37');
        roundRect(b.x, ROW.y, b.w, ROW.h, 16); ctx.fill();
        const cx = b.x + b.w / 2, cy = ROW.y + ROW.h / 2;
        if (b.id === 'link') {
          if (st.linked) { ctx.fillStyle = hovered ? '#2f6fb5' : '#1e4f86'; roundRect(b.x, ROW.y, b.w, ROW.h, 16); ctx.fill(); }
          icon('link', cx, cy, st.linked);
          continue;
        }
        if (b.id === 'browse') {
          if (st.browsing) { ctx.fillStyle = hovered ? '#2f6fb5' : '#1e4f86'; roundRect(b.x, ROW.y, b.w, ROW.h, 16); ctx.fill(); }
          ctx.globalAlpha = st.canBrowse ? 1 : 0.35;
          icon('browse', cx, cy);
          ctx.globalAlpha = 1;
          continue;
        }
        if (b.id === 'exit') {
          ctx.fillStyle = '#fef2f2';
          ctx.font = '600 32px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('Exit VR', cx, cy);
          ctx.textAlign = 'left';
        } else {
          icon(b.id, cx, cy, st.paused);
        }
      }

      // Holding a pinch exits; show it filling so the gesture teaches itself.
      if (st.holdFrac > 0) {
        const ex = buttons[buttons.length - 1];
        ctx.fillStyle = '#fca5a5';
        ctx.fillRect(ex.x, ROW.y + ROW.h - 8, ex.w * Math.min(1, st.holdFrac), 8);
      }

      if (st.cursor && st.hover !== 'seek') {
        ctx.strokeStyle = '#e6e8f0'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(st.cursor.x, st.cursor.y, 12, 0, Math.PI * 2); ctx.stroke();
      }
    }

    function dispose() {
      video.srcObject?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      video.remove();
    }

    return { canvas, video, W, H, hit, draw, dispose };
  }


  /* ----------------------------------------------------------------- browse */

  /* The in-VR browser: the same trick as the control panel, at a larger size —
   * a Canvas2D grid of thumbnails streamed into a media layer. Thumbnails are
   * same-origin, so the canvas stays untainted and can be captured.
   *
   * Only the rows in view (and one either side) are loaded, and the cache is
   * capped. The page-side grid once decoded 324 thumbnails at once and took the
   * renderer down with it; this never holds more than a few dozen. */
  function createPane() {
    const W = 1600, H = 1000;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.display = 'none';
    video.srcObject = canvas.captureStream(30);
    document.body.append(video);

    const TOP = 120, PAD = 36, GAP = 24, COLS = 4;
    const CELL_W = Math.floor((W - PAD * 2 - GAP * (COLS - 1)) / COLS);
    const THUMB_H = Math.round(CELL_W * 9 / 16);
    const CELL_H = THUMB_H + 44;
    const ROW_H = CELL_H + GAP;
    const GRID = { x: PAD, y: TOP + 20, w: W - PAD * 2, h: H - TOP - 44 };
    const CLOSE = { x: W - PAD - 96, y: 20, w: 96, h: 80 };
    const TAB = { x: 100, y: 20, w: 330, h: 80, gap: 16 };

    const images = new Map();   // asset id -> { img, ready, failed, used }
    let onChange = () => {};

    const maxScroll = (count) =>
      Math.max(0, Math.ceil(count / COLS) * ROW_H - GAP - GRID.h);

    function hit(px, py, st) {
      if (py < TOP) {
        if (px >= CLOSE.x && px <= CLOSE.x + CLOSE.w && py >= CLOSE.y && py <= CLOSE.y + CLOSE.h) {
          return { id: 'close' };
        }
        for (let i = 0; i < st.tabs.length; i++) {
          const x = TAB.x + i * (TAB.w + TAB.gap);
          if (px >= x && px <= x + TAB.w && py >= TAB.y && py <= TAB.y + TAB.h) return { id: 'tab', index: i };
        }
        return { id: 'drag' };   // the rest of the top bar is the handle
      }
      if (px >= W - 56 && py >= GRID.y && py <= GRID.y + GRID.h && maxScroll(st.items.length) > 0) {
        return { id: 'scrollbar', frac: (py - GRID.y) / GRID.h };
      }
      if (px < GRID.x || px > GRID.x + GRID.w || py < GRID.y || py > GRID.y + GRID.h) return { id: 'drag' };
      const gx = px - GRID.x, gy = py - GRID.y + st.scroll;
      const col = Math.floor(gx / (CELL_W + GAP)), row = Math.floor(gy / ROW_H);
      const inCell = gx - col * (CELL_W + GAP) <= CELL_W && gy - row * ROW_H <= CELL_H;
      const index = row * COLS + col;
      if (inCell && col < COLS && index < st.items.length) return { id: 'cell', index };
      return { id: 'grid' };     // gaps and empty space still scroll
    }

    function want(item, url) {
      let e = images.get(item.id);
      if (!e) {
        e = { img: new Image(), ready: false, failed: false, used: 0 };
        e.img.decoding = 'async';
        e.img.onload = () => { e.ready = true; onChange(); };
        e.img.onerror = () => { e.failed = true; onChange(); };
        e.img.src = url;
        images.set(item.id, e);
      }
      e.used = performance.now();
      return e;
    }

    function evict(keep = 48) {
      if (images.size <= keep) return;
      const old = [...images.entries()].sort((a, b) => a[1].used - b[1].used);
      for (const [id, e] of old.slice(0, images.size - keep)) {
        e.img.onload = e.img.onerror = null;
        e.img.removeAttribute('src');
        images.delete(id);
      }
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    // Cover-fit, optionally from the left half only: Immich's thumbnail of a
    // side-by-side clip shows both eyes, which reads as a doubled image.
    function drawCover(img, dx, dy, dw, dh, leftHalf) {
      let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
      if (leftHalf) sw /= 2;
      const sr = sw / sh, dr = dw / dh;
      if (sr > dr) { const nw = sh * dr; sx += (sw - nw) / 2; sw = nw; }
      else { const nh = sw / dr; sy += (sh - nh) / 2; sh = nh; }
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    }

    const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

    function draw(st) {
      ctx.fillStyle = '#12131a';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#3b4256'; ctx.lineWidth = 5;
      roundRect(3, 3, W - 6, H - 6, 28); ctx.stroke();

      // Grip, tabs, close.
      ctx.fillStyle = st.hover?.id === 'drag' || st.moving ? '#e6e8f0' : '#5b6178';
      for (let gx = 0; gx < 2; gx++) for (let gy = 0; gy < 3; gy++) {
        ctx.beginPath(); ctx.arc(46 + gx * 14, 46 + gy * 14, 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.textBaseline = 'middle';
      st.tabs.forEach((t, i) => {
        const x = TAB.x + i * (TAB.w + TAB.gap);
        const active = i === st.tab, hovered = st.hover?.id === 'tab' && st.hover.index === i;
        ctx.fillStyle = active ? '#1e4f86' : hovered ? '#3b4256' : '#262a37';
        roundRect(x, TAB.y, TAB.w, TAB.h, 18); ctx.fill();
        ctx.fillStyle = '#e6e8f0';
        ctx.font = `${active ? '600 ' : ''}30px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(clip(`${t.label}${t.count === undefined ? '' : ` · ${t.count}`}`, 20), x + TAB.w / 2, TAB.y + TAB.h / 2);
        ctx.textAlign = 'left';
      });
      ctx.fillStyle = st.hover?.id === 'close' ? '#49506a' : '#262a37';
      roundRect(CLOSE.x, CLOSE.y, CLOSE.w, CLOSE.h, 18); ctx.fill();
      ctx.strokeStyle = '#e6e8f0'; ctx.lineWidth = 6;
      const cx = CLOSE.x + CLOSE.w / 2, cy = CLOSE.y + CLOSE.h / 2;
      ctx.beginPath(); ctx.moveTo(cx - 16, cy - 16); ctx.lineTo(cx + 16, cy + 16);
      ctx.moveTo(cx + 16, cy - 16); ctx.lineTo(cx - 16, cy + 16); ctx.stroke();

      // Grid.
      ctx.save();
      ctx.beginPath(); ctx.rect(GRID.x, GRID.y, GRID.w, GRID.h); ctx.clip();
      const first = Math.max(0, Math.floor(st.scroll / ROW_H) - 1);
      const last = Math.floor((st.scroll + GRID.h) / ROW_H) + 1;
      for (let row = first; row <= last; row++) {
        for (let col = 0; col < COLS; col++) {
          const i = row * COLS + col;
          const it = st.items[i];
          if (!it) continue;
          const x = GRID.x + col * (CELL_W + GAP);
          const y = GRID.y + row * ROW_H - st.scroll;
          const e = want(it, st.thumbUrl(it));
          if (y + CELL_H < GRID.y || y > GRID.y + GRID.h) continue;   // prefetch only
          ctx.fillStyle = '#0d0e14';
          roundRect(x, y, CELL_W, THUMB_H, 14); ctx.fill();
          if (e.ready) {
            ctx.save(); roundRect(x, y, CELL_W, THUMB_H, 14); ctx.clip();
            drawCover(e.img, x, y, CELL_W, THUMB_H, st.leftHalf && it.stereo === 'left-right');
            ctx.restore();
          }
          const blocked = it.kind === 'image' && st.dimPhotos;
          if (blocked) {
            ctx.fillStyle = 'rgba(13,14,20,.72)';
            roundRect(x, y, CELL_W, THUMB_H, 14); ctx.fill();
            ctx.fillStyle = '#9aa0b4'; ctx.font = '24px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('not available here', x + CELL_W / 2, y + THUMB_H / 2);
            ctx.textAlign = 'left';
          }
          if (it.kind === 'image') {
            ctx.fillStyle = 'rgba(0,0,0,.6)'; roundRect(x + 10, y + 10, 70, 34, 10); ctx.fill();
            ctx.fillStyle = '#e6e8f0'; ctx.font = '600 20px system-ui, sans-serif';
            ctx.fillText('PHOTO', x + 16, y + 27);
          }
          const playing = it.id === st.playingId;
          const hovered = st.hover?.id === 'cell' && st.hover.index === i;
          if (playing || hovered) {
            ctx.strokeStyle = playing ? '#60a5fa' : '#e6e8f0'; ctx.lineWidth = playing ? 7 : 4;
            roundRect(x, y, CELL_W, THUMB_H, 14); ctx.stroke();
          }
          ctx.fillStyle = playing ? '#60a5fa' : '#c4c8d6';
          ctx.font = '22px system-ui, sans-serif';
          const dur = it.seconds ? `  ${Math.round(it.seconds)}s` : '';
          ctx.fillText(clip(`${it.label}${dur}`, 30), x + 4, y + THUMB_H + 24);
        }
      }
      ctx.restore();

      // Scroll indicator.
      const max = maxScroll(st.items.length);
      if (max > 0) {
        // Wide enough to grab: dragging it jumps through a long collection
        // rather than scrolling it a few rows at a time.
        const hot = st.hover?.id === 'scrollbar' || st.scrubbing;
        const trackH = GRID.h, thumbH = Math.max(70, trackH * (GRID.h / (GRID.h + max)));
        const ty = GRID.y + (trackH - thumbH) * (st.scroll / max);
        ctx.fillStyle = '#262a37'; roundRect(W - 30, GRID.y, 16, trackH, 8); ctx.fill();
        ctx.fillStyle = hot ? '#e6e8f0' : '#9aa0b4'; roundRect(W - 30, ty, 16, thumbH, 8); ctx.fill();
        if (hot && st.items.length) {
          const first = Math.min(st.items.length, Math.floor(st.scroll / ROW_H) * COLS + 1);
          ctx.fillStyle = '#e6e8f0'; ctx.font = '600 26px system-ui, sans-serif'; ctx.textAlign = 'right';
          ctx.fillText(`${first} / ${st.items.length}`, W - 44, ty + thumbH / 2);
          ctx.textAlign = 'left';
        }
      }

      if (st.loading || !st.items.length) {
        ctx.fillStyle = '#9aa0b4'; ctx.font = '30px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(st.loading ? 'loading…' : 'nothing in this collection', W / 2, GRID.y + GRID.h / 2);
        ctx.textAlign = 'left';
      }

      if (st.cursor) {
        ctx.strokeStyle = '#e6e8f0'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(st.cursor.x, st.cursor.y, 16, 0, Math.PI * 2); ctx.stroke();
      }
      evict();
    }

    function dispose() {
      for (const e of images.values()) { e.img.onload = e.img.onerror = null; e.img.removeAttribute('src'); }
      images.clear();
      video.srcObject?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      video.remove();
    }

    return {
      W, H, video, hit, draw, dispose, maxScroll, ROW_H, COLS, GRID,
      setOnChange: (fn) => { onChange = fn; },
    };
  }

  function qmul(a, b) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
  }
  const quatYaw = (yaw) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
  const quatYawPitch = (yaw, pitch) =>
    qmul(quatYaw(yaw), { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) });
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

  /* The shape one eye's picture should be shown at.
   *
   * Packed stereo comes in two forms. Full-width packing keeps each eye at its
   * native resolution, so two 16:9 views side by side make a 32:9 frame
   * (3840x1080). Half-width packing squeezes both into an ordinary frame
   * (1920x1080), and each eye is meant to be stretched back out — its display
   * shape is the whole frame's. A side-by-side frame narrower than 2.4:1 can
   * only be half width, short of a camera with near-square eyes; top/bottom is
   * the same test turned on its side. */
  function eyeAspect(layout, w, h) {
    const frame = w / h;
    if (layout === 'stereo-left-right') return frame < 2.4 ? frame : frame / 2;
    if (layout === 'stereo-top-bottom') return frame > 1.2 ? frame : frame * 2;
    return frame;
  }

  // gl-matrix's vec3.transformQuat.
  function qrot(q, v) {
    let uvx = q.y * v.z - q.z * v.y, uvy = q.z * v.x - q.x * v.z, uvz = q.x * v.y - q.y * v.x;
    let uuvx = q.y * uvz - q.z * uvy, uuvy = q.z * uvx - q.x * uvz, uuvz = q.x * uvy - q.y * uvx;
    const w2 = q.w * 2;
    return {
      x: v.x + uvx * w2 + uuvx * 2,
      y: v.y + uvy * w2 + uuvy * 2,
      z: v.z + uvz * w2 + uuvz * 2,
    };
  }

  /* ------------------------------------------------------------------ session */


  /* ------------------------------------------------------------------ session */

  /* Plays a playlist of items in an immersive session. Items are
   * { id, label, width, height, projection: 'flat'|'equirect360',
   *   stereo: 'left-right'|'top-bottom'|'mono', codec, seconds }.
   *
   * The media layer is rebuilt on each switch, because a quad layer is bound to
   * the video's dimensions at creation and the next item may be shaped
   * differently — an SBS panel and a 360 sphere are not the same layer type at
   * all. */
  async function run(opts) {
    const { mode, forcedLayout, widthM, distM, showGrid, wantSound, passthrough,
            urlFor, video, report, log } = opts;
    // Replaced when a clip is picked from another collection in the browser.
    let playlist = opts.playlist;
    const maxTexture = opts.maxTexture || 4096;

    let session, refSpace, gl, glBinding, projLayer, mediaLayer, mediaBinding, scene, fb;
    let stillTex = null, stillItem = null;
    let photo = null;          // { video, timer } backing a photo's media layer
    let panel = null, panelLayer = null;
    const pinchStart = new Map();
    const HOLD_TO_EXIT_MS = 1200;

    /* Where things sit. The video and the panel are both movable by pointing and
     * dragging; linked (the default) the panel docks under the video and the two
     * move as one, unlinked each goes its own way. The arrangement is remembered
     * across sessions, since people tend to watch from the same spot. */
    const LAYOUT_KEY = 'immich-vr.layout';
    const saved = (() => {
      try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch { return null; }
    })();
    let vPose = saved?.video || { x: 0, y: 1.5, z: -distM, yaw: 0 };
    let linked = saved?.linked ?? true;
    let pFree = saved?.panel || null;          // only consulted when unlinked
    let head = { x: 0, y: 1.6, z: 0 };
    let grab = null;                            // an in-progress drag
    let press = null;                           // a panel control being held
    let poseWarned = false;

    /* The browser pane. The catalog comes from the page: which collections
     * exist, and how to load one. It is optional — the probe has none. */
    const catalog = opts.catalog || null;
    let pane = null, paneLayer = null, paneOpen = false;
    let bPose = saved?.browse || null;          // where the pane was last put
    const paneData = new Map();                 // collection name -> items
    let currentCollection = catalog?.current ?? null;
    let paneTab = catalog ? Math.max(0, catalog.collections.findIndex((c) => c.name === currentCollection)) : 0;
    const paneScrollByTab = new Map();
    let paneScroll = 0, paneLoading = false, paneDirty = true, paneLastDraw = 0;
    let paneHoverKey = '';
    let paneVelocity = 0;            // px/ms of fling after a scroll is released
    if (catalog && currentCollection) paneData.set(currentCollection, playlist);
    let usingProjection = false, glDead = false, drawingDisabled = false;
    let frames = 0, uploadMs = 0, frameErrors = 0, ended = false;
    let idx = Math.max(0, Math.min(opts.index || 0, playlist.length - 1));
    let switching = false, seeking = false;

    const item = () => playlist[idx];
    const layoutFor = (it) => forcedLayout && forcedLayout !== 'auto' ? forcedLayout
      : it.stereo === 'left-right' ? 'stereo-left-right'
      : it.stereo === 'top-bottom' ? 'stereo-top-bottom' : 'mono';

    const counts = { stalled: 0, waiting: 0, ended: 0, error: 0 };

    const finish = () => {
      if (ended) return;
      ended = true;
      try { video.pause(); } catch {}
      try { panel?.dispose(); } catch {}
      try { pane?.dispose(); } catch {}
      try { dropPhoto(); } catch {}
      report('playback events', `stalled ${counts.stalled} · waiting ${counts.waiting} · ` +
        `loops ${counts.ended} · errors ${counts.error}`,
        counts.error ? 'warn' : 'ok');
      opts.onEnd?.({ frames, uploadMs });
    };

    const hasStills = playlist.some((it) => it.kind === 'image');
    /* Photos are shown the way the control panel is: painted onto a canvas,
     * captured as video, composited as a media layer. That needs no WebGL, so
     * it works in passthrough — and unlike the drawn path it cannot cost the
     * context. The drawn path remains selectable while the new one proves
     * itself. */
    const photoPath = opts.photoPath === 'gl' ? 'gl' : 'media';
    const wantsProjection = showGrid || (hasStills && photoPath === 'gl');

    /* Passthrough and the projection layer do not mix here: in immersive-ar the
     * projection layer costs the WebGL context after exactly one frame, every
     * time, while in immersive-vr the same layer runs for thousands. Anything
     * the app draws itself therefore implies a fully immersive session — which
     * is no loss for a 360 photo, since it replaces the surroundings anyway. */
    const sessionMode = passthrough && !wantsProjection ? 'immersive-ar' : 'immersive-vr';
    if (passthrough && wantsProjection) {
      report('passthrough', 'off for this session', 'info',
        hasStills && photoPath === 'gl'
                  ? 'Photos drawn with WebGL need a layer that is not stable in passthrough here. '
                    + 'The media-layer photo path does not have this limit.'
                  : 'The grid is drawn into a layer that is not stable in passthrough here.');
    }
    try {
      session = await navigator.xr.requestSession(sessionMode, {
        optionalFeatures: ['layers', 'local-floor', 'hand-tracking'],
      });
    } catch (err) {
      if (sessionMode === 'immersive-ar') {
        report('passthrough', `immersive-ar refused — ${err.message}`, 'warn',
          'Falling back to a fully immersive session.');
        session = await navigator.xr.requestSession('immersive-vr', {
          optionalFeatures: ['layers', 'local-floor', 'hand-tracking'],
        });
      } else {
        throw err;
      }
    }
    const isAR = !!session.environmentBlendMode && session.environmentBlendMode !== 'opaque';
    report('session', `started (${sessionMode})`, 'ok',
      `environmentBlendMode: ${session.environmentBlendMode || 'unreported'}`);
    const enabled = session.enabledFeatures ? Array.from(session.enabledFeatures) : null;
    report('enabledFeatures', enabled ? enabled.join(', ') : 'not reported',
      enabled?.includes('layers') ? 'ok' : 'warn');
    // Ship what we know now: if the tab dies on the way in, this is the only
    // record that the session ever opened.
    opts.flush?.('session-start');

    for (const evt of Object.keys(counts)) {
      video.addEventListener(evt, () => { counts[evt]++; }, { passive: true });
    }

    session.addEventListener('end', () => { log('session ended'); finish(); });

    /* Entering VR is itself a trigger press, and double-tapping a thumbnail is
     * two — the trailing release lands inside the session that just opened. An
     * input in the first moments therefore means "the gesture that got us here",
     * not "the user asking for something", and must never be able to end the
     * session. */
    const openedAt = performance.now();
    const settled = () => performance.now() - openedAt > 800;

    // Bound before anything that can fail, so there is always a way out.
    session.addEventListener('squeeze', () => {
      if (!settled()) return;
      log('squeeze: ending session');
      session.end();
    });
    /* Pinch (or trigger) is the only input hands and controllers share, so what
     * it does depends on what it is pointed at when it starts:
     *   a panel control  -> press it (the progress bar scrubs while held)
     *   the video, or the panel's background -> grab; a quick tap on the video
     *                       plays or pauses
     *   empty space      -> a tap plays or pauses, a hold leaves
     * Holding to leave is confined to empty space because a drag is itself a
     * held pinch. The Exit VR button covers leaving from anywhere else. */
    session.addEventListener('selectstart', (e) => {
      pinchStart.set(e.inputSource, performance.now());
      if (!settled()) return;
      const pose = e.frame.getPose(e.inputSource.targetRaySpace, refSpace);
      const tgt = pose && targetUnder(pose);
      if (!tgt) return;
      if (tgt.kind === 'pane') {
        const ctl = tgt.control;
        paneVelocity = 0;
        if (ctl.id === 'scrollbar') {
          grab = { src: e.inputSource, target: 'scrollbar', moved: true };
          paneScroll = clamp(ctl.frac, 0, 1) * pane.maxScroll(paneItems().length);
          paneDirty = true;
          return;
        }
        if (ctl.id === 'cell' || ctl.id === 'grid') {
          // Could be a tap on a clip or the start of a scroll; movement decides.
          grab = {
            src: e.inputSource, target: 'scroll', moved: false,
            startY: tgt.hit.v * pane.H, startScroll: paneScroll,
            cell: ctl.id === 'cell' ? ctl.index : null,
            lastY: tgt.hit.v * pane.H, lastT: performance.now(), vel: 0,
          };
          return;
        }
        if (ctl.id !== 'drag') { press = { src: e.inputSource, id: ctl.id, index: ctl.index, kind: 'pane' }; return; }
        const bp = panePose();
        grab = {
          src: e.inputSource, target: 'pane', t: tgt.hit.t,
          offset: { x: bp.x - tgt.hit.point.x, y: bp.y - tgt.hit.point.y, z: bp.z - tgt.hit.point.z },
          start: tgt.hit.point, moved: false,
        };
        return;
      }
      if (tgt.kind === 'panel' && tgt.control.id !== 'drag') {
        press = { src: e.inputSource, id: tgt.control.id };
        if (press.id === 'seek') act(tgt.control);
        return;
      }
      const center = tgt.kind === 'panel' ? panelPose() : vPose;
      grab = {
        src: e.inputSource,
        target: tgt.kind,
        t: tgt.hit.t,
        offset: { x: center.x - tgt.hit.point.x, y: center.y - tgt.hit.point.y, z: center.z - tgt.hit.point.z },
        start: tgt.hit.point,
        moved: false,
      };
    });

    session.addEventListener('select', (e) => {
      const began = pinchStart.get(e.inputSource);
      pinchStart.delete(e.inputSource);
      if (!settled()) { grab = null; press = null; return; }

      if (grab && grab.src === e.inputSource) {
        const g = grab;
        grab = null;
        if (g.target === 'scrollbar') return;
        if (g.target === 'scroll') {
          if (!g.moved && g.cell !== null) selectFromPane(g.cell);
          else if (g.moved) paneVelocity = g.vel;
          return;
        }
        if (g.moved) { saveLayout(); return; }
        if (g.target === 'video' && video.readyState >= 2) {
          video.paused ? video.play().catch(() => {}) : video.pause();
        }
        return;
      }

      if (press && press.src === e.inputSource) {
        const press0 = press;
        const id = press.id;
        press = null;
        if (id === 'seek') return;   // already applied while held
        // Like a real button: only fires if released still over it.
        const pose = e.frame.getPose(e.inputSource.targetRaySpace, refSpace);
        const tgt = pose && targetUnder(pose);
        if (tgt && tgt.control?.id === id && (tgt.kind === 'pane') === (press0.kind === 'pane')) {
          if (tgt.control.index === undefined || tgt.control.index === press0.index) act(tgt.control);
        }
        return;
      }

      if (began !== undefined && performance.now() - began >= HOLD_TO_EXIT_MS) {
        log('pinch held on empty space: ending session');
        session.end();
        return;
      }
      if (video.readyState >= 2) video.paused ? video.play().catch(() => {}) : video.pause();
    });

    session.addEventListener('selectend', (e) => {
      // A gesture that ends without completing (tracking lost mid-pinch) must
      // not leave a drag or a press stuck on.
      setTimeout(() => {
        pinchStart.delete(e.inputSource);
        if (grab?.src === e.inputSource) { if (grab.moved) saveLayout(); grab = null; }
        if (press?.src === e.inputSource) press = null;
      }, 0);
    });

    try {
      refSpace = await session.requestReferenceSpace('local-floor');
    } catch {
      refSpace = await session.requestReferenceSpace('local');
      report('reference space', 'local (local-floor refused)', 'warn');
    }

    /* Background first when it is wanted, so there is something to look at and
     * somewhere to print a failure while media loads. */
    const needGL = mode === 'webgl' || wantsProjection;
    let glLayer = null;
    if (needGL) {
      let canvas = document.querySelector('#canvas');
      // A canvas hands back its existing context whatever attributes are asked
      // for, and a lost one stays lost, so a fresh element is the only way to
      // get a working XR-capable context after either.
      if (canvas.dataset.glLost === '1') {
        const fresh = document.createElement('canvas');
        fresh.id = 'canvas';
        fresh.style.display = 'none';
        canvas.replaceWith(fresh);
        canvas = fresh;
        log('replaced canvas after a lost context');
      }
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        canvas.dataset.glLost = '1';
        glDead = true;
        report('webgl context', `lost after ${frames} frames`, 'fail',
          'Dropping to the media layer alone so playback survives.');
        if (mediaLayer) {
          try { session.updateRenderState({ layers: [mediaLayer] }); } catch {}
        }
        opts.flush?.('context-lost');
      }, { once: true });

      gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: isAR, antialias: false });
      if (!gl) {
        // A context refused on a freshly loaded page means the browser's GPU
        // process is exhausted, not this page's. Reloading does not clear it.
        report('webgl2', 'unavailable', 'fail',
          "The browser cannot create a WebGL2 context. Close the Quest Browser completely and " +
          'reopen it — reloading the page will not clear this. Video still plays without GL; ' +
          'photos and the grid do not.');
        opts.flush?.('no-webgl');
      }
      if (gl) {
        await gl.makeXRCompatible();
        scene = createScene(gl);
        try {
          // Needed for stills whether or not a background is wanted: a photo is
          // a layer we render into ourselves.
          glBinding = new XRWebGLBinding(session, gl);
        } catch (err) {
          report('XRWebGLBinding', `unavailable — ${err.message}`, 'fail');
        }
        if (glBinding && (showGrid || hasStills)) {
          try {
            // depthFormat 0 is load-bearing: the compositor reprojects against a
            // layer's depth texture, and drawing with depth testing off into one
            // we never write cost the whole context after exactly one frame.
            projLayer = glBinding.createProjectionLayer({ textureType: 'texture-array', depthFormat: 0 });
            usingProjection = true;
            report('projection layer', 'created', 'ok',
              `${projLayer.textureWidth}x${projLayer.textureHeight} · ignoreDepthValues ${projLayer.ignoreDepthValues}`);
          } catch (err) {
            report('projection layer', `unavailable — ${err.message}`, 'warn');
          }
        }
        if (!usingProjection && mode === 'webgl') {
          glLayer = new XRWebGLLayer(session, gl);
        }
        fb = gl.createFramebuffer();
      }
    }

    try {
      mediaBinding = typeof global.XRMediaBinding === 'function' ? new XRMediaBinding(session) : null;
    } catch (err) {
      report('XRMediaBinding', `construct failed — ${err.message}`, 'fail');
    }
    setupPanel();   // not awaited: it composes in once its stream has a frame

    function setLayers() {
      const stack = [];
      if (projLayer) stack.push(projLayer);
      if (mediaLayer) stack.push(mediaLayer);
      if (panelLayer) stack.push(panelLayer);
      if (paneLayer && paneOpen) stack.push(paneLayer);
      try {
        if (stack.length) session.updateRenderState({ layers: stack });
        else if (glLayer) session.updateRenderState({ baseLayer: glLayer });
      } catch (err) {
        report('updateRenderState', `failed — ${err.message}`, 'fail');
      }
    }

    function makeMediaLayer(it) {
      if (!mediaBinding || mode === 'webgl') return null;
      const layout = layoutFor(it);
      const aspect = eyeAspect(layout, it.width, it.height);
      if (it.projection === 'equirect360') {
        return mediaBinding.createEquirectLayer(video, {
          space: refSpace, layout,
          transform: new XRRigidTransform({ x: 0, y: 0, z: 0 }),
          radius: 0,
          centralHorizontalAngle: 2 * Math.PI,
          upperVerticalAngle: Math.PI / 2,
          lowerVerticalAngle: -Math.PI / 2,
        });
      }
      // width/height are half-extents — confirmed on device.
      return mediaBinding.createQuadLayer(video, {
        space: refSpace, layout,
        transform: new XRRigidTransform(pt(vPose), quatYaw(vPose.yaw)),
        width: widthM / 2, height: (widthM / aspect) / 2,
      });
    }

    /* ------------------------------------------------------------ layout */

    const pt = (o) => ({ x: o.x, y: o.y, z: o.z });
    const faceYaw = (o) => Math.atan2(head.x - o.x, head.z - o.z);

    function videoHalf(it) {
      if (!it || it.projection === 'equirect360') return null;
      const layout = layoutFor(it);
      const aspect = eyeAspect(layout, it.width, it.height);
      return { hw: widthM / 2, hh: (widthM / aspect) / 2 };
    }

    /* The panel keeps a roughly constant apparent size wherever it is put, so
     * it stays legible far away and does not swamp the view up close. */
    const panelHalfW = (dist) => clamp(0.2 * dist, 0.18, 0.85);

    function panelPose() {
      if (linked || !pFree) {
        // Docked: in the video's plane, facing the same way, just under its
        // bottom edge — below the picture rather than across it. Layers
        // composite in array order, not by depth, so overlap would cover it.
        const vh = videoHalf(item());
        const q = quatYaw(vPose.yaw);
        const halfW = panelHalfW(Math.hypot(vPose.x - head.x, vPose.z - head.z) || distM);
        const halfH = halfW / 4;
        const drop = (vh ? vh.hh : 0.9) + 0.06 + halfH;
        const off = qrot(q, { x: 0, y: -drop, z: 0 });
        return { x: vPose.x + off.x, y: vPose.y + off.y, z: vPose.z + off.z, q, halfW, halfH };
      }
      const halfW = panelHalfW(Math.hypot(pFree.x - head.x, pFree.y - head.y, pFree.z - head.z) || 1.5);
      const yaw = faceYaw(pFree);
      const pitch = -Math.atan2(head.y - pFree.y, Math.hypot(head.x - pFree.x, head.z - pFree.z));
      return { ...pt(pFree), q: quatYawPitch(yaw, pitch), halfW, halfH: halfW / 4 };
    }

    function applyPoses() {
      try {
        if (mediaLayer && item().projection !== 'equirect360') {
          mediaLayer.transform = new XRRigidTransform(pt(vPose), quatYaw(vPose.yaw));
        }
        if (panelLayer) {
          const pp = panelPose();
          panelLayer.transform = new XRRigidTransform(pt(pp), pp.q);
          panelLayer.width = pp.halfW;
          panelLayer.height = pp.halfH;
        }
        if (paneLayer && paneOpen) {
          const bp = panePose();
          paneLayer.transform = new XRRigidTransform(pt(bp), bp.q);
          paneLayer.width = bp.halfW;
          paneLayer.height = bp.halfH;
        }
      } catch (err) {
        if (!poseWarned) {
          poseWarned = true;
          report('move', `layer transform refused — ${err.message}`, 'warn');
        }
      }
    }

    function saveLayout() {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ video: vPose, panel: pFree, linked, browse: bPose }));
      } catch { /* per-viewer convenience only */ }
    }

    /* Where a target ray meets a quad, with the hit in quad-local 0..1 terms. */
    function rayQuad(pose, c, q, hw, hh, bounded = true) {
      const o = pose.transform.position;
      const d = qrot(pose.transform.orientation, { x: 0, y: 0, z: -1 });
      const n = qrot(q, { x: 0, y: 0, z: 1 });
      const denom = dot(d, n);
      if (Math.abs(denom) < 1e-4) return null;
      const t = ((c.x - o.x) * n.x + (c.y - o.y) * n.y + (c.z - o.z) * n.z) / denom;
      if (t <= 0) return null;
      const h = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
      const rel = { x: h.x - c.x, y: h.y - c.y, z: h.z - c.z };
      const lu = dot(rel, qrot(q, { x: 1, y: 0, z: 0 })) / hw;
      const lv = dot(rel, qrot(q, { x: 0, y: 1, z: 0 })) / hh;
      if (bounded && (lu < -1 || lu > 1 || lv < -1 || lv > 1)) return null;
      return { t, point: h, u: (lu + 1) / 2, v: 1 - (lv + 1) / 2 };
    }

    /* What a ray is pointing at. The panel is checked first because it is
     * composited above the video. */
    function targetUnder(pose) {
      if (paneLayer && paneOpen && pane) {
        const bp = panePose();
        const hit = rayQuad(pose, bp, bp.q, bp.halfW, bp.halfH);
        if (hit) return { kind: 'pane', hit, control: pane.hit(hit.u * pane.W, hit.v * pane.H, paneState()) };
      }
      if (panelLayer && panel) {
        const pp = panelPose();
        const hit = rayQuad(pose, pp, pp.q, pp.halfW, pp.halfH);
        if (hit) return { kind: 'panel', hit, control: panel.hit(hit.u * panel.W, hit.v * panel.H) };
      }
      const vh = mediaLayer || stillTex ? videoHalf(item()) : null;
      if (vh) {
        const hit = rayQuad(pose, vPose, quatYaw(vPose.yaw), vh.hw, vh.hh);
        if (hit) return { kind: 'video', hit };
      }
      return null;
    }

    function updateDrag(frame) {
      if (!grab) return;
      const pose = frame.getPose(grab.src.targetRaySpace, refSpace);
      if (!pose) return;
      if (grab.target === 'scroll' || grab.target === 'scrollbar') {
        // Unbounded, so the scroll keeps tracking a hand that drifts off the edge.
        const bp = panePose();
        const hit = rayQuad(pose, bp, bp.q, bp.halfW, bp.halfH, false);
        if (!hit) return;
        const y = hit.v * pane.H;
        const max = pane.maxScroll(paneItems().length);
        if (grab.target === 'scrollbar') {
          paneScroll = clamp((y - pane.GRID.y) / pane.GRID.h, 0, 1) * max;
          paneDirty = true;
          return;
        }
        const now = performance.now();
        const dt = Math.max(1, now - grab.lastT);
        // Smoothed, so a jittery last frame does not decide the fling.
        grab.vel = 0.7 * grab.vel + 0.3 * (-(y - grab.lastY) / dt);
        grab.lastY = y; grab.lastT = now;
        if (!grab.moved && Math.abs(y - grab.startY) < 14) return;
        grab.moved = true;
        paneScroll = clamp(grab.startScroll - (y - grab.startY), 0, max);
        paneDirty = true;
        return;
      }
      const o = pose.transform.position;
      const d = qrot(pose.transform.orientation, { x: 0, y: 0, z: -1 });
      // Keep the grabbed point at the same distance along the ray, so the
      // object swings with the hand like something held on a stick.
      const hit = { x: o.x + d.x * grab.t, y: o.y + d.y * grab.t, z: o.z + d.z * grab.t };
      if (!grab.moved) {
        // A few centimetres of slack, so a tap on the video stays a tap.
        if (Math.hypot(hit.x - grab.start.x, hit.y - grab.start.y, hit.z - grab.start.z) < 0.04) return;
        grab.moved = true;
      }
      const to = { x: hit.x + grab.offset.x, y: hit.y + grab.offset.y, z: hit.z + grab.offset.z };
      if (grab.target === 'pane') {
        bPose = to;          // the browser is never linked to anything
      } else if (grab.target === 'panel' && !linked) {
        pFree = to;
      } else {
        // The video moves, and a linked panel follows because it is docked to it.
        const cur = grab.target === 'video' ? vPose : panelPose();
        vPose = { x: vPose.x + to.x - cur.x, y: vPose.y + to.y - cur.y, z: vPose.z + to.z - cur.z, yaw: vPose.yaw };
        vPose.yaw = faceYaw(vPose);
      }
      applyPoses();
    }

    function act(t) {
      if (t.id === 'play' && video.readyState >= 2) {
        video.paused ? video.play().catch(() => {}) : video.pause();
      } else if (t.id === 'prev') {
        loadIndex(idx - 1, 'previous');
      } else if (t.id === 'next') {
        loadIndex(idx + 1, 'next');
      } else if (t.id === 'link') {
        if (linked) {
          // Unlink where it stands rather than jumping.
          const pp = panelPose();
          pFree = pt(pp);
          linked = false;
        } else {
          linked = true;
        }
        applyPoses();
        saveLayout();
      } else if (t.id === 'browse') {
        togglePane();
      } else if (t.id === 'close') {
        togglePane(false);
      } else if (t.id === 'tab') {
        showTab(t.index);
      } else if (t.id === 'exit') {
        log('exit button: ending session');
        session.end();
      } else if (t.id === 'seek' && Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = t.frac * video.duration;
      }
    }

    function updatePanel(frame) {
      if (!panel) return;
      let hover = null, cursor = null;
      if (frame && panelLayer) {
        for (const src of session.inputSources) {
          if (!src.targetRaySpace) continue;
          const pose = frame.getPose(src.targetRaySpace, refSpace);
          const tgt = pose && targetUnder(pose);
          if (tgt?.kind === 'panel') {
            cursor = { x: tgt.hit.u * panel.W, y: tgt.hit.v * panel.H };
            hover = tgt.control.id;
            // Scrubbing: a held press on the bar follows the pointer.
            if (press?.src === src && press.id === 'seek' && tgt.control.id === 'seek') act(tgt.control);
            break;
          }
        }
      }
      // The exit bar only fills for a hold on empty space — the one place a
      // hold means leave.
      let holdFrac = 0;
      for (const [src, began] of pinchStart) {
        if (grab?.src === src || press?.src === src) continue;
        holdFrac = Math.max(holdFrac, (performance.now() - began) / HOLD_TO_EXIT_MS);
      }
      if (holdFrac < 0.25) holdFrac = 0;
      let buffered = 0;
      try {
        for (let i = 0; i < video.buffered.length; i++) buffered = Math.max(buffered, video.buffered.end(i));
      } catch { /* nothing loaded yet */ }
      const it = item();
      const moving = grab?.moved && (grab.target === 'video' || grab.target === 'panel')
        ? (grab.target === 'panel' && !linked ? 'Moving controls' : 'Moving video and controls')
        : null;
      panel.draw({
        title: it.label,
        index: idx + 1,
        count: playlist.length,
        isStill: it.kind === 'image',
        time: video.currentTime,
        duration: video.duration,
        buffered,
        paused: video.paused,
        linked,
        browsing: paneOpen,
        canBrowse: !!catalog,
        moving,
        hover: grab?.moved && grab.target !== 'pane' && grab.target !== 'scroll' ? 'drag' : hover,
        cursor,
        holdFrac,
      });
    }

    async function setupPanel() {
      if (!mediaBinding) {
        report('controls', 'unavailable — no XRMediaBinding', 'warn',
          'Pinch to play or pause; pinch and hold on empty space to exit.');
        return;
      }
      try {
        panel = createPanel();
        updatePanel(null);
        await panel.video.play();
        await Promise.race([
          new Promise((res) => {
            if (panel.video.videoWidth > 0) res();
            else panel.video.addEventListener('loadedmetadata', res, { once: true });
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('panel stream produced no frames')), 4000)),
        ]);
        if (ended) return;
        const pp = panelPose();
        panelLayer = mediaBinding.createQuadLayer(panel.video, {
          space: refSpace,
          layout: 'mono',
          transform: new XRRigidTransform(pt(pp), pp.q),
          width: pp.halfW,
          height: pp.halfH,
        });
        setLayers();
        report('controls', 'panel shown', 'ok',
          `${linked ? 'docked under the video' : 'placed where you left it'}${saved ? ' (remembered layout)' : ''}`);
      } catch (err) {
        panelLayer = null;
        report('controls', `panel unavailable — ${err.message}`, 'warn',
          'Pinch to play or pause; pinch and hold on empty space to exit.');
      }
    }

    /* ------------------------------------------------------------ browse */

    // Whether a photo could be shown in this session at all.
    const photosPossible = () => (photoPath === 'media' ? !!mediaBinding : !!(gl && usingProjection));

    function paneItems() {
      const c = catalog?.collections[paneTab];
      return (c && paneData.get(c.name)) || [];
    }

    function paneState() {
      const c = catalog?.collections[paneTab];
      return {
        tabs: (catalog?.collections || []).map((t) => ({ label: t.label, count: paneData.get(t.name)?.length })),
        tab: paneTab,
        items: paneItems(),
        scroll: paneScroll,
        leftHalf: true,
        dimPhotos: !photosPossible(),
        playingId: currentCollection === c?.name ? item()?.id : null,
        loading: paneLoading,
        thumbUrl: opts.thumbUrlFor || ((it) => `/api/assets/${it.id}/thumbnail?size=thumbnail`),
      };
    }

    /* Opened for the first time, the pane goes to the left of the video,
     * nearer than it and angled in, so it covers none of the picture. After
     * that it stays wherever it was put. */
    function defaultPanePose() {
      const dx = vPose.x - head.x, dz = vPose.z - head.z;
      const videoAz = Math.atan2(dx, -dz);
      const vDist = Math.hypot(dx, dz) || distM;
      const vh = videoHalf(item());
      const videoHalfAngle = Math.atan((vh ? vh.hw : 1.6) / vDist);
      const dist = 2.0;
      const paneHalfAngle = Math.atan(paneHalfW(dist) / dist);
      const az = videoAz - (videoHalfAngle + paneHalfAngle + 5 * Math.PI / 180);
      return { x: head.x + dist * Math.sin(az), y: head.y - 0.25, z: head.z - dist * Math.cos(az) };
    }

    const paneHalfW = (dist) => clamp(0.33 * dist, 0.35, 1.2);

    function panePose() {
      const b = bPose || defaultPanePose();
      const dist = Math.hypot(b.x - head.x, b.y - head.y, b.z - head.z) || 2;
      const halfW = paneHalfW(dist);
      const yaw = faceYaw(b);
      const pitch = -Math.atan2(head.y - b.y, Math.hypot(head.x - b.x, head.z - b.z));
      return { ...pt(b), q: quatYawPitch(yaw, pitch), halfW, halfH: halfW * (pane ? pane.H / pane.W : 0.625) };
    }

    async function ensureTab(i) {
      const c = catalog?.collections[i];
      if (!c || paneData.has(c.name)) return;
      paneLoading = true;
      paneDirty = true;
      try {
        paneData.set(c.name, await catalog.load(c.name));
      } catch (err) {
        report('browse', `could not load ${c.label} — ${err.message}`, 'warn');
        paneData.set(c.name, []);
      }
      paneLoading = false;
      paneDirty = true;
    }

    function showTab(i) {
      paneScrollByTab.set(paneTab, paneScroll);
      paneTab = i;
      paneScroll = paneScrollByTab.get(i) || 0;
      paneDirty = true;
      ensureTab(i);
    }

    async function setupPane() {
      if (!mediaBinding) throw new Error('no XRMediaBinding');
      pane = createPane();
      pane.setOnChange(() => { paneDirty = true; });
      pane.draw(paneState());
      await pane.video.play();
      await Promise.race([
        new Promise((res) => {
          if (pane.video.videoWidth > 0) res();
          else pane.video.addEventListener('loadedmetadata', res, { once: true });
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('browser stream produced no frames')), 4000)),
      ]);
      if (!bPose) bPose = defaultPanePose();
      const bp = panePose();
      paneLayer = mediaBinding.createQuadLayer(pane.video, {
        space: refSpace, layout: 'mono',
        transform: new XRRigidTransform(pt(bp), bp.q),
        width: bp.halfW, height: bp.halfH,
      });
    }

    async function togglePane(open = !paneOpen) {
      if (!catalog) { report('browse', 'no collections available here', 'info'); return; }
      if (open && !paneLayer) {
        try {
          await setupPane();
        } catch (err) {
          report('browse', `could not open — ${err.message}`, 'warn');
          return;
        }
      }
      paneOpen = open;
      if (open) {
        // Land on the collection that is playing, scrolled to the clip.
        paneTab = Math.max(0, catalog.collections.findIndex((c) => c.name === currentCollection));
        const row = Math.floor(idx / pane.COLS);
        paneScroll = clamp((row - 1) * pane.ROW_H, 0, pane.maxScroll(paneItems().length));
        ensureTab(paneTab);
        paneDirty = true;
      }
      setLayers();
      applyPoses();
      saveLayout();
    }

    function selectFromPane(index) {
      const c = catalog.collections[paneTab];
      const items = paneData.get(c.name) || [];
      const it = items[index];
      if (!it) return;
      if (it.kind === 'image' && !photosPossible()) {
        report('browse', `${it.label} cannot be shown in this session`, 'info');
        return;
      }
      if (c.name !== currentCollection) {
        playlist = items;
        currentCollection = c.name;
        opts.onCollection?.(c.name);
      }
      loadIndex(index, 'browse');
      paneDirty = true;
    }

    let lastFling = 0;
    function updatePane(frame) {
      if (!pane || !paneOpen) return;
      const tNow = performance.now();
      if (Math.abs(paneVelocity) > 0.02 && !grab) {
        const dt = Math.min(50, lastFling ? tNow - lastFling : 16);
        const max = pane.maxScroll(paneItems().length);
        paneScroll = clamp(paneScroll + paneVelocity * dt, 0, max);
        if (paneScroll === 0 || paneScroll === max) paneVelocity = 0;
        paneVelocity *= Math.pow(0.94, dt / 16);
        paneDirty = true;
      } else {
        paneVelocity = 0;
      }
      lastFling = tNow;
      let hover = null, cursor = null;
      if (frame) {
        for (const src of session.inputSources) {
          if (!src.targetRaySpace) continue;
          const pose = frame.getPose(src.targetRaySpace, refSpace);
          const tgt = pose && targetUnder(pose);
          if (tgt?.kind === 'pane') {
            cursor = { x: tgt.hit.u * pane.W, y: tgt.hit.v * pane.H };
            hover = tgt.control;
            break;
          }
        }
      }
      const key = `${hover?.id}:${hover?.index}:${cursor ? Math.round(cursor.x / 6) : ''}:${cursor ? Math.round(cursor.y / 6) : ''}`;
      if (key !== paneHoverKey) { paneHoverKey = key; paneDirty = true; }
      // Change-driven and capped near the stream's rate: repainting a
      // 1600x1000 grid of thumbnails every frame buys nothing the capture
      // would show.
      const now = performance.now();
      if (!paneDirty || now - paneLastDraw < 33) return;
      paneDirty = false;
      paneLastDraw = now;
      const moving = grab?.moved && grab.target === 'pane' ? 'Moving browser' : null;
      pane.draw({
        ...paneState(), hover: moving ? { id: 'drag' } : hover, cursor, moving,
        scrubbing: grab?.target === 'scrollbar',
      });
    }

    function dropPhoto() {
      if (!photo) return;
      clearInterval(photo.timer);
      photo.video.srcObject?.getTracks().forEach((t) => t.stop());
      photo.video.srcObject = null;
      photo.video.remove();
      photo = null;
    }

    /* How much of a sphere a panorama covers. A true equirect is 2:1 and
     * spans 360x180. Wider than that is typically a phone panorama: a full turn
     * horizontally but less than a full sphere vertically — 7216x2272, say, is
     * about 113 degrees tall. Stretching one of those over a whole sphere
     * distorts it badly; giving it its real vertical extent does not. */
    function sphereFor(it) {
      const aspect = it.width / it.height;
      if (aspect > 2.05) {
        const vfov = (2 * Math.PI) / aspect;
        return { central: 2 * Math.PI, upper: vfov / 2, lower: vfov / 2 };
      }
      return { central: 2 * Math.PI, upper: Math.PI / 2, lower: Math.PI / 2 };
    }

    async function loadPhotoLayer(it) {
      if (!mediaBinding) throw new Error('no XRMediaBinding');
      const res = await fetch(urlFor(it), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();

      // Decoded straight to the size shown: an original here runs to 7216x2272,
      // 62 MB of RGBA unresized. Even dimensions, to keep any video pipeline
      // downstream of the capture comfortable.
      const scaleTo = Math.min(1, maxTexture / Math.max(it.width, it.height));
      const even = (n) => Math.max(2, Math.round(n / 2) * 2);
      const w = even(it.width * scaleTo), h = even(it.height * scaleTo);
      const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      if (ended) { bitmap.close(); return false; }

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      // Frames on request rather than on a clock: the image never changes, so
      // the only reason to send one is to (re)establish the picture.
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const kick = () => {
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillRect(0, 0, 1, 1);          // marks the canvas dirty, changes nothing
        track.requestFrame?.();
      };
      const pv = document.createElement('video');
      pv.muted = true;
      pv.playsInline = true;
      pv.style.display = 'none';
      pv.srcObject = stream;
      document.body.append(pv);
      await pv.play();
      kick();
      await Promise.race([
        new Promise((resolve) => {
          if (pv.videoWidth > 0) { resolve(); return; }
          const retry = setInterval(kick, 250);
          pv.addEventListener('loadedmetadata', () => { clearInterval(retry); resolve(); }, { once: true });
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('photo stream produced no frames')), 5000)),
      ]);
      if (ended) { pv.remove(); track.stop(); return false; }
      // A trickle of frames keeps the layer fed without repainting anything.
      photo = { video: pv, timer: setInterval(kick, 1000) };

      const layout = layoutFor(it);
      if (it.projection === 'equirect360') {
        const sph = sphereFor(it);
        mediaLayer = mediaBinding.createEquirectLayer(pv, {
          space: refSpace, layout,
          transform: new XRRigidTransform(),
          radius: 0,
          centralHorizontalAngle: sph.central,
          upperVerticalAngle: sph.upper,
          lowerVerticalAngle: -sph.lower,
        });
        report(`photo ${it.label}`, `${w}x${h} media layer · ${Math.round(sph.upper * 360 / Math.PI)}° tall`, 'ok');
      } else {
        const vh = videoHalf(it);
        mediaLayer = mediaBinding.createQuadLayer(pv, {
          space: refSpace, layout,
          transform: new XRRigidTransform(pt(vPose), quatYaw(vPose.yaw)),
          width: vh.hw, height: vh.hh,
        });
        report(`photo ${it.label}`, `${w}x${h} media layer`, 'ok');
      }
      return true;
    }

    function dropStill() {
      stillItem = null;
      if (stillTex) { gl?.deleteTexture(stillTex); stillTex = null; }
    }

    /* Photos are drawn into the projection layer rather than given a layer of
     * their own. A dedicated GL-backed equirect layer is the better-looking
     * option in principle, but on this browser creating one cost the WebGL
     * context after exactly one frame, every time — the same signature as the
     * projection layer's depth mismatch, and equally fatal. The projection
     * layer is proven here at thousands of frames, so that is where stills go.
     *
     * Decoding goes straight to the size being uploaded: an equirectangular
     * original here runs to 7216x2272, which is 62 MB of RGBA unresized, for one
     * photo, on a renderer that has already shown what it does when pushed. */
    async function loadStill(it) {
      if (!gl || !scene) {
        throw new Error('photos need a WebGL context, which this browser is currently refusing');
      }
      const res = await fetch(urlFor(it), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();

      const cap = Math.min(maxTexture, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      const scaleTo = Math.min(1, cap / Math.max(it.width, it.height));
      const texW = Math.max(1, Math.round(it.width * scaleTo));
      const texH = Math.max(1, Math.round(it.height * scaleTo));
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: texW, resizeHeight: texH, resizeQuality: 'high',
      });
      if (ended) { bitmap.close(); return; }

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      bitmap.close();

      stillTex = tex;
      stillItem = it;
      report(`photo ${it.label}`, `${texW}x${texH} from ${it.width}x${it.height}`, 'ok');
    }

    async function loadIndex(next, reason) {
      if (switching || !playlist.length) return;
      switching = true;
      idx = (next + playlist.length) % playlist.length;
      const it = item();
      opts.onIndex?.(idx, it);
      log(`${reason}: ${idx + 1}/${playlist.length} — ${it.label}`);

      // Both layer kinds are bound to their content's dimensions at creation,
      // so neither survives a switch.
      mediaLayer = null;
      dropStill();
      setLayers();
      dropPhoto();       // after the layer is out of the render state
      scene?.setStatus([it.label, `${it.width}x${it.height} ${it.codec || ''}`,
        `${idx + 1} of ${playlist.length}`, 'trigger/A play · squeeze/B exit · stick ←→ clip · ↑↓ seek']);
      scene?.setProgress({ bufferedFrac: -1, playFrac: 0, label: 'loading…' });

      video.pause();
      if (it.kind === 'image') {
        video.removeAttribute('src');
        video.load();
        try {
          if (photoPath === 'media') {
            if (!(await loadPhotoLayer(it))) { switching = false; return; }
          } else {
            await loadStill(it);
          }
          if (ended) { switching = false; return; }
          setLayers();
          applyPoses();
          scene?.setStatus([it.label, `${it.width}x${it.height}`,
            `${idx + 1} of ${playlist.length}`, 'squeeze/B exit · stick ←→ photo']);
          scene?.setProgress(null);
        } catch (err) {
          report(`load ${it.label}`, `failed — ${err.message}`, 'fail');
          scene?.setStatus([it.label, '!could not load', `!${err.message}`, 'stick ← → for another']);
          opts.flush?.('load-failure');
        }
        switching = false;
        return;
      }

      video.src = urlFor(it);
      video.loop = true;
      video.muted = !wantSound;
      video.load();

      try {
        await new Promise((resolve, reject) => {
          const ok = () => { cleanup(); resolve(); };
          const bad = () => {
            cleanup();
            const c = video.error?.code;
            reject(new Error(MEDIA_ERR[c] || `media error ${c}`));
          };
          const cleanup = () => {
            video.removeEventListener('loadedmetadata', ok);
            video.removeEventListener('error', bad);
          };
          video.addEventListener('loadedmetadata', ok, { once: true });
          video.addEventListener('error', bad, { once: true });
          setTimeout(() => { cleanup(); reject(new Error('timed out after 30s')); }, 30000);
        });
      } catch (err) {
        report(`load ${it.label}`, `failed — ${err.message}`, 'fail');
        scene?.setStatus([it.label, '!could not load', `!${err.message}`, 'stick ← → for another']);
        opts.flush?.('load-failure');
        switching = false;
        return;
      }

      if (ended) { switching = false; return; }
      try {
        mediaLayer = makeMediaLayer(it);
        setLayers();
        applyPoses();
      } catch (err) {
        report(`layer ${it.label}`, `failed — ${err.message}`, 'fail');
        scene?.setStatus([it.label, '!layer failed', `!${err.message}`, 'squeeze exit']);
      }

      try {
        await video.play();
      } catch (err) {
        if (wantSound && !video.muted) {
          video.muted = true;
          try { await video.play(); } catch { /* reported below */ }
        }
        if (video.paused) report('playback', `play() rejected — ${err.message}`, 'fail');
      }
      switching = false;
    }

    /* Controller input. Trigger and grip arrive as session events, but axes and
     * face buttons have to be polled, so everything else lives here.
     *
     * Deliberately not a pointable UI panel: anything the app draws needs the
     * projection layer, which rules out passthrough on this browser, and the
     * point of these controls is that they work in either session kind. */
    let stickLatched = false, pauseLatched = false, exitLatched = false, lastPoll = 0;

    function pollInput(time) {
      const dt = lastPoll ? Math.min(0.1, (time - lastPoll) / 1000) : 0;
      lastPoll = time;

      let x = 0, y = 0, pause = false, quit = false;
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (!gp) continue;
        for (const a of [gp.axes[2], gp.axes[0]]) {
          if (typeof a === 'number' && Math.abs(a) > Math.abs(x)) x = a;
        }
        for (const a of [gp.axes[3], gp.axes[1]]) {
          if (typeof a === 'number' && Math.abs(a) > Math.abs(y)) y = a;
        }
        if (gp.buttons[4]?.pressed) pause = true;
        if (gp.buttons[5]?.pressed) quit = true;
      }

      if (quit && !exitLatched && settled()) { log('B/Y: ending session'); session.end(); }
      exitLatched = quit;

      if (pause && !pauseLatched && video.readyState >= 2) {
        video.paused ? video.play().catch(() => {}) : video.pause();
      }
      pauseLatched = pause;

      // Horizontal changes clip, vertical seeks; whichever the stick is mostly
      // doing wins, so a diagonal nudge cannot do both.
      if (Math.abs(x) >= Math.abs(y)) {
        if (Math.abs(x) < 0.5) { stickLatched = false; }
        else if (!stickLatched) {
          stickLatched = true;
          loadIndex(idx + (x > 0 ? 1 : -1), x > 0 ? 'next' : 'previous');
        }
        seeking = false;
      } else if (Math.abs(y) > 0.35 && Number.isFinite(video.duration) && video.duration > 0) {
        // Scrub proportionally: a long clip moves faster, so crossing it never
        // takes much more than a dozen seconds of holding.
        const rate = Math.max(2, video.duration * 0.08);
        const next = video.currentTime + (-y * rate * dt);
        video.currentTime = Math.min(video.duration - 0.05, Math.max(0, next));
        seeking = true;
      } else {
        seeking = false;
      }
    }

    const onFrame = (time, frame) => {
      if (ended) return;
      frames++;
      if (frames === 1 && (!gl || !usingProjection)) {
        report('render target', usingProjection ? 'projection layer' : 'media layer only — no GL rendering',
          'info');
        opts.flush?.('first-frame');
      }
      try {
        const viewer = frame.getViewerPose(refSpace);
        if (viewer) head = pt(viewer.transform.position);
        pollInput(time);
        updateDrag(frame);
        updatePanel(frame);
        updatePane(frame);
        drawFrame(time, frame);
      } catch (err) {
        frameErrors++;
        if (frameErrors === 1) {
          report('frame loop', `threw — ${err.message}`, 'fail');
          log(`!frame loop threw: ${err.message}`);
          opts.flush?.('frame-error');
        }
        if (frameErrors === 6) drawingDisabled = true;
      }
      session.requestAnimationFrame(onFrame);
    };

    const drawFrame = (time, frame) => {
      if (drawingDisabled || glDead || !gl || !scene) return;

      if (!usingProjection && !glLayer) return;
      const pose = frame.getViewerPose(refSpace);
      if (!pose) return;

      if (video.readyState > 0 && Number.isFinite(video.duration) && video.duration > 0) {
        let bufEnd = 0;
        try {
          for (let i = 0; i < video.buffered.length; i++) bufEnd = Math.max(bufEnd, video.buffered.end(i));
        } catch { /* buffered throws before anything loads */ }
        scene.setProgress({
          bufferedFrac: bufEnd / video.duration,
          playFrac: video.currentTime / video.duration,
          label: `${video.currentTime.toFixed(1)} / ${video.duration.toFixed(1)} s` +
                 `${seeking ? ' · seeking' : video.paused ? ' · paused' : ''}`,
        });
      }

      const it = item();
      const layout = layoutFor(it);
      const drawVideo = mode === 'webgl' && video.readyState >= 2;
      if (drawVideo) {
        const t0 = performance.now();
        gl.bindTexture(gl.TEXTURE_2D, scene.videoTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        uploadMs += performance.now() - t0;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, usingProjection ? fb : glLayer.framebuffer);

      for (const view of pose.views) {
        let vp;
        if (usingProjection) {
          const sub = glBinding.getViewSubImage(projLayer, view);
          const arrayed = sub.imageIndex !== undefined && sub.imageIndex !== null;
          if (arrayed) {
            gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, sub.colorTexture, 0, sub.imageIndex);
          } else {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sub.colorTexture, 0);
          }
          vp = sub.viewport;
        } else {
          vp = glLayer.getViewport(view);
        }
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        if (isAR) gl.clearColor(0, 0, 0, 0);          // let the room through
        else gl.clearColor(0.06, 0.13, 0.20, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const viewProj = mul(view.projectionMatrix, view.transform.inverse.matrix);

        if (stillTex && stillItem) {
          const sLayout = layoutFor(stillItem);
          const right = view.eye === 'right';
          const uv = sLayout === 'stereo-left-right' ? [right ? 0.5 : 0, 0, 0.5, 1]
            : sLayout === 'stereo-top-bottom' ? [0, right ? 0.5 : 0, 1, 0.5]
            : [0, 0, 1, 1];
          if (stillItem.projection === 'equirect360') {
            // Centred on the head so the viewer is always at the middle of the
            // projection, and large enough to read as infinitely far away.
            const eye = view.transform.position;
            scene.drawSphere(viewProj, mul(translate(eye.x, eye.y, eye.z), scale(50, 50, 50)),
              stillTex, uv);
          } else {
            const a = eyeAspect(sLayout, stillItem.width, stillItem.height);
            scene.drawQuad(viewProj,
              mul(mul(translate(vPose.x, vPose.y, vPose.z), rotY(vPose.yaw)),
                  scale(widthM / 2, (widthM / a) / 2, 1)),
              stillTex, uv);
          }
        } else if (!isAR) {
          // A photo is its own surroundings; grid lines over it would only be
          // in the way.
          scene.drawGrid(viewProj);
        }
        if (!panelLayer) scene.drawBoard(viewProj);

        if (drawVideo) {
          const aspect = eyeAspect(layout, it.width, it.height);
          const h = widthM / aspect;
          const right = view.eye === 'right';
          const uvXform = layout === 'stereo-left-right' ? [right ? 0.5 : 0, 0, 0.5, 1]
            : layout === 'stereo-top-bottom' ? [0, right ? 0.5 : 0, 1, 0.5]
            : [0, 0, 1, 1];
          scene.drawQuad(viewProj,
            mul(mul(translate(vPose.x, vPose.y, vPose.z), rotY(vPose.yaw)), scale(widthM / 2, h / 2, 1)),
            scene.videoTex, uvXform);
        }
      }
    };

    session.requestAnimationFrame(onFrame);
    await loadIndex(idx, 'opening');

    return {
      session,
      next: () => loadIndex(idx + 1, 'next'),
      previous: () => loadIndex(idx - 1, 'previous'),
      end: () => session.end(),
    };
  }

  const MEDIA_ERR = {
    1: 'MEDIA_ERR_ABORTED — fetch aborted',
    2: 'MEDIA_ERR_NETWORK — network failed mid-load',
    3: 'MEDIA_ERR_DECODE — data corrupt or codec unsupported after starting',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED — source rejected before decode',
  };

  global.XRProbe = { run };
})(window);
