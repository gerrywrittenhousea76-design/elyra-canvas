import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlobStore,
  createBlobLocator,
  hydrateObjectUrl,
  parseBlobLocator,
  sha256Blob,
  type StoreBackend,
  type StoredBlobRecord,
} from './blob-store';

class MemoryBackend implements StoreBackend {
  readonly records = new Map<string, StoredBlobRecord>();
  putManyCalls = 0;
  failPutMany = false;

  private key(projectId: string, blobKey: string) {
    return `${projectId}\u0000${blobKey}`;
  }

  async put(record: StoredBlobRecord) {
    this.records.set(this.key(record.projectId, record.blobKey), record);
  }

  async putMany(records: readonly StoredBlobRecord[]) {
    this.putManyCalls += 1;
    const keys = records.map((record) => this.key(record.projectId, record.blobKey));
    if (this.failPutMany) throw new Error('TEST_ATOMIC_BATCH_FAILURE');
    if (new Set(keys).size !== keys.length || keys.some((key) => this.records.has(key))) {
      throw new Error('TEST_BATCH_KEY_CONFLICT');
    }
    const staged = new Map(this.records);
    records.forEach((record, index) => staged.set(keys[index], record));
    this.records.clear();
    for (const [key, record] of staged) this.records.set(key, record);
  }

  async get(projectId: string, blobKey: string) {
    return this.records.get(this.key(projectId, blobKey));
  }

  async delete(projectId: string, blobKey: string) {
    this.records.delete(this.key(projectId, blobKey));
  }

  async deleteMany(references: ReadonlyArray<{ projectId: string; blobKey: string }>) {
    for (const reference of references) this.records.delete(this.key(reference.projectId, reference.blobKey));
  }

  async list(projectId: string) {
    return [...this.records.values()].filter((record) => record.projectId === projectId);
  }

  async deleteProject(projectId: string) {
    for (const [key, record] of this.records) if (record.projectId === projectId) this.records.delete(key);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('CORE-007 IndexedDB Blob metadata boundary', () => {
  it('creates a reversible project-scoped locator without leaking a path or file name', () => {
    const locator = createBlobLocator('project / 中文', 'asset / 01');
    expect(locator).toBe('indexeddb://elyra-assets/project%20%2F%20%E4%B8%AD%E6%96%87/asset%20%2F%2001');
    expect(parseBlobLocator(locator)).toEqual({ projectId: 'project / 中文', blobKey: 'asset / 01' });
    expect(() => parseBlobLocator('https://example.com/private.jpg')).toThrow('BLOB_STORE_INVALID_LOCATOR');
  });

  it('stores only locator and digest metadata outside the backend Blob record', async () => {
    const backend = new MemoryBackend();
    const localStorage = { setItem: vi.fn(() => { throw new Error('localStorage must not be called'); }) };
    vi.stubGlobal('localStorage', localStorage);
    const store = new BlobStore(backend);
    const blob = new Blob(['safe synthetic pixels'], { type: 'image/png' });

    const metadata = await store.put('project-a', blob, {
      blobKey: 'asset-a',
      createdAt: '2026-08-05T00:00:00.000Z',
    });

    expect(metadata).toEqual({
      locator: 'indexeddb://elyra-assets/project-a/asset-a',
      projectId: 'project-a',
      blobKey: 'asset-a',
      sha256: await sha256Blob(blob),
      bytes: blob.size,
      mimeType: 'image/png',
      createdAt: '2026-08-05T00:00:00.000Z',
    });
    expect(metadata).not.toHaveProperty('blob');
    expect(backend.records.values().next().value?.blob).toBe(blob);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(await store.get(metadata)).toBe(blob);
  });

  it('persists three validated Blobs through one atomic backend batch', async () => {
    const backend = new MemoryBackend();
    const store = new BlobStore(backend);
    const blobs = ['left', 'front', 'right'].map((value) => new Blob([value], { type: 'image/png' }));

    const metadata = await store.putMany('project-a', blobs.map((blob, index) => ({
      blob,
      options: { blobKey: `job-a:${index}`, createdAt: '2026-08-21T00:00:00.000Z' },
    })));

    expect(backend.putManyCalls).toBe(1);
    expect(metadata.map((entry) => entry.blobKey)).toEqual(['job-a:0', 'job-a:1', 'job-a:2']);
    expect(metadata.every((entry) => entry.projectId === 'project-a' && entry.mimeType === 'image/png')).toBe(true);
    expect(backend.records.size).toBe(3);
    await expect(Promise.all(metadata.map((entry) => store.get(entry)))).resolves.toEqual(blobs);
  });

  it('replays one complete digest-identical stable batch and rejects changed or partial keys', async () => {
    const backend = new MemoryBackend();
    const store = new BlobStore(backend);
    const inputs = ['left', 'front', 'right'].map((value) => ({
      blob: new Blob([value], { type: 'image/png' }),
      options: { blobKey: `job-replay:${value}`, createdAt: '2026-08-21T00:00:00.000Z' },
    }));

    const first = await store.putMany('project-a', inputs);
    const replay = await store.putMany('project-a', inputs);
    expect(replay).toEqual(first);
    expect(backend.putManyCalls).toBe(1);
    expect(backend.records.size).toBe(3);

    await expect(store.putMany('project-a', inputs.map((input, index) => index === 1
      ? { ...input, blob: new Blob(['changed'], { type: 'image/png' }) }
      : input))).rejects.toThrow('BLOB_STORE_BATCH_KEY_CONFLICT');
    expect(backend.records.size).toBe(3);

    const partialBackend = new MemoryBackend();
    const partialStore = new BlobStore(partialBackend);
    await partialStore.put('project-a', inputs[0].blob, inputs[0].options);
    await expect(partialStore.putMany('project-a', inputs)).rejects.toThrow('BLOB_STORE_PARTIAL_BATCH_CONFLICT');
    expect(partialBackend.putManyCalls).toBe(0);
    expect(partialBackend.records.size).toBe(1);
  });

  it('accepts a concurrent exact commit without issuing a duplicate batch', async () => {
    class ConcurrentCommitBackend extends MemoryBackend {
      override async putMany(records: readonly StoredBlobRecord[]) {
        await super.putMany(records);
        throw new Error('SIMULATED_CONCURRENT_CONSTRAINT');
      }
    }
    const backend = new ConcurrentCommitBackend();
    const store = new BlobStore(backend);
    const result = await store.putMany('project-a', ['left45', 'front', 'right45'].map((slot) => ({
      blob: new Blob([slot], { type: 'image/png' }),
      options: { blobKey: `job-race:${slot}`, createdAt: '2026-08-21T00:00:00.000Z' },
    })));

    expect(result).toHaveLength(3);
    expect(backend.putManyCalls).toBe(1);
    expect(backend.records.size).toBe(3);
  });

  it('validates every batch member and duplicate key before any backend mutation', async () => {
    const backend = new MemoryBackend();
    const store = new BlobStore(backend);

    await expect(store.putMany('project-a', [
      { blob: new Blob(['valid'], { type: 'image/png' }), options: { blobKey: 'same' } },
      { blob: new Blob(['invalid'], { type: 'text/plain' }), options: { blobKey: 'other' } },
    ])).rejects.toThrow('BLOB_STORE_UNSUPPORTED_MIME_TYPE');
    expect(backend.putManyCalls).toBe(0);
    expect(backend.records.size).toBe(0);

    await expect(store.putMany('project-a', [
      { blob: new Blob(['one'], { type: 'image/png' }), options: { blobKey: 'same' } },
      { blob: new Blob(['two'], { type: 'image/png' }), options: { blobKey: 'same' } },
    ])).rejects.toThrow('BLOB_STORE_DUPLICATE_PUT_REFERENCE');
    expect(backend.putManyCalls).toBe(0);
    expect(backend.records.size).toBe(0);
  });

  it('leaves zero batch records when the backend transaction rejects', async () => {
    const backend = new MemoryBackend();
    backend.failPutMany = true;
    const store = new BlobStore(backend);

    await expect(store.putMany('project-a', [
      { blob: new Blob(['left'], { type: 'image/png' }), options: { blobKey: 'left45' } },
      { blob: new Blob(['front'], { type: 'image/png' }), options: { blobKey: 'front' } },
      { blob: new Blob(['right'], { type: 'image/png' }), options: { blobKey: 'right45' } },
    ])).rejects.toThrow('TEST_ATOMIC_BATCH_FAILURE');
    expect(backend.putManyCalls).toBe(1);
    expect(backend.records.size).toBe(0);
  });

  it('isolates list and project deletion by project id', async () => {
    const store = new BlobStore(new MemoryBackend());
    const first = await store.put('project-a', new Blob(['a'], { type: 'image/jpeg' }), { blobKey: 'one' });
    await store.put('project-a', new Blob(['b'], { type: 'image/webp' }), { blobKey: 'two' });
    const other = await store.put('project-b', new Blob(['c'], { type: 'image/png' }), { blobKey: 'one' });

    expect(await store.list('project-a')).toHaveLength(2);
    expect(await store.list('project-b')).toHaveLength(1);
    await store.delete(first, { expectedProjectId: 'project-a' });
    expect(await store.get(first)).toBeUndefined();
    await store.deleteProject('project-a');
    expect(await store.list('project-a')).toEqual([]);
    expect(await store.get(other)).toBeInstanceOf(Blob);
  });

  it('fails closed when a delete reference or current-project boundary is inconsistent', async () => {
    const store = new BlobStore(new MemoryBackend());
    const first = await store.put('project-a', new Blob(['a'], { type: 'image/png' }), { blobKey: 'one' });
    const other = await store.put('project-b', new Blob(['b'], { type: 'image/png' }), { blobKey: 'two' });

    await expect(store.delete({ ...first, projectId: 'project-b' }, { expectedProjectId: 'project-a' })).rejects.toThrow('BLOB_STORE_REFERENCE_MISMATCH');
    await expect(store.delete(other, { expectedProjectId: 'project-a' })).rejects.toThrow('BLOB_STORE_PROJECT_BOUNDARY_MISMATCH');
    expect(await store.get(first)).toBeInstanceOf(Blob);
    expect(await store.get(other)).toBeInstanceOf(Blob);
  });

  it('validates every reference before one atomic multi-Blob deletion', async () => {
    const backend = new MemoryBackend();
    const store = new BlobStore(backend);
    const first = await store.put('project-a', new Blob(['a'], { type: 'image/png' }), { blobKey: 'one' });
    const second = await store.put('project-a', new Blob(['b'], { type: 'image/png' }), { blobKey: 'two' });
    const other = await store.put('project-b', new Blob(['c'], { type: 'image/png' }), { blobKey: 'other' });

    await expect(store.deleteMany([first, other], { expectedProjectId: 'project-a' })).rejects.toThrow('BLOB_STORE_PROJECT_BOUNDARY_MISMATCH');
    expect(await store.get(first)).toBeInstanceOf(Blob);
    expect(await store.get(second)).toBeInstanceOf(Blob);
    expect(await store.get(other)).toBeInstanceOf(Blob);

    await store.deleteMany([first, second], { expectedProjectId: 'project-a' });
    expect(await store.list('project-a')).toEqual([]);
    expect(await store.get(other)).toBeInstanceOf(Blob);
  });

  it('fails closed when stored bytes or metadata no longer match their SHA-256 reference', async () => {
    const backend = new MemoryBackend();
    const store = new BlobStore(backend);
    const metadata = await store.put('project-a', new Blob(['original'], { type: 'image/png' }), { blobKey: 'asset-a' });
    const record = await backend.get('project-a', 'asset-a');
    if (!record) throw new Error('fixture missing');
    record.blob = new Blob(['tampered'], { type: 'image/png' });
    record.bytes = record.blob.size;

    await expect(store.get(metadata)).rejects.toThrow('BLOB_STORE_RECORD_DIGEST_MISMATCH');
  });

  it('stores a local MP4 Blob with the same project boundary and SHA-256 verification', async () => {
    const backend = new MemoryBackend();
    const store = new BlobStore(backend);
    const video = new Blob(['\x00\x00\x00\x18ftypmp42synthetic-video'], { type: 'video/mp4' });

    const metadata = await store.put('project-video', video, {
      blobKey: 'asset-video',
      createdAt: '2026-08-10T00:00:00.000Z',
    });

    expect(metadata).toMatchObject({
      locator: 'indexeddb://elyra-assets/project-video/asset-video',
      projectId: 'project-video',
      blobKey: 'asset-video',
      bytes: video.size,
      mimeType: 'video/mp4',
    });
    expect(metadata.sha256).toBe(await sha256Blob(video));
    expect(await store.get(metadata)).toBe(video);

    const record = await backend.get('project-video', 'asset-video');
    if (!record) throw new Error('fixture missing');
    record.blob = new Blob(['\x00\x00\x00\x18ftypmp42tampered-video'], { type: 'video/mp4' });
    record.bytes = record.blob.size;
    await expect(store.get(metadata)).rejects.toThrow('BLOB_STORE_RECORD_DIGEST_MISMATCH');
  });

  it('hydrates an object URL and revokes it exactly once', async () => {
    const store = new BlobStore(new MemoryBackend());
    const metadata = await store.put('project-a', new Blob(['pixels'], { type: 'image/png' }), { blobKey: 'asset-a' });
    const urlApi = { createObjectURL: vi.fn(() => 'blob:elyra-test'), revokeObjectURL: vi.fn() };

    const hydrated = await hydrateObjectUrl(store, metadata, urlApi);
    expect(hydrated?.url).toBe('blob:elyra-test');
    expect(urlApi.createObjectURL).toHaveBeenCalledOnce();
    hydrated?.revoke();
    hydrated?.revoke();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledOnce();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:elyra-test');
  });

  it('rejects unsupported or mismatched asset MIME metadata', async () => {
    const store = new BlobStore(new MemoryBackend());
    await expect(store.put('project-a', new Blob(['x'], { type: 'text/plain' }))).rejects.toThrow('BLOB_STORE_UNSUPPORTED_MIME_TYPE');
    await expect(
      store.put('project-a', new Blob(['x'], { type: 'image/png' }), { mimeType: 'image/jpeg' }),
    ).rejects.toThrow('BLOB_STORE_MIME_MISMATCH');
  });
});
