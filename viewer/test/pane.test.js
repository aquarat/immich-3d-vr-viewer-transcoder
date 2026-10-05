// Layout checks for the in-VR browser's hit-testing and scroll range, with a
// stubbed canvas so it runs headless.
//   node test/pane.test.js < public/xr.js
const src = require('fs').readFileSync('/dev/stdin', 'utf8');

// Just enough DOM for createPane to construct: every canvas call is a no-op.
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
global.document = {
  createElement: () => ({ getContext: () => noop, captureStream: () => ({ getTracks: () => [] }), style: {} }),
  body: { append() {} },
};
global.Image = function () { return { removeAttribute() {} }; };
global.performance = { now: () => 0 };

const start = src.indexOf('  function createPane() {');
const end = src.indexOf('\n  }\n', start) + 4;
eval(src.slice(start, end));
const pane = createPane();

const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };
const items = Array.from({ length: 324 }, (_, i) => ({ id: String(i), label: `clip ${i}`, kind: 'video' }));
const st = { tabs: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], items, scroll: 0 };
const { GRID, ROW_H, COLS } = pane;

check('top bar corner is the close button', pane.hit(1550, 60, st).id === 'close');
check('second tab is hit as tab 1', (() => { const h = pane.hit(100 + 330 + 16 + 100, 60, st); return h.id === 'tab' && h.index === 1; })());
check('grip area in the top bar is a drag handle', pane.hit(50, 60, st).id === 'drag');
check('first cell hits index 0', (() => { const h = pane.hit(GRID.x + 20, GRID.y + 20, st); return h.id === 'cell' && h.index === 0; })());
check('fourth column, first row is index 3', (() => {
  const colW = (GRID.w - 24 * (COLS - 1)) / COLS;
  const h = pane.hit(GRID.x + 3 * (colW + 24) + 20, GRID.y + 20, st);
  return h.id === 'cell' && h.index === 3;
})());
check('second row is index 4 onwards', (() => { const h = pane.hit(GRID.x + 20, GRID.y + ROW_H + 20, st); return h.id === 'cell' && h.index === 4; })());
check('scrolling by one row shifts the hit by four', (() => {
  const h = pane.hit(GRID.x + 20, GRID.y + 20, { ...st, scroll: ROW_H });
  return h.id === 'cell' && h.index === 4;
})());
check('the gap between cells scrolls rather than selects', pane.hit(GRID.x + (GRID.w - 72) / 4 + 12, GRID.y + 20, st).id === 'grid');
check('right edge is the scrollbar', pane.hit(pane.W - 30, GRID.y + GRID.h / 2, st).id === 'scrollbar');
check('scrollbar reports its position as a fraction', Math.abs(pane.hit(pane.W - 30, GRID.y + GRID.h / 2, st).frac - 0.5) < 0.01);
check('no scrollbar when everything fits', pane.hit(pane.W - 30, GRID.y + 50, { ...st, items: items.slice(0, 8) }).id !== 'scrollbar');
check('past the last item is empty grid, not a phantom cell',
  pane.hit(GRID.x + 20, GRID.y + ROW_H + 20, { ...st, items: items.slice(0, 3) }).id === 'grid');

const rows = Math.ceil(324 / COLS);
const max = pane.maxScroll(324);
check(`scroll range reaches the last row (${rows} rows, max ${max}px)`,
  max > 0 && (max + GRID.h) >= rows * ROW_H - 24);
check('an empty collection has nothing to scroll', pane.maxScroll(0) === 0);
