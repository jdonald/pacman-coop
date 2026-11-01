// Generates the app icons (SVG + PNGs) for the PWA / home screen.
// Usage: node scripts/make-icons.cjs   (needs Playwright's Chromium installed)
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'client', 'public');

function pixels(fn, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fn(x + 0.5, y + 0.5)) out.push([x, y]);
  return out;
}

// Pixel-art pac facing right with an open mouth.
const pac = pixels((x, y) => {
  const dx = x - 8;
  const dy = y - 8;
  const d = Math.hypot(dx, dy);
  const a = Math.abs(Math.atan2(-dy, dx));
  return d <= 7.6 && !(a < 0.5 && d > 0.6);
}, 16, 16);

const GHOST = [
  '.....####.....', '...########...', '..##########..', '.############.', '.############.',
  '.############.', '##############', '##############', '##############', '##############',
  '##############', '##############', '##.###..###.##', '#...##..##...#',
];
const ghost = [];
GHOST.forEach((r, y) => [...r].forEach((c, x) => c === '#' && ghost.push([x, y])));
const eyes = [];
for (const ex of [3, 9]) {
  for (let j = 0; j < 4; j++) for (let i = 0; i < 3; i++) eyes.push([ex + i, 3 + j, '#ffffff']);
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) eyes.push([ex + 1 + i, 5 + j, '#2233dd']);
}

function sprite(px, ox, oy, s, front, side, depth) {
  let out = '';
  // Side (thickness) first, offset down-right, then the face on top.
  for (let k = depth; k > 0; k--) for (const [x, y] of px) out += `<rect x="${ox + x * s + k}" y="${oy + y * s + k}" width="${s}" height="${s}" fill="${side}"/>`;
  for (const [x, y, c] of px) out += `<rect x="${ox + x * s}" y="${oy + y * s}" width="${s + 0.5}" height="${s + 0.5}" fill="${c || front}"/>`;
  return out;
}

function svg({ scale = 1 } = {}) {
  const S = 512;
  let body = '';
  // Pellets
  for (const [x, y] of [[392, 236], [452, 236]]) body += `<rect x="${x}" y="${y}" width="28" height="28" fill="#fff"/><rect x="${x + 28}" y="${y + 6}" width="6" height="28" fill="#c9d4ff"/>`;
  body += sprite(ghost, 40, 214, 11, '#ff3b4e', '#a3142a', 12);
  body += sprite(eyes.map(([x, y, c]) => [x, y, c]), 40, 214, 11, '#fff', 'none', 0);
  body += sprite(pac, 150, 130, 15, '#ffd60a', '#b88a00', 16);
  const t = `translate(${(S * (1 - scale)) / 2} ${(S * (1 - scale)) / 2}) scale(${scale})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" shape-rendering="crispEdges">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a7bff"/><stop offset="1" stop-color="#1638d6"/></linearGradient></defs>
<rect width="${S}" height="${S}" fill="url(#bg)"/>
<g fill="#ffffff" fill-opacity="0.16"><rect x="30" y="40" width="70" height="70"/><rect x="400" y="380" width="80" height="80"/><rect x="380" y="60" width="44" height="44"/><rect x="70" y="410" width="50" height="50"/></g>
<g transform="${t}">${body}</g>
</svg>`;
}

(async () => {
  const icon = svg({ scale: 0.92 });
  const maskable = svg({ scale: 0.72 }); // keep art inside the maskable safe zone
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const render = async (markup, size, file) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0">${markup.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: false });
  };
  await render(icon, 192, 'icon-192.png');
  await render(icon, 512, 'icon-512.png');
  await render(maskable, 512, 'icon-maskable-512.png');
  await render(icon, 180, 'apple-touch-icon.png');
  await render(icon, 48, 'favicon.png');
  await browser.close();
  console.log('icons written to', OUT);
})();
