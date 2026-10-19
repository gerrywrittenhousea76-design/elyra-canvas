import { describe, expect, it, vi } from 'vitest';
import {
  ImageUploadError,
  USER_IMAGE_MAX_BYTES,
  sanitizeUserImageFile,
  sniffImageMime,
  validateImageStructure,
  validateUserImageFile,
  type UserImageFile,
} from './image-upload';

const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const u32be = (value: number) => new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const u32le = (value: number) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
const text = (value: string) => new Uint8Array([...value].map((character) => character.charCodeAt(0)));

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array) => {
  const payload = concat(text(type), data);
  return concat(u32be(data.length), payload, u32be(crc32(payload)));
};

const png = (width = 2, height = 2) => {
  const header = concat(u32be(width), u32be(height), new Uint8Array([8, 6, 0, 0, 0]));
  // Structure validation deliberately leaves pixel inflation to createImageBitmap.
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array([0x78, 0x01, 0x01])),
    pngChunk('IEND', new Uint8Array()),
  );
};

const jpeg = (width = 2, height = 2) => concat(
  new Uint8Array([0xff, 0xd8]),
  new Uint8Array([0xff, 0xc0, 0x00, 0x0b, 0x08, (height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff, 0x01, 0x01, 0x11, 0x00]),
  new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
  new Uint8Array([0x11, 0xff, 0x00, 0x22, 0xff, 0xd9]),
);

const webp = (width = 2, height = 2) => {
  const dimensions = ((height - 1) << 14) | (width - 1);
  const payload = concat(new Uint8Array([0x2f]), u32le(dimensions));
  const chunk = concat(text('VP8L'), u32le(payload.length), payload, new Uint8Array([0]));
  return concat(text('RIFF'), u32le(4 + chunk.length), text('WEBP'), chunk);
};

const file = (bytes: Uint8Array, name: string, type: string): UserImageFile => {
  const value = new Blob([bytes], { type }) as UserImageFile;
  Object.defineProperty(value, 'name', { value: name, enumerable: true });
  return value;
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(ImageUploadError);
    expect((error as ImageUploadError).code).toBe(code);
  }
};

describe('CORE-007 user image structural validation', () => {
  it.each([
    ['PNG', png(), 'image/png', 2, 2],
    ['JPEG', jpeg(), 'image/jpeg', 2, 2],
    ['WebP', webp(), 'image/webp', 2, 2],
  ] as const)('accepts a complete %s with an exact terminal boundary', (_label, bytes, mimeType, width, height) => {
    expect(sniffImageMime(bytes)).toBe(mimeType);
    expect(validateImageStructure(bytes)).toEqual({ mimeType, width, height });
  });

  it.each([
    ['PNG', png()],
    ['JPEG', jpeg()],
    ['WebP', webp()],
  ])('rejects truncated and appended-polyglot %s bytes', (_label, bytes) => {
    expect(() => validateImageStructure(bytes.slice(0, -1))).toThrow(ImageUploadError);
    expect(() => validateImageStructure(concat(bytes, text('PK\u0003\u0004evil')))).toThrowError('IMAGE_TRAILING_DATA');
  });

  it('checks extension, declared MIME, and magic as three independent boundaries', async () => {
    await expectCode(validateUserImageFile(file(png(), 'safe.jpg', 'image/png')), 'IMAGE_EXTENSION_MIME_MISMATCH');
    await expectCode(validateUserImageFile(file(png(), 'safe.png', 'image/jpeg')), 'IMAGE_EXTENSION_MIME_MISMATCH');
    await expectCode(validateUserImageFile(file(jpeg(), 'safe.png', 'image/png')), 'IMAGE_MAGIC_MIME_MISMATCH');
    await expectCode(validateUserImageFile(file(png(), 'safe.gif', 'image/png')), 'IMAGE_UNSUPPORTED_EXTENSION');
    await expectCode(validateUserImageFile(file(png(), 'safe.png', 'application/octet-stream')), 'IMAGE_UNSUPPORTED_MIME');
  });

  it.each([
    ['GIF', 'private.gif', 'image/gif'],
    ['SVG', 'private.svg', 'image/svg+xml'],
    ['HEIC', 'private.heic', 'image/heic'],
    ['AVIF', 'private.avif', 'image/avif'],
  ] as const)('rejects unsupported %s before reading bytes or beginning upload', async (_label, name, type) => {
    const value = {
      name,
      type,
      size: 128,
      arrayBuffer: vi.fn(),
    } as unknown as UserImageFile;

    await expectCode(validateUserImageFile(value), 'IMAGE_UNSUPPORTED_MIME');
    expect(value.arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects oversize input before reading or decoding it', async () => {
    const value = {
      name: 'large.png',
      type: 'image/png',
      size: USER_IMAGE_MAX_BYTES + 1,
      arrayBuffer: vi.fn(),
    } as unknown as UserImageFile;
    await expectCode(validateUserImageFile(value), 'IMAGE_TOO_LARGE');
    expect(value.arrayBuffer).not.toHaveBeenCalled();
  });

  it('normalizes an unreadable local file to a stable non-sensitive error code', async () => {
    const value = {
      name: 'safe.png',
      type: 'image/png',
      size: 100,
      arrayBuffer: vi.fn(async () => { throw new Error('/Users/private/source.png'); }),
    } as unknown as UserImageFile;
    await expectCode(validateUserImageFile(value), 'IMAGE_READ_FAILED');
  });

  it('rejects impossible dimensions before browser decoding', async () => {
    await expectCode(validateUserImageFile(file(png(8193, 1), 'wide.png', 'image/png')), 'IMAGE_DIMENSIONS_TOO_LARGE');
    await expectCode(validateUserImageFile(file(png(6000, 5000), 'bomb.png', 'image/png')), 'IMAGE_DIMENSIONS_TOO_LARGE');
  });
});

describe('CORE-007 browser decode and metadata-stripping boundary', () => {
  it.each([
    ['JPEG', jpeg(), 'private-client-name-and-gps.jpg', 'image/jpeg'],
    ['PNG', png(), 'private-client-name-and-gps.png', 'image/png'],
    ['WebP', webp(), 'private-client-name-and-gps.webp', 'image/webp'],
  ] as const)('accepts %s, decodes pixels, re-encodes to clean PNG, and drops the original name', async (_label, bytes, name, type) => {
    const input = file(bytes, name, type);
    const outputPng = new Blob([png()], { type: 'image/png' });
    const drawImage = vi.fn();
    const close = vi.fn();
    const result = await sanitizeUserImageFile(input, {
      projectId: 'local-demo',
      createImageBitmap: vi.fn(async () => ({ width: 2, height: 2, close })),
      createCanvas: (width, height) => ({
        width,
        height,
        getContext: () => ({ drawImage }),
        convertToBlob: async () => outputPng,
      }),
    });

    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ width: 2, height: 2, sanitizedBlob: outputPng });
    expect(result.assetId).toMatch(/^asset-local-[0-9a-f]{32}$/);
    expect(result.storage).toMatchObject({
      projectId: 'local-demo',
      mimeType: 'image/png',
      bytes: outputPng.size,
    });
    expect(result.storage.locator).toMatch(/^indexeddb:\/\/elyra-assets\/local-demo\/blob-[0-9a-f]{32}$/);
    expect(result.storage.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(input.name);
    expect(result).not.toHaveProperty('name');
  });

  it('fails closed on decoder disagreement, decode failure, and invalid encoder output', async () => {
    const input = file(png(), 'safe.png', 'image/png');
    await expectCode(sanitizeUserImageFile(input, {
      projectId: 'local-demo',
      createImageBitmap: async () => ({ width: 3, height: 2 }),
      createCanvas: () => { throw new Error('must not render'); },
    }), 'IMAGE_DECODE_DIMENSION_MISMATCH');
    await expectCode(sanitizeUserImageFile(input, {
      projectId: 'local-demo',
      createImageBitmap: async () => { throw new Error('decoder error'); },
    }), 'IMAGE_DECODE_FAILED');
    await expectCode(sanitizeUserImageFile(input, {
      projectId: 'local-demo',
      createImageBitmap: async () => ({ width: 2, height: 2 }),
      createCanvas: (width, height) => ({
        width,
        height,
        getContext: () => ({ drawImage: () => undefined }),
        convertToBlob: async () => new Blob(['not a PNG'], { type: 'image/png' }),
      }),
    }), 'IMAGE_REENCODE_FAILED');
  });
});
