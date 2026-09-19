// Rasterize the extension icons from the owner-provided source PNG (extension/icon-source.png).
// resvg renders each size directly (cross-platform, smooth resampling — no qlmanage/sips downscale blur).
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const ext = resolve(import.meta.dirname, '..', 'extension');
mkdirSync(resolve(ext, 'icons'), { recursive: true });
const src = readFileSync(resolve(ext, 'icon-source.png'));
const href = 'data:image/png;base64,' + src.toString('base64');
// source is square (946x942 ≈ 1:1); render into a square viewBox at each target size
const VB = 946;
const render = (size) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VB} ${VB}"><image href="${href}" x="0" y="0" width="${VB}" height="${VB}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, imageRendering: 0 }).render().asPng();
  writeFileSync(resolve(ext, 'icons', `icon-${size}.png`), png);
};
for (const s of [16, 32, 48, 128]) render(s);
console.log('icons rendered from icon-source.png with resvg: 16, 32, 48, 128');
