import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createProviderSettingsStore, defaultProviderConfig, validateProviderConfig } from './provider-config.mjs';
import { createProviderRegistry } from './provider-registry.mjs';
import { createOpenAIImageAdapter, readProviderJson } from './provider-adapters.mjs';
import { createCore008ImageGateway } from './core008-budget.mjs';
import { createPlannerBudgetLedger } from './planner-budget.mjs';
import { createApiHandler } from './elyra-server.mjs';
import { isPrivateResource } from './private-files.mjs';
const setup = t => { const dir = mkdtempSync(join(tmpdir(), 'elyra-api-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const json = value => new Response(JSON.stringify(value));
const profile = (role, changes = {}) => ({ ...defaultProviderConfig({}).roles[role], baseUrl: 'https://vendor.example/v1', filesBaseUrl: 'https://files.example/api/v1', label: 'Test service', model: 'test-model', keyEnv: '', apiKey: 'test-secret', ...changes });
const payload = { intent: { normalized_prompt: 'test image', goal: 'test goal', constraints: ['a', 'b'] }, plan: { operation: 'image_generate', summary: 'test summary', steps: ['a', 'b'], visual_direction: { subject: 'a', style: 'b', lighting: 'c', composition: 'd' } } };
const planInput = { prompt: 'a test image', imageProviderId: 'evolink-gpt-image-2' };
test('private runtime files cannot be served by path, case or encoding variants', () => {
  for (const path of ['/.elyra-runtime/provider-settings.json', '/.ELYRA-RUNTIME/provider-settings.json', '/%252eelyra-runtime/provider-settings.json', '/@fs/private/project/.elyra-runtime/key.json?raw', '/.env.local', '/.env%3fraw', '/%E0%A4%A']) assert.equal(isPrivateResource(path), true, path);
  for (const path of ['/api/agent/provider-settings', '/src/ProviderSettings.tsx', '/assets/elyra-speaker.png']) assert.equal(isPrivateResource(path), false, path);
});

test('settings redact secrets, persist privately, and activate only after restart', async t => {
  const path = join(setup(t), 'runtime/settings.json'); const store = createProviderSettingsStore({ path, env: {} });
  const input = store.readPublic(); input.roles.image.apiKey = 'private-secret';
  const saved = await store.save(input);
  assert.equal(saved.roles.image.hasKey, true); assert.equal(JSON.stringify(saved).includes('private-secret'), false);
  assert.equal(saved.restartRequired, true); assert.equal(store.active.roles.image.apiKey, undefined);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const restarted = createProviderSettingsStore({ path, env: {} });
  assert.equal(restarted.active.roles.image.apiKey, 'private-secret'); assert.equal(restarted.readPublic().restartRequired, false);
  await assert.rejects(store.save(input), { status: 409 });
});
test('destination changes drop stored and inherited secrets', async t => {
  const store = createProviderSettingsStore({ path: join(setup(t), 'settings.json'), env: { EVOLINK_API_KEY: 'env-secret' } });
  let input = store.readPublic(); input.roles.image.apiKey = 'stored-secret'; await store.save(input);
  input = store.readPublic(); input.roles.image.baseUrl = 'https://new.example/v1';
  const saved = await store.save(input);
  assert.equal(saved.roles.image.keyEnv, ''); assert.equal(saved.roles.image.hasKey, false); assert.equal(saved.active.image.hasKey, true);
  input = store.readPublic(); input.roles.video.clearKey = true; input.roles.video.keyEnv = '';
  assert.equal((await store.save(input)).roles.video.hasKey, false);
});
test('invalid writes preserve the old file and corrupt configs fail closed', async t => {
  const path = join(setup(t), 'settings.json'); const store = createProviderSettingsStore({ path, env: {} });
  await store.save(store.readPublic()); const before = readFileSync(path, 'utf8');
  const input = store.readPublic(); input.roles.image.baseUrl = 'https://key:secret@example.com/v1';
  await assert.rejects(store.save(input), { code: 'PROVIDER_CONFIG_INVALID' }); assert.equal(readFileSync(path, 'utf8'), before);
  writeFileSync(path, '{'); assert.throws(() => createProviderSettingsStore({ path, env: {} }), { status: 503 }); assert.equal(readFileSync(path, 'utf8'), '{');
});
test('unknown protocols, remote HTTP, URL credentials and invalid budgets are rejected', () => {
  for (const patch of [{ protocol: 'unknown' }, { baseUrl: 'http://remote.example/v1' }, { baseUrl: 'https://remote.example/v1?key=x' }, { reservationUsd: 0 }, { reservationUsd: 6 }]) {
    const config = defaultProviderConfig({}); Object.assign(config.roles.image, patch); assert.throws(() => validateProviderConfig(config), { code: 'PROVIDER_CONFIG_INVALID' });
  }
  const config = defaultProviderConfig({}); config.roles.image.baseUrl = 'http://127.0.0.1:9999/v1'; assert.equal(validateProviderConfig(config).roles.image.baseUrl, 'http://127.0.0.1:9999/v1');
});
test('independent Evo-compatible image and video credentials, endpoints and models', async () => {
  const calls = []; const registry = createProviderRegistry({ env: {}, fetchImpl: async (url, options) => { calls.push({ url, options }); return json({ id: 'task-unified-fixture', status: 'pending' }); } });
  await registry.create('image', profile('image', { apiKey: 'image-only', model: 'custom-image' })).client.createImageJob({ prompt: 'hello' });
  await registry.create('video', profile('video', { apiKey: 'video-only', model: 'custom-video', baseUrl: 'https://video.example/v1', auth: 'x-api-key' })).client.createVideoJob({ prompt: 'hello', referenceUrl: 'https://files.example/a.png', aspectRatio: '1280x720' });
  assert.equal(calls[0].url, 'https://vendor.example/v1/images/generations'); assert.equal(calls[0].options.headers.Authorization, 'Bearer image-only'); assert.equal(JSON.parse(calls[0].options.body).model, 'custom-image');
  assert.equal(calls[1].url, 'https://video.example/v1/videos/generations'); assert.equal(calls[1].options.headers['x-api-key'], 'video-only'); assert.equal(JSON.parse(calls[1].options.body).model, 'custom-video'); assert.ok(calls.every(call => call.options.redirect === 'error'));
});
for (const protocol of ['anthropic-messages', 'openai-chat']) test(`${protocol} planner returns strict plans with configured model and conservative cost`, async t => {
  const calls = []; const registry = createProviderRegistry({ env: {}, fetchImpl: async (url, options) => { calls.push({ url, options }); return json(protocol === 'openai-chat' ? { id: 'chat-test', choices: [{ message: { tool_calls: [{ function: { name: 'submit_elyra_plan', arguments: JSON.stringify(payload) } }] } }], usage: { prompt_tokens: 120, completion_tokens: 80 } } : { id: 'message-test', content: [{ type: 'tool_use', name: 'submit_elyra_plan', input: payload }], usage: { input_tokens: 120, output_tokens: 80 } }); } });
  const adapter = registry.create('planner', profile('planner', { protocol, auth: 'x-api-key', reservationUsd: 0.2 }));
  const result = await adapter.createClient({ budgetLedgerDirectory: setup(t), historicalSpentUsd: 0, maxAttempts: 1 }).createPlan(planInput);
  assert.equal(result.plan.providerId, 'evolink-gpt-image-2'); assert.equal(result.plan.plannerModel, 'test-model'); assert.equal(result.evidence.model, 'test-model'); assert.equal(result.evidence.pricingSource, 'operator-reservation'); assert.equal(result.evidence.estimatedRequestCostUsd, 0.2);
  assert.equal(calls[0].url, `https://vendor.example/v1/${protocol === 'openai-chat' ? 'chat/completions' : 'messages'}`); assert.equal(JSON.parse(calls[0].options.body).model, 'test-model'); assert.equal(calls[0].options.headers['x-api-key'], 'test-secret'); assert.equal(JSON.stringify(result).includes('test-secret'), false);
});
test('malformed chat tools fail schema validation', async t => {
  const registry = createProviderRegistry({ env: {}, fetchImpl: async () => json({ choices: [{ message: { tool_calls: [{ function: { name: 'submit_elyra_plan', arguments: 'broken' } }] } }] }) });
  const adapter = registry.create('planner', profile('planner', { protocol: 'openai-chat' }));
  await assert.rejects(adapter.createClient({ budgetLedgerDirectory: setup(t), historicalSpentUsd: 0, maxAttempts: 1 }).createPlan(planInput), { code: 'PLANNER_SCHEMA_INVALID' });
});
test('disabled, unconfigured and preview APIs fail before network or budget reservation', async t => {
  let requests = 0;
  for (const mode of ['disabled', 'missing', 'preview']) {
    const registry = createProviderRegistry({ env: {}, preview: mode === 'preview', fetchImpl: async () => { requests++; throw Error('must not run'); } });
    const adapter = registry.create('image', profile('image', { enabled: mode !== 'disabled', apiKey: mode === 'missing' ? undefined : 'test-secret' }));
    const gateway = createCore008ImageGateway({ client: adapter.client, budgetLedger: createPlannerBudgetLedger({ directory: setup(t) }), ensureConfigured: adapter.ensureConfigured });
    await assert.rejects(gateway.createImageJob({ clientJobId: 'job-no-network', prompt: 'test' })); assert.equal(gateway.getBudgetStatus().usedUsd, 0);
  }
  assert.equal(requests, 0);
});
test('OpenAI image bytes become a validated local asset, with one submission and configured budget', async t => {
  const calls = []; const png = readFileSync('public/assets/elyra-speaker.png');
  const adapter = createOpenAIImageAdapter({ settings: profile('image'), readKey: async () => 'image-key', fetchImpl: async (url, options) => { calls.push({ url, options }); return json({ data: [{ b64_json: png.toString('base64') }] }); } });
  const gateway = createCore008ImageGateway({ client: adapter.client, budgetLedger: createPlannerBudgetLedger({ directory: setup(t) }), ensureConfigured: async () => {}, resolveProviderResult: adapter.resolveResult, imageReservationUsd: 0.3 });
  const input = { clientJobId: 'job-image-plugin', prompt: 'test', size: '16:9' }; const created = await gateway.createImageJob(input);
  assert.equal((await gateway.createImageJob(input)).id, created.id); const completed = await gateway.getTask(created.id);
  assert.equal(completed.status, 'completed'); assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].options.body).size, '1536x1024'); assert.equal(JSON.stringify(completed).includes('b64_json'), false); assert.equal(gateway.getBudgetStatus().usedUsd, 0.3); assert.ok(completed.result.width > 0);
});
test('OpenAI edits send the reference directly once, without a file host upload', async () => {
  const calls = []; const adapter = createOpenAIImageAdapter({ settings: profile('image'), readKey: async () => 'test-key', fetchImpl: async (url, options) => { calls.push({ url, options }); return json({ data: [{ b64_json: 'YWJj' }] }); } });
  const reference = await adapter.client.uploadReferenceImage({ buffer: Buffer.from('fixture'), mimeType: 'image/png' }); assert.equal(calls.length, 0);
  await adapter.client.createUploadedReferenceEditJob({ prompt: 'edit', referenceUrl: reference.fileUrl });
  assert.equal(calls[0].url, 'https://vendor.example/v1/images/edits'); assert.equal(calls[0].options.body.get('model'), 'test-model'); assert.equal(await calls[0].options.body.get('image').text(), 'fixture');
  await assert.rejects(adapter.client.createUploadedReferenceEditJob({ prompt: 'again', referenceUrl: reference.fileUrl })); assert.equal(calls.length, 1);
});
test('oversized responses, invalid image bytes and upstream secret echoes fail safely', async () => {
  await assert.rejects(readProviderJson(new Response('upstream-secret', { status: 401 })), error => error.status === 401 && !error.message.includes('upstream-secret'));
  await assert.rejects(readProviderJson(json({ data: 'a'.repeat(1000) }), 20));
  const adapter = createOpenAIImageAdapter({ settings: profile('image'), readKey: async () => 'test-key', fetchImpl: async () => json({ data: [{ b64_json: 'not-an-image' }] }) });
  await assert.rejects(adapter.resolveResult(await adapter.client.createImageJob({ prompt: 'test' })));
});
test('custom protocol factories register by role without overwriting builtins', async () => {
  let seen; const factory = context => { seen = context; return { client: { createImageJob: async () => ({ id: 'task-unified-custom' }) }, resolveResult: async () => ({}) }; };
  const registry = createProviderRegistry({ plugins: { image: { 'custom-test': factory } }, env: {} }); const settings = profile('image', { protocol: 'custom-test' }); const config = defaultProviderConfig({}); config.roles.image = settings; validateProviderConfig(config, registry.protocols);
  assert.equal((await registry.create('image', settings).client.createImageJob()).id, 'task-unified-custom'); assert.equal(await seen.readKey(), 'test-secret'); assert.throws(() => createProviderRegistry({ plugins: { image: { evolink: factory } } }));
});
test('restored vendor jobs cannot be polled through another endpoint, model or account', async () => {
  const calls = [];
  const registry = createProviderRegistry({ env: {}, fetchImpl: async (url, options) => { calls.push(url); return json({ id: 'task-unified-original', status: options.method === 'POST' ? 'pending' : 'completed' }); } });
  const first = registry.create('image', profile('image'));
  const task = await first.client.createImageJob({ prompt: 'test' });
  assert.equal((await first.client.getTask(task.id)).id, task.id);
  for (const patch of [{ baseUrl: 'https://other.example/v1' }, { model: 'another-model' }, { apiKey: 'another-account' }]) {
    await assert.rejects(registry.create('image', profile('image', patch)).client.getTask(task.id), /API/);
  }
  assert.equal(calls.length, 2);
});
test('settings HTTP API rejects cross-origin writes and never returns saved keys', async t => {
  const providerSettings = createProviderSettingsStore({ path: join(setup(t), 'settings.json'), env: {} }); let handler;
  const server = createServer((request, response) => handler(request, response)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port; const origin = `http://127.0.0.1:${port}`; handler = createApiHandler({ host: '127.0.0.1', port, providerSettings });
  const input = providerSettings.readPublic(); input.roles.image.apiKey = 'http-private-key'; const headers = { 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/agent/provider-settings`, { method: 'POST', headers, body: JSON.stringify(input) })).status, 403);
  const response = await fetch(`${origin}/api/agent/provider-settings`, { method: 'POST', headers: { ...headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(input) }); assert.equal(response.status, 200); assert.equal((await response.text()).includes('http-private-key'), false);
  const read = await fetch(`${origin}/api/agent/provider-settings`); assert.equal(read.headers.get('cache-control'), 'no-store'); assert.equal((await read.text()).includes('http-private-key'), false);
});
