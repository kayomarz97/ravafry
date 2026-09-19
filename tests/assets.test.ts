import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import sharp from 'sharp';

test('calendar starts represent the supplied IST times without invented end times', async () => {
  for (const [event, start] of [['haldi', '20261128T053000Z'], ['sangeet', '20261128T123000Z'], ['wedding', '20261129T033000Z']]) {
    const ics = await readFile(`public/calendar/${event}.ics`, 'utf8');
    assert.ok(ics.includes(`DTSTART:${start}\r\n`));
    assert.ok(!ics.includes('DTEND:'));
    assert.ok(ics.includes('Ellora Heritage Resort'));
    for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  }
});

test('published photographs have explicit dimensions and no original EXIF/GPS payload', async () => {
  for (const file of (await readdir('public/images')).filter((file) => /\.(jpg|webp|avif)$/.test(file))) {
    const metadata = await sharp(`public/images/${file}`).metadata();
    assert.ok(metadata.width && metadata.height);
    assert.equal(metadata.exif, undefined, file);
    assert.equal(metadata.xmp, undefined, file);
  }
});
