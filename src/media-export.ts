import type { Asset } from './agent';
import type { BlobStore } from './blob-store';
import { GENERATED_ASSET, type Workspace } from './domain';

export interface MediaExportTarget {
  key: string;
  filename: string;
  storage?: NonNullable<Asset['storage']>;
  fixedDemo: boolean;
  mimeType: Asset['mimeType'];
}

/** Bind an export to exactly one immutable media version, never to a task card. */
export function resolveMediaExportTarget(workspace: Workspace, projectId: string): MediaExportTarget | undefined {
  if (workspace.selectedIds.length !== 1) return;
  const node = workspace.nodes.find(item => item.id === workspace.selectedIds[0]);
  if (!node || node.status !== 'ready' || node.workflow || node.kind === 'workflow') return;
  const asset = workspace.assets.find(item => item.id === node.assetId);
  const fixedDemo = !node.assetId
    ? node.id === 'reference-demo' && node.kind === 'reference'
    : asset?.source === 'deterministic-mock' && asset.kind === 'image'
      && asset.providerId === 'deterministic-mock' && asset.uri === GENERATED_ASSET && !asset.storage;
  if (!asset?.storage && !fixedDemo) return;
  if (asset?.storage && (asset.storage.projectId !== projectId || asset.storage.mimeType !== asset.mimeType)) return;
  const mimeType = asset?.mimeType ?? 'image/png';
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4' })[mimeType];
  if (!extension || (fixedDemo && mimeType !== 'image/png')) return;
  return {
    key: JSON.stringify([projectId, node.id, node.versionId, asset?.id, asset?.storage, fixedDemo]),
    filename: `elyra-${node.id.replace(/[^a-z0-9_-]/gi, '_').slice(0, 100)}.${extension}`,
    storage: asset?.storage,
    fixedDemo: Boolean(fixedDemo),
    mimeType,
  };
}

/** No remote URL download and no substitution when a real asset is missing. */
export async function readMediaExportBlob(
  target: MediaExportTarget,
  store: Pick<BlobStore, 'get'>,
  fetchLocal: typeof fetch = fetch,
): Promise<Blob> {
  let blob: Blob | undefined;
  if (target.storage) {
    blob = await store.get(target.storage);
  } else if (target.fixedDemo) {
    const response = await fetchLocal(GENERATED_ASSET, { redirect: 'error', credentials: 'omit' });
    if (!response.ok) throw new Error('演示素材不可用，请重试。');
    blob = await response.blob();
  }
  if (!blob || !blob.size || blob.type !== target.mimeType) throw new Error('原件无法恢复，未导出替代图片。');
  return blob;
}
