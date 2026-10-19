import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App, { type AssetAddRequest, type AssetAddResult } from './App';
import { BLOB_DATABASE_NAME, BlobStore, hydrateObjectUrl, type BlobStorageMetadata, type HydratedObjectUrl } from './blob-store';
import { GENERATED_ASSET, readWorkspace, persistWorkspace, type Workspace } from './domain';
import { materializeSkill, SkillRunGate, type SkillLaunchDraft, type PendingSkillRun } from './skill-launch';
import { sanitizeUserImageFile } from './image-upload';
import { FrontstageBlobReservations } from './frontstage-blob-reservations';
import {
  createLocalProject,
  ensureLocalProjectCatalog,
  listLocalProjects,
  readLocalProjectCatalog,
  renameLocalProject,
  restoreLocalProject,
  setActiveLocalProject,
  trashLocalProject,
  type LocalProjectCatalogV1,
  type LocalProjectRecord,
} from './local-projects';
import ProductFrontstage, {
  type FrontstageAssetSummary,
  type FrontstageProjectSummary,
  type FrontstageStagedReference,
  type ProductFrontstageHandoffDraft,
} from './ProductFrontstage';
import {
  createHomeWorkspaceHandoff,
  clearHomeWorkspaceHandoff,
  clearPortalDraft,
  getPortalProjectSummaries,
  parsePortalRoute,
  peekHomeWorkspaceHandoff,
  savePortalDraft,
  saveHomeWorkspaceHandoff,
  setPortalTheme,
  writePortalRoute,
  type PortalProjectSummary,
  type PortalRoute,
} from './portal-state';
import './styles.css';

type CatalogState =
  | { status: 'ready'; catalog: LocalProjectCatalogV1 }
  | { status: 'corrupt'; code: string };

type FrontstageViews = {
  projects: FrontstageProjectSummary[];
  trashedProjects: FrontstageProjectSummary[];
  assets: FrontstageAssetSummary[];
};

const emptyViews = (): FrontstageViews => ({ projects: [], trashedProjects: [], assets: [] });

const bootstrapCatalog = (): CatalogState => {
  const result = ensureLocalProjectCatalog();
  return result.status === 'ready'
    ? { status: 'ready', catalog: result.catalog }
    : { status: 'corrupt', code: result.code };
};

const sourceLabel = (source: string) => {
  if (source === 'local-upload') return '本机导入';
  if (source === 'remote-provider') return '已落盘的 Provider 结果';
  return '本地确定性结果';
};

const safeProjectWorkspace = (projectId: string): Workspace | undefined => {
  const result = readWorkspace(projectId);
  return result.status === 'ready' || result.status === 'migrated' ? result.workspace : undefined;
};

function ElyraRoot() {
  const [route, setRoute] = useState<PortalRoute>(() => parsePortalRoute(window.location.hash));
  const [catalogState, setCatalogState] = useState<CatalogState>(bootstrapCatalog);
  const [views, setViews] = useState<FrontstageViews>(emptyViews);
  const [handoffSubmitting, setHandoffSubmitting] = useState(false);
  const [assetToAdd, setAssetToAdd] = useState<AssetAddRequest>();
  const [skillToRun, setSkillToRun] = useState<PendingSkillRun>();
  const skillGateRef = useRef(new SkillRunGate());
  const skillSubmitLockRef = useRef(false);
  const routeRef = useRef(route);
  const catalogRef = useRef(catalogState);
  const workspaceLeaveGuardRef = useRef<(() => boolean) | null>(null);
  const blobStoreRef = useRef(new BlobStore());
  const viewHydratedUrlsRef = useRef(new Map<string, HydratedObjectUrl>());
  const viewRefreshEpochRef = useRef(0);
  const staleBlobCleanupRef = useRef(new Map<string, Promise<void>>());
  const stagedBlobReservationsRef = useRef(new FrontstageBlobReservations());

  const catalog = catalogState.status === 'ready' ? catalogState.catalog : undefined;
  const activeProject = catalog?.projects.find((project) => project.id === catalog.activeProjectId && !project.trashedAt);
  const activeWorkspaceRead = activeProject ? readWorkspace(activeProject.id) : undefined;
  const fallbackProject = useMemo<PortalProjectSummary>(() => ({
    id: activeProject?.id ?? 'elyra-local-project-v1',
    title: activeProject?.title ?? '本地项目不可用',
    theme: 'dark',
    objectCount: 0,
    imageCount: 0,
    videoCount: 0,
    versionCount: 0,
    hasLocalContent: false,
  }), [activeProject]);
  const activeProjectSummary = views.projects.find((project) => project.id === activeProject?.id) ?? fallbackProject;

  useEffect(() => {
    catalogRef.current = catalogState;
  }, [catalogState]);

  const refreshCatalog = useCallback((): LocalProjectCatalogV1 | undefined => {
    const result = readLocalProjectCatalog();
    const next: CatalogState = result.status === 'ready'
      ? { status: 'ready', catalog: result.catalog }
      : result.status === 'missing'
        ? bootstrapCatalog()
        : { status: 'corrupt', code: result.code };
    catalogRef.current = next;
    setCatalogState(next);
    return next.status === 'ready' ? next.catalog : undefined;
  }, []);

  const refreshViews = useCallback(async (catalogValue?: LocalProjectCatalogV1) => {
    const currentCatalog = catalogValue ?? (catalogRef.current.status === 'ready' ? catalogRef.current.catalog : undefined);
    if (!currentCatalog) {
      setViews(emptyViews());
      return;
    }
    const epoch = ++viewRefreshEpochRef.current;
    const hydrated = new Map<string, HydratedObjectUrl>();
    const allProjects = currentCatalog.projects;
    const baseSummaries = getPortalProjectSummaries(allProjects);
    const baseById = new Map(baseSummaries.map((summary) => [summary.id, summary]));
    const nextAssets: FrontstageAssetSummary[] = [];
    const coverByProject = new Map<string, Pick<FrontstageProjectSummary, 'coverUrl' | 'coverKind'>>();

    for (const project of allProjects) {
      const workspace = safeProjectWorkspace(project.id);
      if (!workspace) continue;
      for (const asset of workspace.assets) {
        const references = workspace.nodes.filter((node) => node.assetId === asset.id);
        const versions = workspace.versions.filter((version) => references.some((node) => node.id === version.canvasObjectId));
        let availability: FrontstageAssetSummary['availability'] = 'missing';
        let thumbnailUrl: string | undefined;
        if (asset.source === 'deterministic-mock' && asset.uri === GENERATED_ASSET) {
          availability = 'available';
          thumbnailUrl = GENERATED_ASSET;
        } else if (asset.storage?.projectId === project.id) {
          try {
            const item = await hydrateObjectUrl(blobStoreRef.current, asset.storage);
            if (item) {
              hydrated.set(`${project.id}:${asset.id}`, item);
              availability = 'available';
              thumbnailUrl = item.url;
            }
          } catch {
            availability = 'missing';
          }
        }
        const firstNode = references[0];
        const title = firstNode?.name ?? (asset.kind === 'video' ? '本地视频资产' : '本地图片资产');
        nextAssets.push({
          id: asset.id,
          projectId: project.id,
          title,
          kind: asset.kind,
          mimeType: asset.mimeType,
          width: asset.metadata.width,
          height: asset.metadata.height,
          ...(asset.metadata.durationSeconds ? { durationSeconds: asset.metadata.durationSeconds } : {}),
          createdAt: asset.createdAt,
          sourceLabel: sourceLabel(asset.source),
          referenceCount: references.length,
          availability,
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
          ...(versions.length ? { lineageLabel: `${versions.length} 个版本` } : {}),
        });
        if (thumbnailUrl && !coverByProject.has(project.id)) {
          coverByProject.set(project.id, { coverUrl: thumbnailUrl, coverKind: asset.kind });
        }
      }
      if (!coverByProject.has(project.id) && workspace.nodes.some(node => node.id === 'reference-demo' && node.kind === 'reference' && node.status === 'ready')) {
        coverByProject.set(project.id, { coverUrl: '/assets/elyra-speaker.png', coverKind: 'image' });
      }
    }

    if (epoch !== viewRefreshEpochRef.current) {
      for (const item of hydrated.values()) item.revoke();
      return;
    }
    for (const item of viewHydratedUrlsRef.current.values()) item.revoke();
    viewHydratedUrlsRef.current = hydrated;
    const toSummary = (project: LocalProjectRecord): FrontstageProjectSummary => ({
      ...(baseById.get(project.id) ?? {
        id: project.id,
        title: project.title,
        theme: 'dark' as const,
        objectCount: 0,
        imageCount: 0,
        videoCount: 0,
        versionCount: 0,
        hasLocalContent: false,
      }),
      title: project.title,
      updatedAt: project.updatedAt,
      ...(project.trashedAt ? { trashedAt: project.trashedAt } : {}),
      ...(coverByProject.get(project.id) ?? {}),
    });
    setViews({
      projects: listLocalProjects(currentCatalog).map(toSummary),
      trashedProjects: listLocalProjects(currentCatalog, { includeTrashed: true }).filter((project) => project.trashedAt).map(toSummary),
      assets: nextAssets,
    });
  }, []);

  useEffect(() => {
    if (catalog) void refreshViews(catalog);
  }, [catalog, refreshViews]);

  useEffect(() => () => {
    viewRefreshEpochRef.current += 1;
    for (const item of viewHydratedUrlsRef.current.values()) item.revoke();
    viewHydratedUrlsRef.current.clear();
  }, []);

  const ensureStaleFrontstageBlobsCleaned = useCallback((projectId: string) => {
    const running = staleBlobCleanupRef.current.get(projectId);
    if (running) return running;
    const cleanup = (async () => {
      const workspaceResult = readWorkspace(projectId);
      const pendingHandoff = peekHomeWorkspaceHandoff(Date.now(), projectId);
      if (workspaceResult.status === 'corrupt') return;
      if (workspaceResult.status === 'missing' && !pendingHandoff && typeof window.indexedDB.databases === 'function') {
        const databases = await window.indexedDB.databases();
        if (!databases.some((database) => database.name === BLOB_DATABASE_NAME)) return;
      }
      const retainedLocators = new Set<string>(
        workspaceResult.status === 'ready' || workspaceResult.status === 'migrated'
          ? workspaceResult.workspace.assets.flatMap((asset) => asset.storage ? [asset.storage.locator] : [])
          : [],
      );
      if (pendingHandoff?.stagedReference) retainedLocators.add(pendingHandoff.stagedReference.storage.locator);
      for (const locator of stagedBlobReservationsRef.current.locatorsFor(projectId)) retainedLocators.add(locator);
      const stored = await blobStoreRef.current.list(projectId);
      for (const record of stored) {
        if (!retainedLocators.has(record.locator)) {
          await blobStoreRef.current.delete(record, { expectedProjectId: projectId });
        }
      }
    })().finally(() => {
      if (staleBlobCleanupRef.current.get(projectId) === cleanup) staleBlobCleanupRef.current.delete(projectId);
    });
    staleBlobCleanupRef.current.set(projectId, cleanup);
    return cleanup;
  }, []);

  const canLeaveWorkspace = useCallback(() => {
    if (routeRef.current !== 'workspace' || !workspaceLeaveGuardRef.current) return true;
    return workspaceLeaveGuardRef.current();
  }, []);

  const navigate = useCallback((nextRoute: PortalRoute) => {
    if (routeRef.current === 'workspace' && nextRoute !== 'workspace' && !canLeaveWorkspace()) {
      window.history.replaceState(null, '', '#/workspace');
      routeRef.current = 'workspace';
      setRoute('workspace');
      return false;
    }
    writePortalRoute(nextRoute);
    routeRef.current = nextRoute;
    setRoute(nextRoute);
    const refreshed = refreshCatalog();
    if (refreshed) void refreshViews(refreshed);
    return true;
  }, [canLeaveWorkspace, refreshCatalog, refreshViews]);

  const registerWorkspaceLeaveGuard = useCallback((guard: (() => boolean) | null) => {
    workspaceLeaveGuardRef.current = guard;
  }, []);

  const createProject = useCallback((title: string) => {
    const result = createLocalProject({ title });
    catalogRef.current = { status: 'ready', catalog: result.catalog };
    setCatalogState({ status: 'ready', catalog: result.catalog });
    setAssetToAdd(undefined);
    navigate('workspace');
    return true;
  }, [navigate]);

  const openProject = useCallback((projectId: string) => {
    if (!canLeaveWorkspace()) return false;
    const next = setActiveLocalProject(projectId);
    catalogRef.current = { status: 'ready', catalog: next };
    setCatalogState({ status: 'ready', catalog: next });
    setAssetToAdd(undefined);
    writePortalRoute('workspace');
    routeRef.current = 'workspace';
    setRoute('workspace');
    void refreshViews(next);
    return true;
  }, [canLeaveWorkspace, refreshViews]);

  const renameProject = useCallback((projectId: string, title: string) => {
    const next = renameLocalProject(projectId, title);
    catalogRef.current = { status: 'ready', catalog: next };
    setCatalogState({ status: 'ready', catalog: next });
    void refreshViews(next);
    return true;
  }, [refreshViews]);

  const moveProjectToTrash = useCallback((projectId: string) => {
    if (routeRef.current === 'workspace' && !canLeaveWorkspace()) return false;
    const next = trashLocalProject(projectId, { confirmed: true });
    catalogRef.current = { status: 'ready', catalog: next };
    setCatalogState({ status: 'ready', catalog: next });
    setAssetToAdd(undefined);
    if (routeRef.current === 'workspace') {
      writePortalRoute('projects');
      routeRef.current = 'projects';
      setRoute('projects');
    }
    void refreshViews(next);
    return true;
  }, [canLeaveWorkspace, refreshViews]);

  const restoreProject = useCallback((projectId: string) => {
    const next = restoreLocalProject(projectId);
    catalogRef.current = { status: 'ready', catalog: next };
    setCatalogState({ status: 'ready', catalog: next });
    void refreshViews(next);
    return true;
  }, [refreshViews]);

  const openAssetLibrary = useCallback((projectId?: string) => {
    if (projectId && catalogRef.current.status === 'ready' && catalogRef.current.catalog.activeProjectId !== projectId) {
      if (!canLeaveWorkspace()) return false;
      const next = setActiveLocalProject(projectId);
      catalogRef.current = { status: 'ready', catalog: next };
      setCatalogState({ status: 'ready', catalog: next });
    }
    return navigate('assets');
  }, [canLeaveWorkspace, navigate]);

  const addAssetToCanvas = useCallback((projectId: string, assetId: string) => {
    if (!canLeaveWorkspace()) return false;
    const current = catalogRef.current;
    if (current.status !== 'ready' || !current.catalog.projects.some((project) => project.id === projectId && !project.trashedAt)) return false;
    const next = setActiveLocalProject(projectId);
    catalogRef.current = { status: 'ready', catalog: next };
    setCatalogState({ status: 'ready', catalog: next });
    setAssetToAdd({ requestId: crypto.randomUUID(), assetId });
    writePortalRoute('workspace');
    routeRef.current = 'workspace';
    setRoute('workspace');
    return true;
  }, [canLeaveWorkspace]);

  const reclaimFrontstageBlob = useCallback(async (storage: BlobStorageMetadata) => {
    stagedBlobReservationsRef.current.release(storage.projectId, storage.locator);
    try {
      await blobStoreRef.current.delete(storage, { expectedProjectId: storage.projectId });
    } catch {
      // A transient IndexedDB failure must not turn an abandoned composer Blob
      // into a permanent leak, especially after its project moves to trash.
      await ensureStaleFrontstageBlobsCleaned(storage.projectId);
    }
  }, [ensureStaleFrontstageBlobsCleaned]);

  const stageFrontstageAttachment = useCallback(async (file: File): Promise<FrontstageStagedReference> => {
    const current = catalogRef.current;
    if (current.status !== 'ready') throw new Error('本地项目目录不可用，未暂存附件。');
    const projectId = current.catalog.activeProjectId;
    await ensureStaleFrontstageBlobsCleaned(projectId);
    const sanitized = await sanitizeUserImageFile(file, { projectId });
    // Reserve the deterministic locator before IndexedDB makes the Blob
    // visible. A concurrent catalog/view refresh must never observe the new
    // bytes in the gap before the composer receives its staged reference.
    stagedBlobReservationsRef.current.reserve(projectId, sanitized.storage.locator);
    let storage: BlobStorageMetadata;
    try {
      storage = await blobStoreRef.current.put(projectId, sanitized.sanitizedBlob, {
        blobKey: sanitized.storage.blobKey,
        mimeType: 'image/png',
        createdAt: sanitized.storage.createdAt,
      });
    } catch (error) {
      await reclaimFrontstageBlob(sanitized.storage).catch(() => undefined);
      throw error;
    }
    if (
      storage.locator !== sanitized.storage.locator
      || storage.sha256 !== sanitized.storage.sha256
      || storage.bytes !== sanitized.storage.bytes
      || storage.mimeType !== 'image/png'
    ) {
      await reclaimFrontstageBlob(storage);
      throw new Error('本地附件存储校验失败，文件没有进入工作台。');
    }
    return { assetId: sanitized.assetId, width: sanitized.width, height: sanitized.height, storage };
  }, [ensureStaleFrontstageBlobsCleaned, reclaimFrontstageBlob]);

  const discardFrontstageAttachment = useCallback(async (reference: FrontstageStagedReference) => {
    await reclaimFrontstageBlob(reference.storage);
  }, [reclaimFrontstageBlob]);

  const submitFrontstageHandoff = useCallback(async (draft: ProductFrontstageHandoffDraft) => {
    if (handoffSubmitting) return;
    const current = catalogRef.current;
    if (current.status !== 'ready') throw new Error('本地项目目录不可用，无法进入工作台。');
    const projectId = current.catalog.activeProjectId;
    setHandoffSubmitting(true);
    try {
      const handoff = createHomeWorkspaceHandoff({
        source: draft.source,
        projectId,
        prompt: draft.prompt,
        creationMode: draft.creationMode,
        imageProviderId: draft.imageProviderId,
        ...(draft.preset ? { preset: draft.preset } : {}),
        ...(draft.stagedReference ? { stagedReference: draft.stagedReference } : {}),
      }, Date.now(), projectId);
      if (!handoff || !saveHomeWorkspaceHandoff(handoff, Date.now(), projectId)) {
        throw new Error('无法建立安全的一次性工作台交接，请重试。');
      }
      if (draft.stagedReference) {
        stagedBlobReservationsRef.current.release(projectId, draft.stagedReference.storage.locator);
      }
      navigate('workspace');
    } finally {
      setHandoffSubmitting(false);
    }
  }, [handoffSubmitting, navigate]);

  const onAssetAdded = useCallback((result: AssetAddResult) => {
    setAssetToAdd((current) => current?.requestId === result.requestId ? undefined : current);
  }, []);

  const launchSkill = useCallback(async (draft: SkillLaunchDraft) => {
    if (skillSubmitLockRef.current) throw new Error('正在添加 Skill，请稍候。');
    skillSubmitLockRef.current = true;
    try {
      const current = catalogRef.current;
      if (current.status !== 'ready') throw new Error('本地项目不可用，请重新打开项目。');
      const projectId = current.catalog.activeProjectId;
      if (draft.reference) {
        const blob = await blobStoreRef.current.get(draft.reference.storage);
        if (!blob || blob.size !== draft.reference.storage.bytes || blob.type !== 'image/png') throw new Error('参考图暂存失败，请重新上传。');
      }
      if (catalogRef.current.status !== 'ready' || catalogRef.current.catalog.activeProjectId !== projectId || routeRef.current === 'workspace') throw new Error('当前项目已切换，请重新选择 Skill。');
      const workspace = safeProjectWorkspace(projectId);
      if (!workspace) throw new Error('画布无法安全读取，原项目已保留。');
      if (workspace.jobs.some(job => !['succeeded', 'failed', 'user_cancelled'].includes(job.status))) throw new Error('画布还有未结束的任务，请先回到画布处理。');
      const id = crypto.randomUUID();
      const materialized = materializeSkill(workspace, draft, id, projectId);
      persistWorkspace(materialized.workspace, window.localStorage, projectId);
      const ticket: PendingSkillRun = { id, projectId, nodeId: materialized.nodeId, prompt: materialized.prompt, model: draft.model, transferConsent: draft.transferConsent, expiresAt: Date.now() + 60_000 };
      skillGateRef.current.arm(ticket);
      setSkillToRun(ticket);
      if (draft.reference) stagedBlobReservationsRef.current.release(projectId, draft.reference.storage.locator);
      clearHomeWorkspaceHandoff();
      clearPortalDraft();
      navigate('workspace');
    } finally { skillSubmitLockRef.current = false; }
  }, [navigate]);

  const claimSkillRun = useCallback((id: string, projectId: string) => {
    const claimed = skillGateRef.current.claim(id, projectId);
    setSkillToRun(current => current?.id === id ? undefined : current);
    return claimed;
  }, []);

  useEffect(() => {
    routeRef.current = route;
    if (route !== 'workspace') {
      skillGateRef.current.clear();
      setSkillToRun(undefined);
    }
  }, [route]);

  useEffect(() => {
    if (route !== 'workspace' && activeProject) void ensureStaleFrontstageBlobsCleaned(activeProject.id).catch(() => undefined);
  }, [activeProject, ensureStaleFrontstageBlobsCleaned, route]);

  useEffect(() => {
    if (!window.location.hash || window.location.hash !== `#/${parsePortalRoute(window.location.hash)}`) {
      window.history.replaceState(null, '', '#/home');
      setRoute('home');
    }
    const onHashChange = () => {
      const nextRoute = parsePortalRoute(window.location.hash);
      if (routeRef.current === 'workspace' && nextRoute !== 'workspace' && !canLeaveWorkspace()) {
        window.history.replaceState(null, '', '#/workspace');
        routeRef.current = 'workspace';
        setRoute('workspace');
        return;
      }
      if (window.location.hash !== `#/${nextRoute}`) window.history.replaceState(null, '', `#/${nextRoute}`);
      routeRef.current = nextRoute;
      setRoute(nextRoute);
      const refreshed = refreshCatalog();
      if (refreshed) void refreshViews(refreshed);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [canLeaveWorkspace, refreshCatalog, refreshViews]);

  if (catalogState.status === 'corrupt' || !catalog || !activeProject || activeWorkspaceRead?.status === 'corrupt') {
    const errorCode = catalogState.status === 'corrupt'
      ? catalogState.code
      : activeWorkspaceRead?.status === 'corrupt'
        ? activeWorkspaceRead.code
        : 'LOCAL_PROJECT_ACTIVE_MISSING';
    return <main className="local-project-fatal" data-testid="local-project-catalog-error"><section role="alert"><strong>本地项目目录无法安全读取</strong><p>ELYRA 没有覆盖或删除任何画布与素材。请保留当前浏览器数据后再检查。</p><code>{errorCode}</code></section></main>;
  }

  if (route === 'workspace') {
    return <App
      key={activeProject.id}
      projectId={activeProject.id}
      projectTitle={activeProject.title}
      onExitWorkspace={() => navigate('projects')}
      onRegisterLeaveGuard={registerWorkspaceLeaveGuard}
      onTrashProject={moveProjectToTrash}
      onOpenAssetLibrary={openAssetLibrary}
      assetToAdd={assetToAdd}
      onAssetAdded={onAssetAdded}
      skillToRun={skillToRun}
      onClaimSkillRun={claimSkillRun}
    />;
  }

  return (
    <ProductFrontstage
      key={activeProject.id}
      route={route}
      theme={activeProjectSummary.theme}
      project={activeProjectSummary}
      projects={views.projects}
      activeProjectId={activeProject.id}
      trashedProjects={views.trashedProjects}
      assets={views.assets}
      onNavigate={navigate}
      onToggleTheme={() => {
        const nextTheme = activeProjectSummary.theme === 'dark' ? 'light' : 'dark';
        if (setPortalTheme(nextTheme, activeProject.id)) {
          const refreshed = refreshCatalog();
          if (refreshed) void refreshViews(refreshed);
        }
      }}
      onOpenWorkspace={() => navigate('workspace')}
      onOpenAssetLibrary={() => openAssetLibrary(activeProject.id)}
      onCreateProject={createProject}
      onOpenProject={openProject}
      onRenameProject={renameProject}
      onMoveProjectToTrash={moveProjectToTrash}
      onRestoreProject={restoreProject}
      onAddAssetToCanvas={addAssetToCanvas}
      onUseInspiration={(prompt) => { if (savePortalDraft(prompt)) navigate('workspace'); }}
      onSubmitHandoff={submitFrontstageHandoff}
      onStageAttachment={stageFrontstageAttachment}
      onDiscardStagedAttachment={discardFrontstageAttachment}
      isHandoffSubmitting={handoffSubmitting}
      onLaunchSkill={launchSkill}
    />
  );
}

const root = createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
root.render(
  <StrictMode>
    <ElyraRoot />
  </StrictMode>,
);
