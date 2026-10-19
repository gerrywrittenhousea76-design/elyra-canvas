import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createEvoLinkPlannerClient } from './planner.mjs';

const targetBinding = { objectId: 'canvas-core009-source', assetId: 'asset-core009-source', versionId: 'version-core009-source' };

const responseFor = (operation) => new Response(JSON.stringify({
  id: `msg-${operation}`,
  stop_reason: 'tool_use',
  usage: { input_tokens: 20, output_tokens: 20 },
  content: [{
    type: 'tool_use', name: 'submit_elyra_plan', input: {
      intent: { normalized_prompt: '非敏感演示需求', goal: '完成演示视觉任务', constraints: ['仅处理非敏感演示内容', '保留主体'] },
      plan: {
        operation,
        summary: operation === 'clarify' ? '请确认要生成图片还是让选中图片生成视频。' : '执行一次受控生成。',
        steps: ['校验上下文', '创建单一生成 Job'],
        visual_direction: { subject: '演示主体', style: '克制', lighting: '柔和', composition: '稳定' },
      },
    },
  }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

const runPlan = async (input, operation) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'elyra-core009-planner-'));
  let request;
  try {
    const client = createEvoLinkPlannerClient({
      budgetLedgerDirectory: directory,
      historicalSpentUsd: 0,
      budgetCapUsd: 5,
      maxAttempts: 1,
      readKey: async () => 'not-a-real-key',
      fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return responseFor(operation); },
    });
    return { result: await client.createPlan(input), request };
  } finally { await rm(directory, { recursive: true, force: true }); }
};

const base = { prompt: '非敏感演示需求', imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview' };

test('Image mode fixes a no-selection request to one image generation operation', async () => {
  const { result, request } = await runPlan({ ...base, creationMode: 'image', selectedCanvasObjectCount: 0 }, 'image_generate');
  assert.equal(result.intent.operation, 'image_generate');
  assert.equal(result.intent.creationMode, 'image');
  assert.equal(result.plan.providerId, 'evolink-gpt-image-2');
  assert.equal(result.plan.creationMode, 'image');
  assert.equal(result.plan.outputKind, 'image');
  assert.match(request.messages[0].content, /"required_operation":"image_generate"/);
});

test('Video mode fixes one selected source to Sora image-to-video', async () => {
  const { result, request } = await runPlan({ ...base, creationMode: 'video', selectedCanvasObjectCount: 1, targetCanvasObjectId: targetBinding.objectId, referenceKind: 'user-upload', consentVersion: 'CORE-007-DATA-BOUNDARY-V1' }, 'video_image_to_video');
  assert.equal(result.intent.operation, 'video_image_to_video');
  assert.equal(result.intent.creationMode, 'video');
  assert.equal(result.plan.operation, 'video_image_to_video');
  assert.equal(result.plan.providerId, 'evolink-sora-2-preview');
  assert.equal(result.plan.creationMode, 'video');
  assert.equal(result.plan.outputKind, 'video');
  assert.match(request.messages[0].content, /"required_operation":"video_image_to_video"/);
  assert.equal(request.system.includes('text-to-video'), true);
});

test('Agent mode may clarify ambiguity without creating a generation operation', async () => {
  const { result } = await runPlan({ ...base, creationMode: 'agent', selectedCanvasObjectCount: 1, targetCanvasObjectId: targetBinding.objectId, referenceKind: 'fixed-demo' }, 'clarify');
  assert.equal(result.intent.operation, 'clarify');
  assert.equal(result.intent.creationMode, 'agent');
  assert.equal(result.plan.providerId, 'none');
  assert.equal(result.plan.creationMode, 'agent');
  assert.equal(result.plan.outputKind, 'none');
  assert.match(result.plan.clarificationQuestion, /请确认/);
});

test('Agent mode rejects video routing for a fixed demo without a restorable Blob', async () => {
  await assert.rejects(
    () => runPlan({ ...base, creationMode: 'agent', selectedCanvasObjectCount: 1, targetCanvasObjectId: targetBinding.objectId, referenceKind: 'fixed-demo' }, 'video_image_to_video'),
    (error) => error.code === 'PLANNER_SCHEMA_INVALID' && error.evidence.schemaFailureStage === 'plan_operation',
  );
});

test('Agent mode rejects text-to-video routing when no image is selected', async () => {
  await assert.rejects(
    () => runPlan({ ...base, creationMode: 'agent', selectedCanvasObjectCount: 0 }, 'video_image_to_video'),
    (error) => error.code === 'PLANNER_SCHEMA_INVALID' && error.evidence.schemaFailureStage === 'plan_operation',
  );
});

test('Video mode selection errors fail before Key access or Provider work', async () => {
  let keyReads = 0;
  const client = createEvoLinkPlannerClient({ readKey: async () => { keyReads += 1; return 'not-used'; } });
  await assert.rejects(() => client.createPlan({ ...base, creationMode: 'video', selectedCanvasObjectCount: 0 }), (error) => error.code === 'CORE009_VIDEO_SELECTION_REQUIRED');
  assert.equal(keyReads, 0);
});
