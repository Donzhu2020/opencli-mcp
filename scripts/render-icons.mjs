// Rasterize the extension icons crisply: resvg renders each PNG directly at its target pixel size (no downscaling,
// which is what softened the old qlmanage→sips pipeline). 48/128 use icon.svg; 16/32 use the bolder icon-small.svg.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const ext = resolve(import.meta.dirname, '..', 'extension');
const render = (svgFile, size) => {
  const svg = readFileSync(resolve(ext, svgFile), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, shapeRendering: 2, textRendering: 1, imageRendering: 0 }).render().asPng();
  writeFileSync(resolve(ext, 'icons', `icon-${size}.png`), png);
  return png.length;
};
for (const s of [16, 32]) render('icon-small.svg', s);
for (const s of [48, 128]) render('icon.svg', s);
console.log('icons rendered with resvg: 16, 32 (small) · 48, 128');
