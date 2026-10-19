import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientInputError, EvoLinkHttpError, createEvoLinkClient } from './evolink.mjs';

test('creates GPT Image 2 text work with a server-supplied environment token', async () => {
  const calls = [];
  const client = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: 'task-unified-image-1', status: 'pending', model: 'gpt-image-2' }), { status: 200 });
    },
  });
  await client.createImageJob({ prompt: '产品主视觉' });
  assert.equal(calls[0].url, 'https://api.evolink.ai/v1/images/generations');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer not-a-real-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'gpt-image-2', prompt: '产品主视觉', size: '1:1', quality: 'medium', n: 1 });
});

test('sends only the fixed HTTPS reference URL for a GPT Image 2 edit', async () => {
  const calls = [];
  const client = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: 'task-unified-edit-1', status: 'pending', model: 'gpt-image-2' }), { status: 200 });
    },
  });
  await client.createImageEditJob({ prompt: '改为暖色棚拍', referenceUrl: 'https://demo.example/elyra-speaker.png' });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'gpt-image-2', prompt: '改为暖色棚拍', size: '1:1', quality: 'medium', n: 1,
    image_urls: ['https://demo.example/elyra-speaker.png'],
  });
});

test('creates only a four-second Sora 2 Preview image-to-video task', async () => {
  const calls = [];
  const client = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: 'task-unified-video-1', status: 'pending' }), { status: 202 });
    },
  });
  await client.createVideoJob({ prompt: '让光影缓慢流动', referenceUrl: 'https://files.evolink.ai/reference.png', aspectRatio: '1280x720' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.evolink.ai/v1/videos/generations');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'sora-2-preview', prompt: '让光影缓慢流动', image_urls: ['https://files.evolink.ai/reference.png'], aspect_ratio: '1280x720', duration: 4,
  });
  assert.equal(Object.hasOwn(JSON.parse(calls[0].options.body), 'image_url'), false);
  assert.equal(JSON.stringify(calls[0].options.body).includes('fallback'), false);
});

test('rejects a Sora aspect ratio outside the exact normalized pixel allowlist before Key access', async () => {
  let keyWasRead = false;
  const client = createEvoLinkClient({ readKey: async () => { keyWasRead = true; return 'not-used'; } });
  await assert.rejects(
    () => client.createVideoJob({ prompt: '让画面动起来', referenceUrl: 'https://files.evolink.ai/reference.png', aspectRatio: '16:9' }),
    ClientInputError,
  );
  assert.equal(keyWasRead, false);
});

test('rejects non-public or non-image edit references before it reads a token', async () => {
  let keyWasRead = false;
  const client = createEvoLinkClient({ readKey: async () => { keyWasRead = true; return 'not-used'; } });
  assert.throws(() => client.createImageEditJob({ prompt: 'x', referenceUrl: 'http://127.0.0.1:4176/elyra-speaker.png' }), ClientInputError);
  assert.equal(keyWasRead, false);
});

test('rejects accidental multi-image billing before it reads a token', async () => {
  let keyWasRead = false;
  const client = createEvoLinkClient({ readKey: async () => { keyWasRead = true; return 'not-used'; } });
  await assert.rejects(() => client.createImageJob({ prompt: 'x', n: 2 }), ClientInputError);
  assert.equal(keyWasRead, false);
});

test('rejects malformed task IDs before it reads a token', async () => {
  let keyWasRead = false;
  const client = createEvoLinkClient({ readKey: async () => { keyWasRead = true; return 'not-used'; } });
  await assert.rejects(() => client.getTask('../not-a-task'), ClientInputError);
  assert.equal(keyWasRead, false);
});

test('never propagates non-2xx Provider error codes, prompts or temporary URLs', async () => {
  const upstream = {
    error: {
      code: 'MALICIOUS_<SCRIPT>_CODE',
      message: '原始需求和临时地址 https://provider.example/private.png?token=secret must never cross',
    },
    prompt: 'private original prompt',
  };
  const createClient = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    fetchImpl: async () => new Response(JSON.stringify(upstream), { status: 429, headers: { 'Content-Type': 'application/json' } }),
  });
  await assert.rejects(
    () => createClient.createImageJob({ prompt: 'private original prompt' }),
    (error) => error instanceof EvoLinkHttpError
      && error.status === 429
      && error.code === 'EVOLINK_CREATE_RATE_LIMITED'
      && error.message === 'EvoLink 图片任务创建请求过于频繁。'
      && !JSON.stringify(error).includes('provider.example')
      && !JSON.stringify(error).includes('private original prompt'),
  );

  const statusClient = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    fetchImpl: async () => new Response(JSON.stringify(upstream), { status: 503, headers: { 'Content-Type': 'application/json' } }),
  });
  await assert.rejects(
    () => statusClient.getTask('task-unified-safe-id'),
    (error) => error instanceof EvoLinkHttpError
      && error.status === 503
      && error.code === 'EVOLINK_STATUS_UNAVAILABLE'
      && error.message === 'EvoLink 图片任务查询服务暂时不可用。'
      && !String(error.message).includes('https://')
      && !String(error.code).includes('MALICIOUS'),
  );
});

test('uploads one anonymous sanitized PNG as multipart and uses its URL only in image_urls', async () => {
  const calls = [];
  const client = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (String(url).includes('/files/upload/stream')) return new Response(JSON.stringify({ data: { file_url: 'https://files.example.test/anonymous.png' } }));
      return new Response(JSON.stringify({ id: 'task-unified-upload-edit-1', status: 'pending' }));
    },
  });
  const uploaded = await client.uploadReferenceImage({ buffer: Buffer.from([1, 2, 3]), mimeType: 'image/png', filename: `${'a'.repeat(32)}.png` });
  await client.createUploadedReferenceEditJob({ prompt: '暖灰棚拍', referenceUrl: uploaded.fileUrl });
  assert.equal(calls[0].url, 'https://files-api.evolink.ai/api/v1/files/upload/stream');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer not-a-real-key');
  assert.equal(calls[0].options.headers['Content-Type'], undefined);
  assert.ok(calls[0].options.body instanceof FormData);
  assert.equal(calls[0].options.body.getAll('file').length, 1);
  assert.equal(calls[0].options.body.get('file').name, `${'a'.repeat(32)}.png`);
  assert.deepEqual(JSON.parse(calls[1].options.body).image_urls, ['https://files.example.test/anonymous.png']);
});

test('retries explicit upload 429/5xx once but never retries auth or ambiguous network failure', async () => {
  let calls = 0;
  const retrying = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ file_url: 'https://files.example.test/reference.png' }));
    },
  });
  await retrying.uploadReferenceImage({ buffer: Buffer.from([1]), mimeType: 'image/png', filename: `${'b'.repeat(32)}.png` });
  assert.equal(calls, 2);

  calls = 0;
  const rejected = createEvoLinkClient({ readKey: async () => 'not-a-real-key', fetchImpl: async () => { calls += 1; return new Response('{}', { status: 401 }); } });
  await assert.rejects(() => rejected.uploadReferenceImage({ buffer: Buffer.from([1]), mimeType: 'image/png', filename: `${'c'.repeat(32)}.png` }), (error) => error instanceof EvoLinkHttpError && error.status === 401);
  assert.equal(calls, 1);

  calls = 0;
  const serverFailure = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ file_url: 'https://files.example.test/reference.png' }));
    },
  });
  await serverFailure.uploadReferenceImage({ buffer: Buffer.from([1]), mimeType: 'image/png', filename: `${'d'.repeat(32)}.png` });
  assert.equal(calls, 2);

  calls = 0;
  const ambiguousNetwork = createEvoLinkClient({
    readKey: async () => 'not-a-real-key',
    sleepImpl: async () => { throw new Error('network failure must not sleep or retry'); },
    fetchImpl: async () => { calls += 1; throw new TypeError('socket closed after request write'); },
  });
  await assert.rejects(
    () => ambiguousNetwork.uploadReferenceImage({ buffer: Buffer.from([1]), mimeType: 'image/png', filename: `${'e'.repeat(32)}.png` }),
    (error) => error instanceof EvoLinkHttpError && error.code === 'EVOLINK_UPLOAD_NETWORK_ERROR',
  );
  assert.equal(calls, 1);
});
