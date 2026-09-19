import sharp from 'sharp';
import { mkdir, readdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const images = path.join(root, 'public/images');
await mkdir(images, { recursive: true });
const usePublished = process.argv.includes('--published');
if (usePublished) {
  const manifest = JSON.parse(await readFile(path.join(images, 'manifest.json'), 'utf8'));
  for (const name of ['hero', 'portrait', 'motion', 'detail']) {
    const item = manifest[name];
    if (!item?.width || !item?.height || !Array.isArray(item.widths)) throw new Error(`Missing published image manifest: ${name}`);
    for (const width of item.widths) for (const extension of ['avif', 'webp', 'jpg']) await access(path.join(images, `${name}-${width}.${extension}`));
  }
  await access(path.join(images, 'og.jpg'));
} else {
const originals = await readdir(path.join(root, 'photos'));
const heroes = originals.filter((name) => /^hero\.(jpe?g|png|webp|avif)$/i.test(name));
if (heroes.length !== 1) throw new Error('Expected exactly one original named hero with an image extension.');
const selection = [
  ['hero', heroes[0]],
  ['portrait', 'IMG-20260918-WA0062.jpg'],
  ['motion', 'IMG-20260918-WA0064.jpg'],
  ['detail', 'IMG-20260918-WA0066.jpg'],
];
const pipeline = 'warm-stone-v1';
let previous = {};
try { previous = JSON.parse(await readFile(path.join(images, 'manifest.json'), 'utf8')); } catch {}
const manifest = {};
for (const [name, filename] of selection) {
  const input = await readFile(path.join(root, 'photos', filename));
  const hash = createHash('sha256').update(input).update(pipeline).digest('hex');
  const meta = await sharp(input).metadata();
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) throw new Error(`Missing dimensions: ${filename}`);
  const widths = [...new Set([Math.min(480, width), width])];
  const outputs = widths.flatMap((size) => ['avif', 'webp', 'jpg'].map((ext) => `${name}-${size}.${ext}`));
  const exists = await Promise.all(outputs.map((file) => access(path.join(images, file)).then(() => true, () => false)));
  if (previous[name]?.hash !== hash || exists.some((found) => !found)) {
    for (const size of widths) {
      const base = sharp(input).rotate().resize({ width: size, withoutEnlargement: true })
        .modulate({ saturation: 0.88, brightness: 1.01 })
        .recomb([[1.015, 0, 0], [0, 1, 0], [0, 0, 0.985]]);
      // Sharp strips metadata by default; never call withMetadata/keepMetadata.
      await Promise.all([
        base.clone().avif({ quality: 55, effort: 5 }).toFile(path.join(images, `${name}-${size}.avif`)),
        base.clone().webp({ quality: 80 }).toFile(path.join(images, `${name}-${size}.webp`)),
        base.clone().jpeg({ quality: 83, mozjpeg: true }).toFile(path.join(images, `${name}-${size}.jpg`)),
      ]);
    }
    console.log(`Generated ${name}: ${width}×${height}`);
  }
  manifest[name] = { hash, width, height, widths };
}
if (previous.hero?.hash !== manifest.hero.hash || !(await access(path.join(images, 'og.jpg')).then(() => true, () => false))) {
  const portrait = await sharp(path.join(images, `hero-${manifest.hero.width}.jpg`)).resize(420, 630).jpeg().toBuffer();
  const caption = Buffer.from('<svg width="1200" height="630"><rect width="1200" height="630" fill="#f2ebdd"/><rect x="450" y="36" width="710" height="558" fill="none" stroke="#b69760"/><text x="805" y="255" text-anchor="middle" font-family="Georgia,serif" font-size="74" fill="#24231f">Ravina &amp; Varad</text><text x="805" y="325" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#655a4c">28–29 NOVEMBER 2026</text><text x="805" y="375" text-anchor="middle" font-family="sans-serif" font-size="25" fill="#655a4c">Ellora Heritage Resort</text><text x="805" y="475" text-anchor="middle" font-family="Georgia,serif" font-size="28" fill="#655a4c">#ravafry</text></svg>');
  await sharp(caption).composite([{ input: portrait, left: 0, top: 0 }]).jpeg({ quality: 85 }).toFile(path.join(images, 'og.jpg'));
}
await writeFile(path.join(images, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

const fonts = path.join(root, 'public/fonts');
await mkdir(fonts, { recursive: true });
for (const [family, alias] of [['cormorant-garamond', 'cormorant'], ['manrope', 'manrope']]) {
  await copyFile(path.join(root, `node_modules/@fontsource/${family}/files/${family}-latin-400-normal.woff2`), path.join(fonts, `${alias}-latin.woff2`));
  await copyFile(path.join(root, `node_modules/@fontsource/${family}/LICENSE`), path.join(fonts, `${family}-LICENSE.txt`));
}

const calendar = path.join(root, 'public/calendar');
await mkdir(calendar, { recursive: true });
const events = [
  ['haldi', 'Haldi Ceremony', '20261128T053000Z'],
  ['sangeet', 'Sangeet', '20261128T123000Z'],
  ['wedding', 'Wedding Day', '20261129T033000Z'],
];
for (const [slug, title, start] of events) {
  const content = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ravina and Varad//Wedding Invitation//EN',
    'CALSCALE:GREGORIAN', 'BEGIN:VEVENT', `UID:ravafry-2026-${slug}`,
    'DTSTAMP:20260918T000000Z', `DTSTART:${start}`, `SUMMARY:Ravina & Varad — ${title}`,
    'LOCATION:Ellora Heritage Resort\\, Ellora\\, Maharashtra',
    `DESCRIPTION:All times are Asia/Kolkata (IST).${slug === 'wedding' ? ' Wedding starts at 9:00 AM onwards.' : ''}\\nLocation: 25C9+7R Ellora\\, Verul\\, Maharashtra`,
    'URL:https://maps.app.goo.gl/qro5UMtjsWSG8WXW6?g_st=ic', 'END:VEVENT', 'END:VCALENDAR',
  ].map(foldLine).join('\r\n') + '\r\n';
  await writeFile(path.join(calendar, `${slug}.ics`), content);
}
function foldLine(line) {
  let result = '', bytes = 0;
  for (const char of line) {
    const length = Buffer.byteLength(char);
    if (bytes + length > 75) { result += '\r\n '; bytes = 1; }
    result += char; bytes += length;
  }
  return result;
}
