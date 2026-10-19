export const BLOB_DATABASE_NAME = 'elyra-asset-blobs-v1';
export const BLOB_OBJECT_STORE_NAME = 'asset-blobs';

export type ImageBlobMimeType = 'image/jpeg' | 'image/png' | 'image/webp';
export type AssetBlobMimeType = ImageBlobMimeType | 'video/mp4';
export type IndexedDbBlobLocator = `indexeddb://elyra-assets/${string}/${string}`;

/**
 * Safe to persist in Workspace/localStorage. This record deliberately contains
 * no Blob, data URL, file name, provider URL, or local path.
 */
export interface BlobStorageMetadata {
  locator: IndexedDbBlobLocator;
  projectId: string;
  blobKey: string;
  sha256: string;
  bytes: number;
  mimeType: AssetBlobMimeType;
  createdAt: string;
}

export interface StoredBlobRecord extends BlobStorageMetadata {
  blob: Blob;
}

export interface StoreBackend {
  put(record: StoredBlobRecord): Promise<void>;
  /** Persist the entire batch in one backend transaction or persist nothing. */
  putMany(records: readonly StoredBlobRecord[]): Promise<void>;
  get(projectId: string, blobKey: string): Promise<StoredBlobRecord | undefined>;
  delete(projectId: string, blobKey: string): Promise<void>;
  deleteMany(references: ReadonlyArray<Pick<BlobStorageMetadata, 'projectId' | 'blobKey'>>): Promise<void>;
  list(projectId: string): Promise<StoredBlobRecord[]>;
  deleteProject(projectId: string): Promise<void>;
}

export interface PutBlobOptions {
  blobKey?: string;
  mimeType?: AssetBlobMimeType;
  createdAt?: string;
}

export interface PutBlobInput {
  blob: Blob;
  options?: PutBlobOptions;
}

export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface HydratedObjectUrl {
  url: string;
  blob: Blob;
  metadata: BlobStorageMetadata;
  revoke(): void;
}

interface IndexedDbStoredRecord extends StoredBlobRecord {
  storageKey: string;
}

const SUPPORTED_MIME_TYPES = new Set<AssetBlobMimeType>(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);

const assertNonEmpty = (value: string, name: string) => {
  if (!value.trim()) throw new Error(`BLOB_STORE_INVALID_${name.toUpperCase()}`);
};

const assertMimeType: (value: string) => asserts value is AssetBlobMimeType = (value) => {
  if (!SUPPORTED_MIME_TYPES.has(value as AssetBlobMimeType)) throw new Error('BLOB_STORE_UNSUPPORTED_MIME_TYPE');
};

const encodeLocatorPart = (value: string) => encodeURIComponent(value);
const decodeLocatorPart = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('BLOB_STORE_INVALID_LOCATOR');
  }
};

export const createBlobLocator = (projectId: string, blobKey: string): IndexedDbBlobLocator => {
  assertNonEmpty(projectId, 'project_id');
  assertNonEmpty(blobKey, 'blob_key');
  return `indexeddb://elyra-assets/${encodeLocatorPart(projectId)}/${encodeLocatorPart(blobKey)}`;
};

export const parseBlobLocator = (locator: string): Pick<BlobStorageMetadata, 'projectId' | 'blobKey'> => {
  const prefix = 'indexeddb://elyra-assets/';
  if (!locator.startsWith(prefix)) throw new Error('BLOB_STORE_INVALID_LOCATOR');
  const remainder = locator.slice(prefix.length);
  const separator = remainder.indexOf('/');
  if (separator <= 0 || separator === remainder.length - 1 || remainder.indexOf('/', separator + 1) !== -1) {
    throw new Error('BLOB_STORE_INVALID_LOCATOR');
  }
  const projectId = decodeLocatorPart(remainder.slice(0, separator));
  const blobKey = decodeLocatorPart(remainder.slice(separator + 1));
  assertNonEmpty(projectId, 'project_id');
  assertNonEmpty(blobKey, 'blob_key');
  return { projectId, blobKey };
};

const bytesToHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');

export const sha256Blob = async (blob: Blob, cryptoApi: Crypto = globalThis.crypto): Promise<string> => {
  if (!cryptoApi?.subtle) throw new Error('BLOB_STORE_WEB_CRYPTO_UNAVAILABLE');
  return bytesToHex(await cryptoApi.subtle.digest('SHA-256', await blob.arrayBuffer()));
};

const metadataFromRecord = ({ blob: _blob, ...metadata }: StoredBlobRecord): BlobStorageMetadata => metadata;
const storageKey = (projectId: string, blobKey: string) => `${projectId}\u0000${blobKey}`;

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('BLOB_STORE_INDEXEDDB_REQUEST_FAILED')), { once: true });
  });

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('BLOB_STORE_INDEXEDDB_TRANSACTION_ABORTED')), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('BLOB_STORE_INDEXEDDB_TRANSACTION_FAILED')), { once: true });
  });

/** Browser default backend. IndexedDB access is lazy so Node tests can inject a backend. */
export class IndexedDbBlobBackend implements StoreBackend {
  private database?: Promise<IDBDatabase>;

  constructor(private readonly indexedDb: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.indexedDb) throw new Error('BLOB_STORE_INDEXEDDB_UNAVAILABLE');
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.indexedDb!.open(BLOB_DATABASE_NAME, 1);
        request.addEventListener('upgradeneeded', () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(BLOB_OBJECT_STORE_NAME)) {
            const store = database.createObjectStore(BLOB_OBJECT_STORE_NAME, { keyPath: 'storageKey' });
            store.createIndex('projectId', 'projectId', { unique: false });
          }
        });
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error ?? new Error('BLOB_STORE_INDEXEDDB_OPEN_FAILED')), { once: true });
        request.addEventListener('blocked', () => reject(new Error('BLOB_STORE_INDEXEDDB_OPEN_BLOCKED')), { once: true });
      });
    }
    return this.database;
  }

  async put(record: StoredBlobRecord): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(BLOB_OBJECT_STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const request = transaction.objectStore(BLOB_OBJECT_STORE_NAME).put({
      ...record,
      storageKey: storageKey(record.projectId, record.blobKey),
    } satisfies IndexedDbStoredRecord);
    await requestResult(request);
    await done;
  }

  async putMany(records: readonly StoredBlobRecord[]): Promise<void> {
    if (records.length === 0) return;
    const database = await this.open();
    const transaction = database.transaction(BLOB_OBJECT_STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(BLOB_OBJECT_STORE_NAME);
    const writes = records.map((record) => requestResult(store.add({
      ...record,
      storageKey: storageKey(record.projectId, record.blobKey),
    } satisfies IndexedDbStoredRecord)));
    await Promise.all([done, ...writes]);
  }

  async get(projectId: string, blobKey: string): Promise<StoredBlobRecord | undefined> {
    const database = await this.open();
    const transaction = database.transaction(BLOB_OBJECT_STORE_NAME, 'readonly');
    const done = transactionDone(transaction);
    const record = await requestResult(
      transaction.objectStore(BLOB_OBJECT_STORE_NAME).get(storageKey(projectId, blobKey)) as IDBRequest<IndexedDbStoredRecord | undefined>,
    );
    await done;
    if (!record) return undefined;
    const { storageKey: _storageKey, ...stored } = record;
    return stored;
  }

  async delete(projectId: string, blobKey: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(BLOB_OBJECT_STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    await requestResult(transaction.objectStore(BLOB_OBJECT_STORE_NAME).delete(storageKey(projectId, blobKey)));
    await done;
  }

  async deleteMany(references: ReadonlyArray<Pick<BlobStorageMetadata, 'projectId' | 'blobKey'>>): Promise<void> {
    if (references.length === 0) return;
    const database = await this.open();
    const transaction = database.transaction(BLOB_OBJECT_STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(BLOB_OBJECT_STORE_NAME);
    for (const reference of references) store.delete(storageKey(reference.projectId, reference.blobKey));
    await done;
  }

  async list(projectId: string): Promise<StoredBlobRecord[]> {
    const database = await this.open();
    const transaction = database.transaction(BLOB_OBJECT_STORE_NAME, 'readonly');
    const done = transactionDone(transaction);
    const records = await requestResult(
      transaction.objectStore(BLOB_OBJECT_STORE_NAME).index('projectId').getAll(projectId) as IDBRequest<IndexedDbStoredRecord[]>,
    );
    await done;
    return records.map(({ storageKey: _storageKey, ...record }) => record);
  }

  async deleteProject(projectId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(BLOB_OBJECT_STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(BLOB_OBJECT_STORE_NAME);
    const keys = await requestResult(store.index('projectId').getAllKeys(projectId));
    for (const key of keys) store.delete(key);
    await done;
  }
}

export class BlobStore {
  constructor(
    private readonly backend: StoreBackend = new IndexedDbBlobBackend(),
    private readonly cryptoApi: Crypto = globalThis.crypto,
  ) {}

  async put(projectId: string, blob: Blob, options: PutBlobOptions = {}): Promise<BlobStorageMetadata> {
    assertNonEmpty(projectId, 'project_id');
    if (!(blob instanceof Blob)) throw new Error('BLOB_STORE_INVALID_BLOB');
    if (blob.size <= 0) throw new Error('BLOB_STORE_EMPTY_BLOB');
    const mimeType = options.mimeType ?? blob.type;
    assertMimeType(mimeType);
    if (blob.type && blob.type !== mimeType) throw new Error('BLOB_STORE_MIME_MISMATCH');

    const blobKey = options.blobKey ?? this.cryptoApi.randomUUID();
    assertNonEmpty(blobKey, 'blob_key');
    const metadata: BlobStorageMetadata = {
      locator: createBlobLocator(projectId, blobKey),
      projectId,
      blobKey,
      sha256: await sha256Blob(blob, this.cryptoApi),
      bytes: blob.size,
      mimeType,
      createdAt: options.createdAt ?? new Date().toISOString(),
    };
    await this.backend.put({ ...metadata, blob });
    return metadata;
  }

  async putMany(projectId: string, inputs: readonly PutBlobInput[]): Promise<BlobStorageMetadata[]> {
    assertNonEmpty(projectId, 'project_id');
    if (inputs.length === 0) return [];

    const prepared = inputs.map(({ blob, options = {} }) => {
      if (!(blob instanceof Blob)) throw new Error('BLOB_STORE_INVALID_BLOB');
      if (blob.size <= 0) throw new Error('BLOB_STORE_EMPTY_BLOB');
      const mimeType = options.mimeType ?? blob.type;
      assertMimeType(mimeType);
      if (blob.type && blob.type !== mimeType) throw new Error('BLOB_STORE_MIME_MISMATCH');
      const blobKey = options.blobKey ?? this.cryptoApi.randomUUID();
      assertNonEmpty(blobKey, 'blob_key');
      return { blob, options, mimeType, blobKey };
    });

    const seen = new Set<string>();
    for (const { blobKey } of prepared) {
      const key = storageKey(projectId, blobKey);
      if (seen.has(key)) throw new Error('BLOB_STORE_DUPLICATE_PUT_REFERENCE');
      seen.add(key);
    }

    const records = await Promise.all(prepared.map(async ({ blob, options, mimeType, blobKey }) => ({
      locator: createBlobLocator(projectId, blobKey),
      projectId,
      blobKey,
      sha256: await sha256Blob(blob, this.cryptoApi),
      bytes: blob.size,
      mimeType,
      createdAt: options.createdAt ?? new Date().toISOString(),
      blob,
    } satisfies StoredBlobRecord)));
    const replay = await this.readExactBatchReplay(records);
    if (replay) return replay;
    try {
      await this.backend.putMany(records);
      return records.map(metadataFromRecord);
    } catch (error) {
      // Another tab/process may have committed this exact stable Job batch
      // after the preflight read. Reuse only a complete digest-identical set;
      // a partial or changed set remains a hard conflict.
      const concurrentReplay = await this.readExactBatchReplay(records);
      if (concurrentReplay) return concurrentReplay;
      throw error;
    }
  }

  async get(reference: BlobStorageMetadata | IndexedDbBlobLocator): Promise<Blob | undefined> {
    const locator = typeof reference === 'string' ? reference : reference.locator;
    const { projectId, blobKey } = parseBlobLocator(locator);
    if (typeof reference !== 'string' && (reference.projectId !== projectId || reference.blobKey !== blobKey)) {
      throw new Error('BLOB_STORE_REFERENCE_MISMATCH');
    }
    const record = await this.backend.get(projectId, blobKey);
    if (!record) return undefined;
    await this.verifyRecord(record, typeof reference === 'string' ? undefined : reference);
    return record.blob;
  }

  async getMetadata(locator: IndexedDbBlobLocator): Promise<BlobStorageMetadata | undefined> {
    const { projectId, blobKey } = parseBlobLocator(locator);
    const record = await this.backend.get(projectId, blobKey);
    if (!record) return undefined;
    await this.verifyRecord(record);
    return metadataFromRecord(record);
  }

  async delete(reference: BlobStorageMetadata | IndexedDbBlobLocator, options: { expectedProjectId?: string } = {}): Promise<void> {
    const { projectId, blobKey } = parseBlobLocator(typeof reference === 'string' ? reference : reference.locator);
    if (options.expectedProjectId !== undefined && projectId !== options.expectedProjectId) {
      throw new Error('BLOB_STORE_PROJECT_BOUNDARY_MISMATCH');
    }
    if (typeof reference !== 'string' && (reference.projectId !== projectId || reference.blobKey !== blobKey)) {
      throw new Error('BLOB_STORE_REFERENCE_MISMATCH');
    }
    const record = await this.backend.get(projectId, blobKey);
    if (!record) return;
    await this.verifyRecord(record, typeof reference === 'string' ? undefined : reference);
    await this.backend.delete(projectId, blobKey);
  }

  async deleteMany(references: readonly BlobStorageMetadata[], options: { expectedProjectId?: string } = {}): Promise<void> {
    const validated = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const { projectId, blobKey } = parseBlobLocator(reference.locator);
      if (options.expectedProjectId !== undefined && projectId !== options.expectedProjectId) {
        throw new Error('BLOB_STORE_PROJECT_BOUNDARY_MISMATCH');
      }
      if (reference.projectId !== projectId || reference.blobKey !== blobKey) throw new Error('BLOB_STORE_REFERENCE_MISMATCH');
      const key = storageKey(projectId, blobKey);
      if (seen.has(key)) throw new Error('BLOB_STORE_DUPLICATE_DELETE_REFERENCE');
      seen.add(key);
      const record = await this.backend.get(projectId, blobKey);
      if (record) await this.verifyRecord(record, reference);
      validated.push({ projectId, blobKey });
    }
    await this.backend.deleteMany(validated);
  }

  async list(projectId: string): Promise<BlobStorageMetadata[]> {
    assertNonEmpty(projectId, 'project_id');
    const records = await this.backend.list(projectId);
    return Promise.all(
      records.map(async (record) => {
        await this.verifyRecord(record);
        return metadataFromRecord(record);
      }),
    );
  }

  async deleteProject(projectId: string): Promise<void> {
    assertNonEmpty(projectId, 'project_id');
    await this.backend.deleteProject(projectId);
  }

  private async verifyRecord(record: StoredBlobRecord, expected?: BlobStorageMetadata): Promise<void> {
    const parsed = parseBlobLocator(record.locator);
    if (parsed.projectId !== record.projectId || parsed.blobKey !== record.blobKey) throw new Error('BLOB_STORE_RECORD_LOCATOR_MISMATCH');
    if (record.bytes !== record.blob.size) throw new Error('BLOB_STORE_RECORD_SIZE_MISMATCH');
    if (record.blob.type && record.blob.type !== record.mimeType) throw new Error('BLOB_STORE_RECORD_MIME_MISMATCH');
    assertMimeType(record.mimeType);
    const digest = await sha256Blob(record.blob, this.cryptoApi);
    if (digest !== record.sha256) throw new Error('BLOB_STORE_RECORD_DIGEST_MISMATCH');
    if (expected && (
      expected.sha256 !== record.sha256
      || expected.bytes !== record.bytes
      || expected.mimeType !== record.mimeType
      || expected.projectId !== record.projectId
      || expected.blobKey !== record.blobKey
    )) throw new Error('BLOB_STORE_REFERENCE_MISMATCH');
  }

  private async readExactBatchReplay(records: readonly StoredBlobRecord[]): Promise<BlobStorageMetadata[] | undefined> {
    const existing = await Promise.all(records.map((record) => this.backend.get(record.projectId, record.blobKey)));
    const present = existing.filter((record): record is StoredBlobRecord => Boolean(record));
    if (present.length === 0) return undefined;
    if (present.length !== records.length) throw new Error('BLOB_STORE_PARTIAL_BATCH_CONFLICT');
    try {
      for (let index = 0; index < records.length; index += 1) {
        await this.verifyRecord(present[index], metadataFromRecord(records[index]));
      }
    } catch {
      throw new Error('BLOB_STORE_BATCH_KEY_CONFLICT');
    }
    return present.map(metadataFromRecord);
  }
}

export const hydrateObjectUrl = async (
  store: BlobStore,
  reference: BlobStorageMetadata,
  urlApi: ObjectUrlApi = URL,
): Promise<HydratedObjectUrl | undefined> => {
  const blob = await store.get(reference);
  if (!blob) return undefined;
  const url = urlApi.createObjectURL(blob);
  let revoked = false;
  return {
    url,
    blob,
    metadata: reference,
    revoke: () => {
      if (revoked) return;
      revoked = true;
      urlApi.revokeObjectURL(url);
    },
  };
};
