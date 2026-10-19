import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RESULT_BYTES = 20 * 1024 * 1024;
const MAX_EDGE = 8192;
const MAX_PIXELS = 25_000_000;
const SIPS_PATH = '/usr/bin/sips';
const ALLOWED_MIME = 'image/png';
const ALLOWED_EXTENSION = '.png';
const KNOWN_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const SAFE_RENDERING_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM']);
const VALID_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

export const REFERENCE_IMAGE_LIMITS = Object.freeze({
  mimeType: ALLOWED_MIME,
  extension: ALLOWED_EXTENSION,
  maxBytes: MAX_BYTES,
  maxEdge: MAX_EDGE,
  maxPixels: MAX_PIXELS,
});

export const CORE009_VIDEO_REFERENCE_DIMENSIONS = Object.freeze({
  landscape: Object.freeze({ width: 1280, height: 720, aspectRatio: '1280x720' }),
  portrait: Object.freeze({ width: 720, height: 1280, aspectRatio: '720x1280' }),
});

/**
 * Produces a centered cover crop before the exact Sora resize. Keeping the
 * crop ratio aligned with the target avoids stretching square/product images
 * merely to satisfy the Provider's strict pixel contract.
 */
export const planCore009VideoReferenceTransform = ({ width, height }) => {
  assertDimensions(width, height);
  const target = width >= height ? CORE009_VIDEO_REFERENCE_DIMENSIONS.landscape : CORE009_VIDEO_REFERENCE_DIMENSIONS.portrait;
  const targetRatio = target.width / target.height;
  const sourceRatio = width / height;
  let cropWidth = width;
  let cropHeight = height;
  if (sourceRatio > targetRatio) cropWidth = Math.max(1, Math.min(width, Math.round(height * targetRatio)));
  else if (sourceRatio < targetRatio) cropHeight = Math.max(1, Math.min(height, Math.round(width / targetRatio)));
  return Object.freeze({
    target,
    cropWidth,
    cropHeight,
    offsetX: Math.floor((width - cropWidth) / 2),
    offsetY: Math.floor((height - cropHeight) / 2),
  });
};

const PROVIDER_RESULT_MIME = new Map([
  ['image/png', { extension: '.png', magic: (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE) }],
  ['image/jpeg', { extension: '.jpg', magic: (bytes) => bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 }],
  ['image/webp', { extension: '.webp', magic: (bytes) => bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length }],
]);

/**
 * Detects only the three formats that the server can decode and re-encode.
 * This is intentionally based on complete format boundaries, not a filename
 * or a caller supplied Content-Type.
 */
export const detectProviderResultMime = (buffer) => {
  const source = toBuffer(buffer);
  const matches = [...PROVIDER_RESULT_MIME.entries()]
    .filter(([, format]) => format.magic(source))
    .map(([mimeType]) => mimeType);
  return matches.length === 1 ? matches[0] : undefined;
};

/**
 * Validates the browser-side, pixel-decoded PNG before any subprocess executes.
 * The original filename is intentionally neither returned nor persisted.
 */
export const validateBrowserReferencePng = ({ buffer, mimeType, extension }) => {
  const bytes = toBuffer(buffer);
  if (mimeType !== ALLOWED_MIME) {
    throw new ReferenceImageError('REFERENCE_MIME_INVALID', '参考图必须以 image/png 传输。');
  }
  if (normalizeExtension(extension) !== ALLOWED_EXTENSION) {
    throw new ReferenceImageError('REFERENCE_EXTENSION_INVALID', '参考图扩展名必须为 .png。');
  }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw new ReferenceImageError('REFERENCE_SIZE_INVALID', '参考图必须大于 0 且不超过 10 MiB。');
  }
  const parsed = parsePng(bytes);
  assertDimensions(parsed.width, parsed.height);
  return Object.freeze({
    width: parsed.width,
    height: parsed.height,
    bytes: bytes.length,
    chunkTypes: Object.freeze(parsed.chunks.map(({ type }) => type)),
    sha256: sha256(bytes),
  });
};

/**
 * Truly decodes the supplied pixels through Apple's fixed system image decoder,
 * re-encodes them as PNG, then strips every non-rendering ancillary chunk.
 */
export const sanitizeBrowserReferencePng = async ({ buffer, mimeType, extension, temporaryParent = tmpdir() }) => {
  const source = toBuffer(buffer);
  const inputInspection = validateBrowserReferencePng({ buffer: source, mimeType, extension });
  const parent = await validateTemporaryParent(temporaryParent);
  const workDirectory = await mkdtemp(join(parent, 'elyra-reference-image-'));
  let workIdentity;
  try {
    await mkdir(workDirectory, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    await ensurePrivateDirectory(workDirectory, parent);
    workIdentity = await stat(workDirectory);

    const stem = randomUUID().replaceAll('-', '');
    const inputPath = join(workDirectory, `${stem}-input.png`);
    const decodedPath = join(workDirectory, `${stem}-decoded.png`);
    await writeFile(inputPath, source, { mode: 0o600, flag: 'wx' });

    await executeSips(inputPath, decodedPath, workDirectory);
    await assertSameDirectoryIdentity(workDirectory, workIdentity);
    const decoded = await readFile(decodedPath);
    const decodedInspection = validateBrowserReferencePng({
      buffer: decoded,
      mimeType: ALLOWED_MIME,
      extension: ALLOWED_EXTENSION,
    });
    if (decodedInspection.width !== inputInspection.width || decodedInspection.height !== inputInspection.height) {
      throw new ReferenceImageError('REFERENCE_DIMENSION_CHANGED', '图片解码后的尺寸与输入不一致。');
    }

    const sanitized = stripNonRenderingPngChunks(decoded);
    const outputInspection = validateBrowserReferencePng({
      buffer: sanitized,
      mimeType: ALLOWED_MIME,
      extension: ALLOWED_EXTENSION,
    });
    assertMetadataAbsent(outputInspection.chunkTypes);

    return Object.freeze({
      buffer: sanitized,
      mimeType: ALLOWED_MIME,
      extension: ALLOWED_EXTENSION,
      serverFilename: `${randomUUID().replaceAll('-', '')}.png`,
      width: outputInspection.width,
      height: outputInspection.height,
      bytes: outputInspection.bytes,
      sha256: outputInspection.sha256,
      removedMetadata: true,
    });
  } catch (error) {
    if (error instanceof ReferenceImageError) throw error;
    throw new ReferenceImageError('REFERENCE_DECODE_FAILED', '参考图无法安全解码或重编码。', { cause: error });
  } finally {
    if (workIdentity) await assertSameDirectoryIdentity(workDirectory, workIdentity).catch(() => undefined);
    await rm(workDirectory, { recursive: true, force: true });
  }
};

/**
 * Sora 2 Preview requires the uploaded reference pixels to exactly match the
 * selected aspect_ratio. Normalize the already-sanitized PNG to one of the two
 * documented pixel sizes before upload; never ask the Provider to pad/crop or
 * silently choose a different ratio.
 */
export const normalizeCore009VideoReferencePng = async ({ buffer, width, height, temporaryParent = tmpdir() }) => {
  const source = toBuffer(buffer);
  const inspected = validateBrowserReferencePng({ buffer: source, mimeType: ALLOWED_MIME, extension: ALLOWED_EXTENSION });
  if (inspected.width !== width || inspected.height !== height) {
    throw new ReferenceImageError('CORE009_VIDEO_REFERENCE_DIMENSION_BINDING_INVALID', '净化参考图尺寸与声明尺寸不一致。');
  }
  const transform = planCore009VideoReferenceTransform({ width, height });
  const { target } = transform;
  const parent = await validateTemporaryParent(temporaryParent);
  const workDirectory = await mkdtemp(join(parent, 'elyra-core009-video-reference-'));
  let workIdentity;
  try {
    await ensurePrivateDirectory(workDirectory, parent);
    workIdentity = await stat(workDirectory);
    const stem = randomUUID().replaceAll('-', '');
    const inputPath = join(workDirectory, `${stem}-input.png`);
    const croppedPath = join(workDirectory, `${stem}-cropped.png`);
    const outputPath = join(workDirectory, `${stem}-normalized.png`);
    await writeFile(inputPath, source, { mode: 0o600, flag: 'wx' });
    await executeSipsCrop(inputPath, croppedPath, workDirectory, transform);
    await assertSameDirectoryIdentity(workDirectory, workIdentity);
    await executeSipsResize(croppedPath, outputPath, workDirectory, target);
    await assertSameDirectoryIdentity(workDirectory, workIdentity);
    const normalized = stripNonRenderingPngChunks(await readFile(outputPath));
    const output = validateBrowserReferencePng({ buffer: normalized, mimeType: ALLOWED_MIME, extension: ALLOWED_EXTENSION });
    assertMetadataAbsent(output.chunkTypes);
    if (output.width !== target.width || output.height !== target.height) {
      throw new ReferenceImageError('CORE009_VIDEO_REFERENCE_RESIZE_INVALID', '视频参考图像素未精确匹配 aspect_ratio。');
    }
    return Object.freeze({
      buffer: normalized,
      mimeType: ALLOWED_MIME,
      extension: ALLOWED_EXTENSION,
      serverFilename: `${randomUUID().replaceAll('-', '')}.png`,
      width: output.width,
      height: output.height,
      bytes: output.bytes,
      sha256: output.sha256,
      aspectRatio: target.aspectRatio,
      removedMetadata: true,
    });
  } catch (error) {
    if (error instanceof ReferenceImageError) throw error;
    throw new ReferenceImageError('CORE009_VIDEO_REFERENCE_NORMALIZE_FAILED', '视频参考图无法安全转换到受控像素尺寸。', { cause: error });
  } finally {
    if (workIdentity) await assertSameDirectoryIdentity(workDirectory, workIdentity).catch(() => undefined);
    await rm(workDirectory, { recursive: true, force: true });
  }
};

/**
 * Downloads are never trusted as display-ready bytes. This helper validates a
 * bounded JPEG/PNG/WebP response, decodes it through sips and returns the same
 * metadata-free PNG boundary used for uploaded references.
 */
export const sanitizeProviderResultImage = async ({ buffer, mimeType, temporaryParent = tmpdir() }) => {
  const source = toBuffer(buffer);
  const declaredType = typeof mimeType === 'string' ? mimeType.split(';', 1)[0].trim().toLowerCase() : '';
  const detectedType = detectProviderResultMime(source);
  const genericType = !declaredType || declaredType === 'application/octet-stream';
  const type = genericType ? detectedType : declaredType;
  const format = type ? PROVIDER_RESULT_MIME.get(type) : undefined;
  if (!format || !detectedType || (!genericType && declaredType !== detectedType)
    || source.length === 0 || source.length > MAX_RESULT_BYTES) {
    throw new ReferenceImageError('RESULT_IMAGE_INVALID', 'Provider 结果不是受支持且结构完整的图片。');
  }
  if (type === 'image/png') parsePng(source);

  const parent = await validateTemporaryParent(temporaryParent);
  const workDirectory = await mkdtemp(join(parent, 'elyra-provider-result-'));
  let workIdentity;
  try {
    await ensurePrivateDirectory(workDirectory, parent);
    workIdentity = await stat(workDirectory);
    const stem = randomUUID().replaceAll('-', '');
    const inputPath = join(workDirectory, `${stem}-input${format.extension}`);
    const decodedPath = join(workDirectory, `${stem}-decoded.png`);
    await writeFile(inputPath, source, { mode: 0o600, flag: 'wx' });
    await executeSips(inputPath, decodedPath, workDirectory);
    await assertSameDirectoryIdentity(workDirectory, workIdentity);
    const decoded = await readFile(decodedPath);
    const sanitized = stripNonRenderingPngChunks(decoded);
    const inspection = validateBrowserReferencePng({ buffer: sanitized, mimeType: ALLOWED_MIME, extension: ALLOWED_EXTENSION });
    assertMetadataAbsent(inspection.chunkTypes);
    return Object.freeze({
      buffer: sanitized,
      mimeType: ALLOWED_MIME,
      extension: ALLOWED_EXTENSION,
      width: inspection.width,
      height: inspection.height,
      bytes: inspection.bytes,
      sha256: inspection.sha256,
      removedMetadata: true,
    });
  } catch (error) {
    if (error instanceof ReferenceImageError) throw error;
    throw new ReferenceImageError('RESULT_IMAGE_DECODE_FAILED', 'Provider 结果无法安全解码或重编码。', { cause: error });
  } finally {
    if (workIdentity) await assertSameDirectoryIdentity(workDirectory, workIdentity).catch(() => undefined);
    await rm(workDirectory, { recursive: true, force: true });
  }
};

/** Pure PNG reconstruction used by the sanitizer and unit tests. */
export const stripNonRenderingPngChunks = (buffer) => {
  const bytes = toBuffer(buffer);
  const parsed = parsePng(bytes);
  const retained = parsed.chunks.filter(({ type }) => SAFE_RENDERING_CHUNKS.has(type));
  const output = Buffer.concat([PNG_SIGNATURE, ...retained.map(({ raw }) => raw)]);
  parsePng(output);
  return output;
};

const parsePng = (bytes) => {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new ReferenceImageError('REFERENCE_MAGIC_INVALID', '参考图不是有效的 PNG。');
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  let idatEnded = false;
  let sawPlte = false;
  let width = 0;
  let height = 0;
  let colorType = -1;

  while (offset < bytes.length) {
    if (sawIend) throw new ReferenceImageError('REFERENCE_TRAILING_DATA', 'PNG 的 IEND 后存在尾随数据。');
    if (bytes.length - offset < 12) throw new ReferenceImageError('REFERENCE_PNG_TRUNCATED', 'PNG chunk 已截断。');

    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      throw new ReferenceImageError('REFERENCE_PNG_TRUNCATED', 'PNG chunk 长度超出文件边界。');
    }
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ReferenceImageError('REFERENCE_CHUNK_INVALID', 'PNG chunk 类型无效。');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (expectedCrc !== actualCrc) throw new ReferenceImageError('REFERENCE_CRC_INVALID', `PNG ${type} chunk CRC 无效。`);

    const critical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
    if (critical && !KNOWN_CRITICAL_CHUNKS.has(type)) {
      throw new ReferenceImageError('REFERENCE_CRITICAL_CHUNK_UNKNOWN', `PNG 包含未知关键 chunk：${type}。`);
    }
    if (!sawIhdr && type !== 'IHDR') throw new ReferenceImageError('REFERENCE_IHDR_ORDER', 'IHDR 必须是第一个 PNG chunk。');
    if (type === 'IHDR') {
      if (sawIhdr || chunks.length !== 0 || length !== 13) throw new ReferenceImageError('REFERENCE_IHDR_INVALID', 'PNG 必须且只能包含一个 13-byte IHDR。');
      sawIhdr = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (!VALID_DEPTHS.get(colorType)?.has(bitDepth) || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(data[12])) {
        throw new ReferenceImageError('REFERENCE_IHDR_INVALID', 'PNG IHDR 的颜色或编码参数无效。');
      }
      assertDimensions(width, height);
    } else if (type === 'PLTE') {
      if (sawPlte || sawIdat || length === 0 || length > 768 || length % 3 !== 0) throw new ReferenceImageError('REFERENCE_PLTE_INVALID', 'PNG PLTE 无效或顺序错误。');
      sawPlte = true;
    } else if (type === 'IDAT') {
      if (idatEnded || length === 0) throw new ReferenceImageError('REFERENCE_IDAT_INVALID', 'PNG IDAT 必须连续且非空。');
      sawIdat = true;
    } else if (type === 'IEND') {
      if (!sawIdat || length !== 0) throw new ReferenceImageError('REFERENCE_IEND_INVALID', 'PNG IEND 无效。');
      sawIend = true;
    } else if (sawIdat) {
      idatEnded = true;
    }

    chunks.push({ type, raw: Buffer.from(bytes.subarray(offset, end)) });
    offset = end;
  }

  if (!sawIhdr || !sawIdat || !sawIend) throw new ReferenceImageError('REFERENCE_PNG_INCOMPLETE', 'PNG 缺少 IHDR、IDAT 或 IEND。');
  if (colorType === 3 && !sawPlte) throw new ReferenceImageError('REFERENCE_PLTE_MISSING', '索引色 PNG 缺少 PLTE。');
  if (offset !== bytes.length) throw new ReferenceImageError('REFERENCE_TRAILING_DATA', 'PNG 存在尾随数据。');
  return { chunks, width, height };
};

const executeSips = async (inputPath, outputPath, workDirectory) => {
  const resolvedSips = await realpath(SIPS_PATH).catch(() => null);
  if (resolvedSips !== SIPS_PATH) throw new ReferenceImageError('REFERENCE_DECODER_UNAVAILABLE', '系统图片解码器不可用。');
  try {
    await execFileAsync(SIPS_PATH, ['--setProperty', 'format', 'png', inputPath, '--out', outputPath], {
      cwd: workDirectory,
      env: Object.freeze({ HOME: workDirectory, TMPDIR: workDirectory, PATH: '/usr/bin:/bin', LANG: 'C' }),
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new ReferenceImageError('REFERENCE_DECODE_FAILED', '参考图无法安全解码或重编码。', { cause: error });
  }
};

const executeSipsResize = async (inputPath, outputPath, workDirectory, target) => {
  const resolvedSips = await realpath(SIPS_PATH).catch(() => null);
  if (resolvedSips !== SIPS_PATH) throw new ReferenceImageError('REFERENCE_DECODER_UNAVAILABLE', '系统图片解码器不可用。');
  try {
    await execFileAsync(SIPS_PATH, [
      '--resampleHeightWidth', String(target.height), String(target.width),
      '--setProperty', 'format', 'png',
      inputPath, '--out', outputPath,
    ], {
      cwd: workDirectory,
      env: Object.freeze({ HOME: workDirectory, TMPDIR: workDirectory, PATH: '/usr/bin:/bin', LANG: 'C' }),
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new ReferenceImageError('CORE009_VIDEO_REFERENCE_NORMALIZE_FAILED', '视频参考图无法安全转换到受控像素尺寸。', { cause: error });
  }
};

const executeSipsCrop = async (inputPath, outputPath, workDirectory, transform) => {
  const resolvedSips = await realpath(SIPS_PATH).catch(() => null);
  if (resolvedSips !== SIPS_PATH) throw new ReferenceImageError('REFERENCE_DECODER_UNAVAILABLE', '系统图片解码器不可用。');
  try {
    await execFileAsync(SIPS_PATH, [
      '--cropToHeightWidth', String(transform.cropHeight), String(transform.cropWidth),
      '--cropOffset', String(transform.offsetY), String(transform.offsetX),
      '--setProperty', 'format', 'png',
      inputPath, '--out', outputPath,
    ], {
      cwd: workDirectory,
      env: Object.freeze({ HOME: workDirectory, TMPDIR: workDirectory, PATH: '/usr/bin:/bin', LANG: 'C' }),
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new ReferenceImageError('CORE009_VIDEO_REFERENCE_NORMALIZE_FAILED', '视频参考图无法安全裁剪到受控比例。', { cause: error });
  }
};

const validateTemporaryParent = async (candidate) => {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) throw new ReferenceImageError('REFERENCE_TEMP_INVALID', '临时目录父路径必须是绝对路径。');
  const path = resolve(candidate);
  const linkStatus = await lstat(path).catch(() => null);
  if (!linkStatus?.isDirectory() || linkStatus.isSymbolicLink()) throw new ReferenceImageError('REFERENCE_TEMP_INVALID', '临时目录父路径必须是非符号链接目录。');
  return realpath(path);
};

const ensurePrivateDirectory = async (directory, parent) => {
  const canonical = await realpath(directory);
  if (resolve(canonical).slice(0, resolve(parent).length + 1) !== `${resolve(parent)}${sep}` || resolve(canonical, '..') !== resolve(parent)) {
    throw new ReferenceImageError('REFERENCE_TEMP_ESCAPE', '临时目录不在受控父目录内。');
  }
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new ReferenceImageError('REFERENCE_TEMP_PERMISSIONS', '临时目录必须由当前用户拥有且权限为 0700。');
  }
};

const assertSameDirectoryIdentity = async (directory, expected) => {
  const current = await stat(directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new ReferenceImageError('REFERENCE_TEMP_REPLACED', '临时目录在处理期间被替换。');
};

const assertDimensions = (width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new ReferenceImageError('REFERENCE_DIMENSIONS_INVALID', '参考图尺寸必须不超过 8192 像素单边和 2500 万像素。');
  }
};

const assertMetadataAbsent = (chunkTypes) => {
  const unexpected = chunkTypes.filter((type) => !SAFE_RENDERING_CHUNKS.has(type));
  if (unexpected.length) throw new ReferenceImageError('REFERENCE_METADATA_REMAINS', '清理后的 PNG 仍包含非必要 metadata。');
};

const normalizeExtension = (extension) => {
  if (typeof extension !== 'string') return '';
  const value = extension.includes('/') || extension.includes('\\') ? extname(basename(extension)) : extension;
  return value.toLowerCase().startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`;
};

const toBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new ReferenceImageError('REFERENCE_BYTES_INVALID', '参考图必须以二进制传入。');
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

export class ReferenceImageError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ReferenceImageError';
    this.code = code;
  }
}
