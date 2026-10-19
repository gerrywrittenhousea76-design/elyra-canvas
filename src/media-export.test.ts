import { describe, expect, it, vi } from 'vitest';
import { createBlankWorkspace, GENERATED_ASSET, type Workspace } from './domain';
import { readMediaExportBlob, resolveMediaExportTarget } from './media-export';

const fixture = (): Workspace => ({
  ...createBlankWorkspace(), selectedIds: ['result'],
  nodes: [{ id: 'result', name: '图片', kind: 'generated', status: 'ready', x: 0, y: 0, width: 100, height: 100, version: 1, prompt: '', createdAt: '2026-10-10T00:00:00Z', versionId: 'v1', assetId: 'a1' }],
  assets: [{ id: 'a1', kind: 'image', source: 'deterministic-mock', providerId: 'deterministic-mock', uri: GENERATED_ASSET, mimeType: 'image/png', prompt: '', createdAt: '2026-10-10T00:00:00Z', metadata: { deterministic: true, width: 100, height: 100 } }],
});
const stored = (): Workspace => {
  const workspace = fixture();
  Object.assign(workspace.assets[0], {
    source: 'remote-provider', providerId: 'evolink-gpt-image-2', uri: undefined,
    storage: { locator: 'indexeddb://elyra-assets/project-a/blob-a', projectId: 'project-a', blobKey: 'blob-a', sha256: 'a'.repeat(64), bytes: 5, mimeType: 'image/png', createdAt: '2026-10-10T00:00:00Z' },
  });
  return workspace;
};
const target = (workspace = fixture()) => {
  const value = resolveMediaExportTarget(workspace, 'project-a');
  if (!value) throw new Error('missing test target');
  return value;
};

describe('media original export', () => {
  it('exports the explicit fixed rehearsal fixture, not an invented remote result', async () => {
    const fetchLocal = vi.fn().mockResolvedValue(new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    const get = vi.fn();
    const blob = await readMediaExportBlob(target(), { get }, fetchLocal);
    expect(await blob.text()).toBe('image');
    expect(fetchLocal).toHaveBeenCalledWith(GENERATED_ASSET, { redirect: 'error', credentials: 'omit' });
    expect(get).not.toHaveBeenCalled();
  });
  it('supports the original reference-demo only when it has no asset binding', () => {
    const w = fixture();
    w.selectedIds = ['reference-demo'];
    Object.assign(w.nodes[0], { id: 'reference-demo', kind: 'reference', assetId: undefined });
    expect(target(w).fixedDemo).toBe(true);
    w.nodes[0].assetId = 'missing';
    expect(resolveMediaExportTarget(w, 'project-a')).toBeUndefined();
  });
  it('exports a verified stored Blob without using any remote URL', async () => {
    const w = stored();
    w.assets[0].uri = 'https://example.invalid/private-image';
    const blob = new Blob(['image'], { type: 'image/png' });
    const fetchLocal = vi.fn();
    const get = vi.fn().mockResolvedValue(blob);
    expect(await readMediaExportBlob(target(w), { get }, fetchLocal)).toBe(blob);
    expect(get).toHaveBeenCalledWith(w.assets[0].storage);
    expect(fetchLocal).not.toHaveBeenCalled();
  });
  it('never substitutes a fixture for a missing real Provider or user-upload Blob', async () => {
    for (const source of ['remote-provider', 'local-upload'] as const) {
      const w = stored(); w.assets[0].source = source;
      const fetchLocal = vi.fn();
      await expect(readMediaExportBlob(target(w), { get: vi.fn().mockResolvedValue(undefined) }, fetchLocal)).rejects.toThrow('原件无法恢复');
      expect(fetchLocal).not.toHaveBeenCalled();
      w.assets[0].storage = undefined; w.assets[0].uri = GENERATED_ASSET;
      expect(resolveMediaExportTarget(w, 'project-a')).toBeUndefined();
    }
  });
  it('propagates integrity failures without retry or alternate download', async () => {
    const fetchLocal = vi.fn();
    await expect(readMediaExportBlob(target(stored()), { get: vi.fn().mockRejectedValue(new Error('BLOB_HASH_MISMATCH')) }, fetchLocal)).rejects.toThrow('BLOB_HASH_MISMATCH');
    expect(fetchLocal).not.toHaveBeenCalled();
  });
  it('rejects missing selection, multiselection, incomplete media and task cards', () => {
    for (const ids of [[], ['result', 'second']]) {
      const w = fixture(); w.selectedIds = ids;
      expect(resolveMediaExportTarget(w, 'project-a')).toBeUndefined();
    }
    for (const status of ['generating', 'failed', 'user_cancelled'] as const) {
      const w = fixture(); w.nodes[0].status = status;
      expect(resolveMediaExportTarget(w, 'project-a')).toBeUndefined();
    }
    const w = fixture(); w.nodes[0].kind = 'workflow';
    expect(resolveMediaExportTarget(w, 'project-a')).toBeUndefined();
  });
  it('rejects cross-project storage and misleading MIME metadata', () => {
    const w = stored();
    expect(resolveMediaExportTarget(w, 'project-b')).toBeUndefined();
    w.assets[0].mimeType = 'video/mp4';
    expect(resolveMediaExportTarget(w, 'project-a')).toBeUndefined();
  });
  it('requires the exact allowlisted fixture and explicit mock provider', () => {
    const w = fixture(); w.assets[0].uri = 'https://example.invalid/image.png';
    expect(resolveMediaExportTarget(w, 'project-a')).toBeUndefined();
    w.assets[0].uri = GENERATED_ASSET; w.assets[0].providerId = 'evolink-gpt-image-2';
    expect(resolveMediaExportTarget(w, 'project-a')).toBeUndefined();
  });
  it('invalidates export identity on version or asset change, not geometry', () => {
    const w = stored(); const before = target(w).key;
    w.nodes[0].x += 10;
    expect(target(w).key).toBe(before);
    w.nodes[0].versionId = 'v2';
    expect(target(w).key).not.toBe(before);
    const versionKey = target(w).key;
    w.assets[0].storage!.sha256 = 'b'.repeat(64);
    expect(target(w).key).not.toBe(versionKey);
  });
  it('reports local fixture fetch failure so the user can explicitly retry', async () => {
    const get = vi.fn();
    const fetchLocal = vi.fn().mockResolvedValueOnce(new Response('missing', { status: 404 })).mockResolvedValueOnce(new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    await expect(readMediaExportBlob(target(), { get }, fetchLocal)).rejects.toThrow('演示素材不可用');
    expect(fetchLocal).toHaveBeenCalledTimes(1);
    expect((await readMediaExportBlob(target(), { get }, fetchLocal)).size).toBe(5);
  });
  it('rejects a successful HTML or empty fixture response', async () => {
    for (const response of [new Response('<html>', { headers: { 'Content-Type': 'text/html' } }), new Response('', { headers: { 'Content-Type': 'image/png' } })]) {
      await expect(readMediaExportBlob(target(), { get: vi.fn() }, vi.fn().mockResolvedValue(response))).rejects.toThrow('原件无法恢复');
    }
  });
  it('uses the original media MIME for video downloads', () => {
    const w = stored(); Object.assign(w.assets[0], { kind: 'video', mimeType: 'video/mp4' });
    w.assets[0].storage!.mimeType = 'video/mp4';
    expect(target(w).filename).toBe('elyra-result.mp4');
  });
});
