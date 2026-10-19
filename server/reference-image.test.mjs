import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  normalizeCore009VideoReferencePng,
  planCore009VideoReferenceTransform,
  ReferenceImageError,
  sanitizeBrowserReferencePng,
  stripNonRenderingPngChunks,
  validateBrowserReferencePng,
} from './reference-image.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('validates and truly decodes a normal PNG, returning an anonymous sanitized file', async () => {
  const source = png({ width: 2, height: 2 });
  const inspected = validateBrowserReferencePng({ buffer: source, mimeType: 'image/png', extension: '.png' });
  assert.equal(inspected.width, 2);
  assert.equal(inspected.height, 2);
  assert.match(inspected.sha256, /^[0-9a-f]{64}$/);

  const result = await sanitizeBrowserReferencePng({ buffer: source, mimeType: 'image/png', extension: '.png' });
  assert.equal(result.mimeType, 'image/png');
  assert.match(result.serverFilename, /^[0-9a-f]{32}\.png$/);
  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  assert.equal(result.removedMetadata, true);
  assert.deepEqual(
    validateBrowserReferencePng({ buffer: result.buffer, mimeType: result.mimeType, extension: result.extension }).chunkTypes,
    ['IHDR', 'sRGB', 'IDAT', 'IEND'],
  );
});

test('CORE-009 center-crops without stretching and emits exact Sora pixels', async () => {
  assert.deepEqual(planCore009VideoReferenceTransform({ width: 64, height: 64 }), {
    target: { width: 1280, height: 720, aspectRatio: '1280x720' },
    cropWidth: 64,
    cropHeight: 36,
    offsetX: 0,
    offsetY: 14,
  });
  const wide = planCore009VideoReferenceTransform({ width: 80, height: 40 });
  assert.equal(wide.cropHeight, 40);
  assert.ok(wide.cropWidth < 80);
  assert.ok(wide.offsetX > 0);
  const tall = planCore009VideoReferenceTransform({ width: 40, height: 80 });
  assert.equal(tall.cropWidth, 40);
  assert.ok(tall.cropHeight < 80);
  assert.ok(tall.offsetY > 0);

  const source = png({ width: 64, height: 64 });
  const normalized = await normalizeCore009VideoReferencePng({ buffer: source, width: 64, height: 64 });
  assert.equal(normalized.aspectRatio, '1280x720');
  assert.equal(normalized.width, 1280);
  assert.equal(normalized.height, 720);
  assert.equal(normalized.mimeType, 'image/png');
  assert.match(normalized.serverFilename, /^[a-f0-9]{32}\.png$/);
  const chunkTypes = validateBrowserReferencePng({ buffer: normalized.buffer, mimeType: normalized.mimeType, extension: normalized.extension }).chunkTypes;
  assert.equal(chunkTypes[0], 'IHDR');
  assert.equal(chunkTypes.at(-1), 'IEND');
  assert.equal(chunkTypes.includes('IDAT'), true);
  assert.equal(chunkTypes.some((type) => ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)), false);
});

test('removes tEXt, eXIf and XMP iTXt chunks', async () => {
  const xmp = Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>private</x:xmpmeta>');
  const exif = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const source = png({
    width: 1,
    height: 1,
    ancillary: [chunk('tEXt', Buffer.from('Comment\0private')), chunk('eXIf', exif), chunk('iTXt', xmp)],
  });
  const inputHash = createHash('sha256').update(source).digest('hex');
  const inputChunks = validateBrowserReferencePng({ buffer: source, mimeType: 'image/png', extension: '.png' }).chunkTypes;
  const inputMetadataCount = inputChunks.filter((type) => ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)).length;
  const stripped = stripNonRenderingPngChunks(source);
  const chunks = validateBrowserReferencePng({ buffer: stripped, mimeType: 'image/png', extension: 'png' }).chunkTypes;
  assert.equal(chunks.includes('tEXt'), false);
  assert.equal(chunks.includes('eXIf'), false);
  assert.equal(chunks.includes('iTXt'), false);

  const result = await sanitizeBrowserReferencePng({ buffer: source, mimeType: 'image/png', extension: '.png' });
  const sanitizedChunks = validateBrowserReferencePng({ buffer: result.buffer, mimeType: 'image/png', extension: '.png' }).chunkTypes;
  const outputMetadataCount = sanitizedChunks.filter((type) => ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)).length;
  assert.equal(inputMetadataCount, 3);
  assert.equal(outputMetadataCount, 0);
  assert.match(inputHash, /^[0-9a-f]{64}$/);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(inputHash, result.sha256);
  console.log(`CORE007_METADATA_EVIDENCE input_sha256=${inputHash} output_sha256=${result.sha256} input_metadata_count=${inputMetadataCount} output_metadata_count=${outputMetadataCount}`);
});

test('rejects truncated PNG and any data after IEND, including a polyglot payload', () => {
  const source = png({ width: 1, height: 1 });
  assert.throws(
    () => validateBrowserReferencePng({ buffer: source.subarray(0, -3), mimeType: 'image/png', extension: '.png' }),
    (error) => error instanceof ReferenceImageError && error.code === 'REFERENCE_PNG_TRUNCATED',
  );
  assert.throws(
    () => validateBrowserReferencePng({ buffer: Buffer.concat([source, Buffer.from('<script>alert(1)</script>')]), mimeType: 'image/png', extension: '.png' }),
    (error) => error instanceof ReferenceImageError && error.code === 'REFERENCE_TRAILING_DATA',
  );
});

test('rejects oversized dimensions before attempting a pixel decode', () => {
  const source = png({ width: 8192, height: 8192, useDeclaredDimensionsOnly: true });
  assert.throws(
    () => validateBrowserReferencePng({ buffer: source, mimeType: 'image/png', extension: '.png' }),
    (error) => error instanceof ReferenceImageError && error.code === 'REFERENCE_DIMENSIONS_INVALID',
  );
});

test('rejects mismatched MIME, extension and PNG magic', () => {
  const source = png({ width: 1, height: 1 });
  assert.throws(() => validateBrowserReferencePng({ buffer: source, mimeType: 'image/jpeg', extension: '.png' }), /image\/png/);
  assert.throws(() => validateBrowserReferencePng({ buffer: source, mimeType: 'image/png', extension: '.jpg' }), /\.png/);
  assert.throws(
    () => validateBrowserReferencePng({ buffer: Buffer.from('not-png'), mimeType: 'image/png', extension: '.png' }),
    (error) => error instanceof ReferenceImageError && error.code === 'REFERENCE_MAGIC_INVALID',
  );
});

test('rejects structurally valid but undecodable pixel data', async () => {
  const source = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr(1, 1)),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x00, 0x01, 0x02, 0x03])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  validateBrowserReferencePng({ buffer: source, mimeType: 'image/png', extension: '.png' });
  await assert.rejects(
    () => sanitizeBrowserReferencePng({ buffer: source, mimeType: 'image/png', extension: '.png' }),
    (error) => error instanceof ReferenceImageError && error.code === 'REFERENCE_DECODE_FAILED',
  );
});

test('always removes the private processing directory after success and failure', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'elyra-reference-test-parent-'));
  try {
    await sanitizeBrowserReferencePng({ buffer: png({ width: 1, height: 1 }), mimeType: 'image/png', extension: '.png', temporaryParent: parent });
    assert.deepEqual(await readdir(parent), []);

    const invalidPixels = Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr(1, 1)),
      chunk('IDAT', Buffer.from([0x78, 0x9c, 0xff, 0xff])),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    await assert.rejects(() => sanitizeBrowserReferencePng({ buffer: invalidPixels, mimeType: 'image/png', extension: '.png', temporaryParent: parent }));
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

const png = ({ width, height, ancillary = [], useDeclaredDimensionsOnly = false }) => {
  const encodedWidth = useDeclaredDimensionsOnly ? 1 : width;
  const encodedHeight = useDeclaredDimensionsOnly ? 1 : height;
  const scanlines = Buffer.alloc(encodedHeight * (1 + encodedWidth * 4));
  for (let y = 0; y < encodedHeight; y += 1) {
    const row = y * (1 + encodedWidth * 4);
    scanlines[row] = 0;
    for (let x = 0; x < encodedWidth; x += 1) {
      const pixel = row + 1 + x * 4;
      scanlines[pixel] = 32 + x;
      scanlines[pixel + 1] = 96 + y;
      scanlines[pixel + 2] = 160;
      scanlines[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr(width, height)),
    ...ancillary,
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const ihdr = (width, height) => {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return data;
};

const chunk = (type, data) => {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
};

const table = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
