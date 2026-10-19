import { describe, expect, it } from 'vitest';
import { applyHomeHandoffToWorkspace } from './App';
import { createBlankWorkspace, PROJECT_ID } from './domain';
import { createHomeWorkspaceHandoff } from './portal-state';

const NOW = Date.parse('2026-08-15T02:00:00.000Z');

const reference = {
  assetId: 'asset-local-core011-app',
  width: 640,
  height: 480,
  storage: {
    locator: `indexeddb://elyra-assets/${PROJECT_ID}/blob-core011-app` as const,
    projectId: PROJECT_ID,
    blobKey: 'blob-core011-app',
    sha256: 'b'.repeat(64),
    bytes: 256,
    mimeType: 'image/png' as const,
    createdAt: '2026-08-15T01:59:59.000Z',
  },
};

describe('CORE-011 Workspace handoff application', () => {
  it('applies mode, provider and a clear prefill-only Agent message without creating work', () => {
    const before = createBlankWorkspace();
    const handoff = createHomeWorkspaceHandoff({
      handoffId: 'handoff-core011-app-prefill',
      source: 'home-composer',
      prompt: '不要自动发送',
      creationMode: 'image',
      imageProviderId: 'evolink-gpt-image-2',
    }, NOW)!;

    const next = applyHomeHandoffToWorkspace(before, handoff);
    expect(next).toMatchObject({ creationMode: 'image', imageProviderId: 'evolink-gpt-image-2' });
    expect(next.intents).toEqual(before.intents);
    expect(next.plans).toEqual(before.plans);
    expect(next.jobs).toEqual(before.jobs);
    expect(next.assets).toEqual(before.assets);
    expect(next.versions).toEqual(before.versions);
    expect(next.messages.at(-1)).toMatchObject({
      id: 'system-home-handoff-handoff-core011-app-prefill',
      role: 'agent',
    });
    expect(next.messages.at(-1)?.body).toMatch(/内容已带入工作台.*确认后点击发送.*没有自动生成或扣费/);
  });

  it('adds one verified local Asset, Canvas Object and Version idempotently', () => {
    const before = createBlankWorkspace();
    const handoff = createHomeWorkspaceHandoff({
      handoffId: 'handoff-core011-app-reference',
      source: 'inspiration-preset',
      prompt: '使用本机参考图生成海报',
      creationMode: 'image',
      imageProviderId: 'evolink-gpt-image-2',
      preset: { id: 'local-demo-editorial-poster', category: '品牌海报' },
      stagedReference: reference,
    }, NOW)!;

    const next = applyHomeHandoffToWorkspace(before, handoff);
    expect(next.assets).toHaveLength(1);
    expect(next.nodes).toHaveLength(1);
    expect(next.versions).toHaveLength(1);
    expect(next.assets[0]).toMatchObject({ id: reference.assetId, storage: reference.storage });
    expect(next.nodes[0]).toMatchObject({
      id: 'reference-home-handoff-core011-app-reference',
      kind: 'reference',
      assetId: reference.assetId,
      versionId: 'version-home-handoff-core011-app-reference',
    });
    expect(next.versions[0]).toMatchObject({
      id: 'version-home-handoff-core011-app-reference',
      canvasObjectId: next.nodes[0].id,
      status: 'ready',
    });
    expect(next.selectedIds).toEqual([next.nodes[0].id]);
    expect(next.jobs).toHaveLength(0);
    expect(next.intents).toHaveLength(0);
    expect(next.plans).toHaveLength(0);

    const repeated = applyHomeHandoffToWorkspace(next, handoff);
    expect(repeated.assets).toHaveLength(1);
    expect(repeated.nodes).toHaveLength(1);
    expect(repeated.versions).toHaveLength(1);
    expect(repeated.messages.filter((message) => message.id === `system-home-handoff-${handoff.handoffId}`)).toHaveLength(1);
  });

  it('describes Agent routing without falsely locking it to the image model', () => {
    const before = createBlankWorkspace();
    const handoff = createHomeWorkspaceHandoff({
      handoffId: 'handoff-core011-agent-routing',
      source: 'home-composer',
      prompt: '判断这次应该生成图片还是图生视频',
      creationMode: 'agent',
      imageProviderId: 'evolink-gpt-image-2',
    }, NOW)!;

    const next = applyHomeHandoffToWorkspace(before, handoff);
    expect(next.messages.at(-1)?.body).toMatch(/已配置的 Agent Planner.*图片.*视频/);
    expect(next.messages.at(-1)?.body).not.toMatch(/EvoLink|GPT Image 2|Sora 2 Preview/);
    expect(next.messages.at(-1)?.body).toMatch(/确认后点击发送.*没有自动生成或扣费/);
  });
});
