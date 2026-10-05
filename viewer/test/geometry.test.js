// Geometry checks for the pointing, facing, docking and stereo-packing maths in
// public/xr.js, run against the real helpers extracted from that file.
//   node test/geometry.test.js < public/xr.js
// Pulls the real helpers out of xr.js and exercises the geometry.
const src = require('fs').readFileSync('/dev/stdin', 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp(`(function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}|const ${name} = [^;]*;)`));
  if (!m) throw new Error(`missing ${name}`);
  return m[1];
};
eval([grab('qmul'), grab('quatYaw'), grab('quatYawPitch'), grab('clamp'), grab('dot'), grab('qrot'), grab('eyeAspect')].join('\n').replace(/^const /gm, 'var '));

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };

// Same rayQuad as xr.js.
function rayQuad(o, orient, c, q, hw, hh) {
  const d = qrot(orient, { x: 0, y: 0, z: -1 });
  const n = qrot(q, { x: 0, y: 0, z: 1 });
  const denom = dot(d, n); if (Math.abs(denom) < 1e-4) return null;
  const t = ((c.x - o.x) * n.x + (c.y - o.y) * n.y + (c.z - o.z) * n.z) / denom;
  if (t <= 0) return null;
  const h = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  const rel = { x: h.x - c.x, y: h.y - c.y, z: h.z - c.z };
  const lu = dot(rel, qrot(q, { x: 1, y: 0, z: 0 })) / hw;
  const lv = dot(rel, qrot(q, { x: 0, y: 1, z: 0 })) / hh;
  if (lu < -1 || lu > 1 || lv < -1 || lv > 1) return null;
  return { t, u: (lu + 1) / 2, v: 1 - (lv + 1) / 2 };
}
const I = { x: 0, y: 0, z: 0, w: 1 };

let v = qrot(quatYaw(0), { x: 0, y: 0, z: 1 });
check('yaw 0 keeps the quad facing +Z (towards a viewer at the origin)', near(v.x, 0) && near(v.z, 1));
v = qrot(quatYaw(Math.PI / 2), { x: 0, y: 0, z: 1 });
check('yaw 90° turns the normal to +X', near(v.x, 1) && near(v.z, 0));

const faceYaw = (head, o) => Math.atan2(head.x - o.x, head.z - o.z);
const head = { x: 0, y: 1.6, z: 0 };
check('faceYaw: object dead ahead needs no turn', near(faceYaw(head, { x: 0, z: -3 }), 0));
v = qrot(quatYaw(faceYaw(head, { x: -3, z: 0 })), { x: 0, y: 0, z: 1 });
check('faceYaw: object to the left turns to face the viewer (+X)', near(v.x, 1) && near(v.z, 0, 1e-9));

let h = rayQuad({ x: 0, y: 1.5, z: 0 }, I, { x: 0, y: 1.5, z: -3 }, quatYaw(0), 1.6, 0.9);
check('ray straight ahead hits the video centre', h && near(h.u, 0.5) && near(h.v, 0.5) && near(h.t, 3));
h = rayQuad({ x: 1.2, y: 2.2, z: 0 }, I, { x: 0, y: 1.5, z: -3 }, quatYaw(0), 1.6, 0.9);
check('up and to the right lands in the top-right (u>0.5, v<0.5)', h && h.u > 0.5 && h.v < 0.5);
check('a ray beside the quad misses', rayQuad({ x: 5, y: 1.5, z: 0 }, I, { x: 0, y: 1.5, z: -3 }, quatYaw(0), 1.6, 0.9) === null);
check('a ray pointing away misses', rayQuad({ x: 0, y: 1.5, z: -6 }, I, { x: 0, y: 1.5, z: -3 }, quatYaw(0), 1.6, 0.9) === null);

// Docked panel: under the video's bottom edge, not overlapping it.
const vPose = { x: 0, y: 1.5, z: -3, yaw: 0 }, vhh = 0.9;
const halfW = clamp(0.2 * 3, 0.18, 0.85), halfH = halfW / 4;
const drop = vhh + 0.06 + halfH;
const off = qrot(quatYaw(vPose.yaw), { x: 0, y: -drop, z: 0 });
const panelTop = vPose.y + off.y + halfH, videoBottom = vPose.y - vhh;
check(`docked panel sits below the video (top ${panelTop.toFixed(2)} < bottom ${videoBottom.toFixed(2)})`, panelTop < videoBottom);

// Panel facing a viewer above it tilts its normal upwards.
const pitch = -Math.atan2(head.y - 0.8, 1.5);
v = qrot(quatYawPitch(0, pitch), { x: 0, y: 0, z: 1 });
check('a panel below eye level tilts to face up at the viewer', v.y > 0 && v.z > 0);

// Stereo packing: every one of these should show each eye at 16:9 (or 4:3).
const ar = (l, w, h) => eyeAspect(l, w, h).toFixed(3);
check('full-width side-by-side 3840x1080 shows 16:9 eyes', ar('stereo-left-right', 3840, 1080) === '1.778');
check('half-width side-by-side 1920x1080 shows 16:9 eyes, not squeezed', ar('stereo-left-right', 1920, 1080) === '1.778');
check('full-height top/bottom 1920x2160 shows 16:9 eyes', ar('stereo-top-bottom', 1920, 2160) === '1.778');
check('half-height top/bottom 1920x1080 shows 16:9 eyes, not stretched', ar('stereo-top-bottom', 1920, 1080) === '1.778');
check('full-width side-by-side of 4:3 eyes 2880x1080 shows 4:3', ar('stereo-left-right', 2880, 1080) === '1.333');
check('mono is just the frame', ar('mono', 1920, 1080) === '1.778');
