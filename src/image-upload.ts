import { createBlobLocator, sha256Blob, type BlobStorageMetadata } from './blob-store';

export const USER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const USER_IMAGE_MAX_EDGE = 8192;
export const USER_IMAGE_MAX_PIXELS = 25_000_000;

export type SupportedUserImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export type ImageUploadErrorCode =
  | 'IMAGE_EMPTY'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_INVALID_FILENAME'
  | 'IMAGE_UNSUPPORTED_EXTENSION'
  | 'IMAGE_UNSUPPORTED_MIME'
  | 'IMAGE_EXTENSION_MIME_MISMATCH'
  | 'IMAGE_UNKNOWN_MAGIC'
  | 'IMAGE_MAGIC_MIME_MISMATCH'
  | 'IMAGE_TRUNCATED'
  | 'IMAGE_TRAILING_DATA'
  | 'IMAGE_INVALID_STRUCTURE'
  | 'IMAGE_ANIMATION_UNSUPPORTED'
  | 'IMAGE_INVALID_DIMENSIONS'
  | 'IMAGE_DIMENSIONS_TOO_LARGE'
  | 'IMAGE_READ_FAILED'
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_DECODE_DIMENSION_MISMATCH'
  | 'IMAGE_CANVAS_UNAVAILABLE'
  | 'IMAGE_CANVAS_CONTEXT_UNAVAILABLE'
  | 'IMAGE_REENCODE_FAILED'
  | 'IMAGE_SANITIZED_TOO_LARGE'
  | 'IMAGE_CRYPTO_UNAVAILABLE'
  | 'IMAGE_DIGEST_FAILED'
  | 'IMAGE_INVALID_PROJECT_ID';

export class ImageUploadError extends Error {
  readonly code: ImageUploadErrorCode;

  constructor(code: ImageUploadErrorCode) {
    super(code);
    this.name = 'ImageUploadError';
    this.code = code;
  }
}

export interface ImageStructureInfo {
  mimeType: SupportedUserImageMime;
  width: number;
  height: number;
}

export interface UserImageFile extends Blob {
  readonly name: string;
}

interface DecodedImageLike {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

interface CanvasContextLike {
  drawImage(image: unknown, dx: number, dy: number, width?: number, height?: number): void;
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasContextLike | null;
  convertToBlob?(options: { type: 'image/png' }): Promise<Blob>;
  toBlob?(callback: (blob: Blob | null) => void, type: 'image/png'): void;
}

export interface SanitizeUserImageOptions {
  projectId: string;
  createImageBitmap?: (blob: Blob) => Promise<DecodedImageLike>;
  createCanvas?: (width: number, height: number) => CanvasLike;
  crypto?: Crypto;
  now?: () => Date;
}

export interface SanitizedUserImage {
  /** The only pixel payload returned. The original File is deliberately absent. */
  sanitizedBlob: Blob;
  assetId: string;
  storage: BlobStorageMetadata;
  width: number;
  height: number;
}

const EXTENSION_TO_MIME: Readonly<Record<string, SupportedUserImageMime>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const SUPPORTED_MIME = new Set<SupportedUserImageMime>(Object.values(EXTENSION_TO_MIME));

const fail = (code: ImageUploadErrorCode): never => {
  throw new ImageUploadError(code);
};

const readUint16Be = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1];
const readUint16Le = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const readUint24Le = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
const readUint32Be = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0;
const readUint32Le = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000)) >>> 0;

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array, start: number, end: number) => {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const parsePng = (bytes: Uint8Array): ImageStructureInfo => {
  if (bytes.length < 8) fail('IMAGE_TRUNCATED');
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let dataSequenceEnded = false;
  let sawPalette = false;
  let sawEnd = false;
  let colorType = -1;

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) fail('IMAGE_TRUNCATED');
    const length = readUint32Be(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) fail('IMAGE_TRUNCATED');
    const type = ascii(bytes, typeStart, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) fail('IMAGE_INVALID_STRUCTURE');
    if (readUint32Be(bytes, dataEnd) !== crc32(bytes, typeStart, dataEnd)) fail('IMAGE_INVALID_STRUCTURE');

    if (!sawHeader && type !== 'IHDR') fail('IMAGE_INVALID_STRUCTURE');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) fail('IMAGE_INVALID_STRUCTURE');
      sawHeader = true;
      width = readUint32Be(bytes, dataStart);
      height = readUint32Be(bytes, dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const validDepths: Readonly<Record<number, readonly number[]>> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!validDepths[colorType]?.includes(bitDepth)) fail('IMAGE_INVALID_STRUCTURE');
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0) {
        fail('IMAGE_INVALID_STRUCTURE');
      }
    } else if (type === 'IDAT') {
      if (!sawHeader || sawEnd || dataSequenceEnded || length === 0 || (colorType === 3 && !sawPalette)) {
        fail('IMAGE_INVALID_STRUCTURE');
      }
      sawData = true;
    } else if (type === 'PLTE') {
      if (sawPalette || sawData || length === 0 || length > 768 || length % 3 !== 0 || colorType === 0 || colorType === 4) {
        fail('IMAGE_INVALID_STRUCTURE');
      }
      sawPalette = true;
    } else if (type === 'IEND') {
      if (!sawHeader || !sawData || sawEnd || length !== 0) fail('IMAGE_INVALID_STRUCTURE');
      sawEnd = true;
      if (chunkEnd !== bytes.length) fail('IMAGE_TRAILING_DATA');
    } else if ((type.charCodeAt(0) & 0x20) === 0) {
      // Unknown critical chunks cannot be safely interpreted or re-encoded.
      fail('IMAGE_INVALID_STRUCTURE');
    }
    if (sawData && type !== 'IDAT') dataSequenceEnded = true;
    offset = chunkEnd;
  }

  if (!sawEnd) fail('IMAGE_TRUNCATED');
  return { mimeType: 'image/png', width, height };
};

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const parseJpeg = (bytes: Uint8Array): ImageStructureInfo => {
  if (bytes.length < 4) fail('IMAGE_TRUNCATED');
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail('IMAGE_INVALID_STRUCTURE');
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail('IMAGE_TRUNCATED');
    const marker = bytes[offset++];

    if (marker === 0x00) fail('IMAGE_INVALID_STRUCTURE');
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan) fail('IMAGE_INVALID_STRUCTURE');
      if (offset !== bytes.length) fail('IMAGE_TRAILING_DATA');
      return { mimeType: 'image/jpeg', width, height };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) fail('IMAGE_INVALID_STRUCTURE');
    if (bytes.length - offset < 2) fail('IMAGE_TRUNCATED');
    const segmentLength = readUint16Be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) fail('IMAGE_TRUNCATED');
    const dataStart = offset + 2;
    const segmentEnd = offset + segmentLength;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (sawFrame || segmentLength < 11) fail('IMAGE_INVALID_STRUCTURE');
      height = readUint16Be(bytes, dataStart + 1);
      width = readUint16Be(bytes, dataStart + 3);
      const components = bytes[dataStart + 5];
      if (components === 0 || segmentLength !== 8 + components * 3) fail('IMAGE_INVALID_STRUCTURE');
      sawFrame = true;
    }

    offset = segmentEnd;
    if (marker !== 0xda) continue;
    const scanComponents = bytes[dataStart];
    if (!sawFrame || scanComponents === 0 || segmentLength !== 6 + scanComponents * 2) fail('IMAGE_INVALID_STRUCTURE');
    sawScan = true;

    // Entropy-coded bytes run until an unescaped marker. Restart markers and
    // 0xff00 byte stuffing are part of the scan; another marker resumes the
    // outer parser (progressive JPEG may contain several scans).
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const entropyMarkerStart = offset;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) fail('IMAGE_TRUNCATED');
      const entropyMarker = bytes[offset];
      if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = entropyMarkerStart;
      break;
    }
    if (offset >= bytes.length) fail('IMAGE_TRUNCATED');
    if (offset === markerStart) fail('IMAGE_INVALID_STRUCTURE');
  }

  return fail('IMAGE_TRUNCATED');
};

const parseWebp = (bytes: Uint8Array): ImageStructureInfo => {
  if (bytes.length < 20) fail('IMAGE_TRUNCATED');
  const declaredLength = readUint32Le(bytes, 4) + 8;
  if (declaredLength > bytes.length) fail('IMAGE_TRUNCATED');
  if (declaredLength < bytes.length) fail('IMAGE_TRAILING_DATA');

  let offset = 12;
  let width = 0;
  let height = 0;
  let extendedWidth = 0;
  let extendedHeight = 0;
  let payloads = 0;

  while (offset < bytes.length) {
    if (bytes.length - offset < 8) fail('IMAGE_TRUNCATED');
    const type = ascii(bytes, offset, 4);
    const length = readUint32Le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) fail('IMAGE_TRUNCATED');
    if (type === 'ANIM' || type === 'ANMF') fail('IMAGE_ANIMATION_UNSUPPORTED');

    if (type === 'VP8X') {
      if (length !== 10 || extendedWidth !== 0 || extendedHeight !== 0) fail('IMAGE_INVALID_STRUCTURE');
      if ((bytes[dataStart] & 0x02) !== 0) fail('IMAGE_ANIMATION_UNSUPPORTED');
      extendedWidth = readUint24Le(bytes, dataStart + 4) + 1;
      extendedHeight = readUint24Le(bytes, dataStart + 7) + 1;
    } else if (type === 'VP8 ') {
      if (length < 10 || payloads > 0) fail('IMAGE_INVALID_STRUCTURE');
      if (bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) {
        fail('IMAGE_INVALID_STRUCTURE');
      }
      width = readUint16Le(bytes, dataStart + 6) & 0x3fff;
      height = readUint16Le(bytes, dataStart + 8) & 0x3fff;
      payloads += 1;
    } else if (type === 'VP8L') {
      if (length < 5 || payloads > 0 || bytes[dataStart] !== 0x2f) fail('IMAGE_INVALID_STRUCTURE');
      const dimensions = readUint32Le(bytes, dataStart + 1);
      width = (dimensions & 0x3fff) + 1;
      height = ((dimensions >>> 14) & 0x3fff) + 1;
      payloads += 1;
    }
    offset = chunkEnd;
  }

  if (offset !== bytes.length) fail('IMAGE_TRUNCATED');
  if (payloads !== 1) fail('IMAGE_INVALID_STRUCTURE');
  if (extendedWidth !== 0 && (extendedWidth !== width || extendedHeight !== height)) fail('IMAGE_INVALID_STRUCTURE');
  return { mimeType: 'image/webp', width, height };
};

export const sniffImageMime = (bytes: Uint8Array): SupportedUserImageMime | undefined => {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
};

export const validateImageStructure = (bytes: Uint8Array, expectedMime?: SupportedUserImageMime): ImageStructureInfo => {
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) fail('IMAGE_UNKNOWN_MAGIC');
  if (expectedMime && mimeType !== expectedMime) fail('IMAGE_MAGIC_MIME_MISMATCH');
  if (mimeType === 'image/png') return parsePng(bytes);
  if (mimeType === 'image/jpeg') return parseJpeg(bytes);
  return parseWebp(bytes);
};

const assertDimensions = ({ width, height }: Pick<ImageStructureInfo, 'width' | 'height'>) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) fail('IMAGE_INVALID_DIMENSIONS');
  if (width > USER_IMAGE_MAX_EDGE || height > USER_IMAGE_MAX_EDGE || width * height > USER_IMAGE_MAX_PIXELS) {
    fail('IMAGE_DIMENSIONS_TOO_LARGE');
  }
};

const extensionMime = (name: string): SupportedUserImageMime => {
  if (!name || name.includes('\0') || name.includes('/') || name.includes('\\')) fail('IMAGE_INVALID_FILENAME');
  const match = /\.([^.]+)$/.exec(name);
  if (!match) return fail('IMAGE_UNSUPPORTED_EXTENSION');
  const mimeType = EXTENSION_TO_MIME[match[1].toLowerCase()];
  if (!mimeType) fail('IMAGE_UNSUPPORTED_EXTENSION');
  return mimeType;
};

export const validateUserImageFile = async (file: UserImageFile): Promise<ImageStructureInfo> => {
  if (file.size <= 0) fail('IMAGE_EMPTY');
  if (file.size > USER_IMAGE_MAX_BYTES) fail('IMAGE_TOO_LARGE');
  const declaredMime = file.type as SupportedUserImageMime;
  if (!SUPPORTED_MIME.has(declaredMime)) fail('IMAGE_UNSUPPORTED_MIME');
  const fromExtension = extensionMime(file.name);
  if (fromExtension !== declaredMime) fail('IMAGE_EXTENSION_MIME_MISMATCH');
  const bytes = new Uint8Array(await file.arrayBuffer().catch(() => fail('IMAGE_READ_FAILED')));
  if (bytes.byteLength !== file.size) fail('IMAGE_TRUNCATED');
  const structure = validateImageStructure(bytes, declaredMime);
  assertDimensions(structure);
  return structure;
};

const randomHex = (cryptoApi: Crypto, length = 16) => {
  if (!cryptoApi?.getRandomValues) fail('IMAGE_CRYPTO_UNAVAILABLE');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const createSecureLocalAssetIdentity = (projectId: string, cryptoApi: Crypto = globalThis.crypto) => {
  if (!projectId.trim()) fail('IMAGE_INVALID_PROJECT_ID');
  const assetId = `asset-local-${randomHex(cryptoApi)}`;
  const blobKey = `blob-${randomHex(cryptoApi)}`;
  return { assetId, blobKey, locator: createBlobLocator(projectId, blobKey) } as const;
};

const defaultCreateBitmap = (blob: Blob): Promise<DecodedImageLike> => {
  if (typeof globalThis.createImageBitmap !== 'function') fail('IMAGE_DECODE_FAILED');
  return globalThis.createImageBitmap(blob);
};

const defaultCreateCanvas = (width: number, height: number): CanvasLike => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height) as unknown as CanvasLike;
  if (typeof document === 'undefined') fail('IMAGE_CANVAS_UNAVAILABLE');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas as unknown as CanvasLike;
};

const encodeCanvasPng = async (canvas: CanvasLike): Promise<Blob> => {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  if (!canvas.toBlob) fail('IMAGE_REENCODE_FAILED');
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob!((blob) => blob ? resolve(blob) : reject(new ImageUploadError('IMAGE_REENCODE_FAILED')), 'image/png');
  });
};

export const sanitizeUserImageFile = async (
  file: UserImageFile,
  options: SanitizeUserImageOptions,
): Promise<SanitizedUserImage> => {
  const structure = await validateUserImageFile(file);
  const createBitmap = options.createImageBitmap ?? defaultCreateBitmap;
  const bitmap = await createBitmap(file).catch(() => fail('IMAGE_DECODE_FAILED'));

  try {
    assertDimensions(bitmap);
    if (bitmap.width !== structure.width || bitmap.height !== structure.height) fail('IMAGE_DECODE_DIMENSION_MISMATCH');
    let canvas: CanvasLike;
    try {
      canvas = (options.createCanvas ?? defaultCreateCanvas)(bitmap.width, bitmap.height);
    } catch (error) {
      if (error instanceof ImageUploadError) throw error;
      return fail('IMAGE_REENCODE_FAILED');
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return fail('IMAGE_CANVAS_CONTEXT_UNAVAILABLE');
    try {
      context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
    } catch {
      return fail('IMAGE_REENCODE_FAILED');
    }

    const sanitizedBlob = await encodeCanvasPng(canvas).catch((error: unknown) => {
      if (error instanceof ImageUploadError) throw error;
      return fail('IMAGE_REENCODE_FAILED');
    });
    if (sanitizedBlob.type !== 'image/png' || sanitizedBlob.size <= 0) fail('IMAGE_REENCODE_FAILED');
    if (sanitizedBlob.size > USER_IMAGE_MAX_BYTES) fail('IMAGE_SANITIZED_TOO_LARGE');
    const sanitizedStructure = await (async () => {
      try {
        return validateImageStructure(new Uint8Array(await sanitizedBlob.arrayBuffer()), 'image/png');
      } catch {
        return fail('IMAGE_REENCODE_FAILED');
      }
    })();
    if (sanitizedStructure.width !== bitmap.width || sanitizedStructure.height !== bitmap.height) {
      fail('IMAGE_REENCODE_FAILED');
    }

    const cryptoApi = options.crypto ?? globalThis.crypto;
    if (!cryptoApi?.subtle || !cryptoApi?.getRandomValues) fail('IMAGE_CRYPTO_UNAVAILABLE');
    const identity = createSecureLocalAssetIdentity(options.projectId, cryptoApi);
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const storage: BlobStorageMetadata = {
      locator: identity.locator,
      projectId: options.projectId,
      blobKey: identity.blobKey,
      sha256: await sha256Blob(sanitizedBlob, cryptoApi).catch(() => fail('IMAGE_DIGEST_FAILED')),
      bytes: sanitizedBlob.size,
      mimeType: 'image/png',
      createdAt,
    };
    return {
      sanitizedBlob,
      assetId: identity.assetId,
      storage,
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close?.();
  }
};
