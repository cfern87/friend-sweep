#!/usr/bin/env node
// Render the extension icons from the SVG sources in design/ into icons/.
//
//   npm run icons
//
// Each size has the source drawn for it rather than one image scaled down:
// the 128px store icon keeps the 16px transparent padding the Chrome Web Store
// asks for, while the toolbar sizes fill their square and drop detail that
// turns to noise at 16px. Edit the SVGs, then re-run this and commit both.

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const OUTPUTS = [
  { size: 16, src: 'icon-16.svg' },
  { size: 32, src: 'icon-small.svg' },
  { size: 48, src: 'icon-small.svg' },
  { size: 128, src: 'icon.svg' },
];

mkdirSync(join(root, 'icons'), { recursive: true });
for (const { size, src } of OUTPUTS) {
  const svg = readFileSync(join(root, 'design', src), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(root, 'icons', `icon${size}.png`), png);
  console.log(`  icons/icon${size}.png  <- design/${src}`);
}
