/**
 * Copies the globe textures out of three-globe into ./assets so the
 * published site has no third-party runtime requests at all.
 */
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const src = 'node_modules/three-globe/example/img';
const dest = 'assets';
const files = ['earth-night.jpg', 'earth-blue-marble.jpg', 'earth-topology.png', 'night-sky.png'];

if (!existsSync(src)) {
  console.error('three-globe not installed — run `npm install` first.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const f of files) {
  copyFileSync(join(src, f), join(dest, f));
  console.log('copied', f);
}
