import type { PersistedAgentRunPresentation } from "./agent-run-persistence";
import { buildCanvasContextGraphSnapshot } from "./canvas-context";
import { sha256Blob, type BlobStore } from "./blob-store";
import type { Workspace } from "./domain";

const SHA256 = /^[0-9a-f]{64}$/;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const VIDEO_PROVIDER = "evolink-sora-2-preview";

type ServerVideoEvidence = {
  clientJobIdSha256: string;
  requestSha256: string;
  sourceSha256: string;
  uploadSha256: string;
  providerTaskIdSha256: string;
  providerSubmitCount: number;
  statusRequestCount: number;
  status: string;
  resultSha256: string;
  resultBytes: number;
  resultDurationSeconds: number;
  resultDimensions: [number, number];
  budgetCapUsd: number;
  budgetUsedUsd: number;
  softCancelled: boolean;
};

export type Core009LiveReceipt = {
  schema_version: 1;
  milestone: "CORE-009-THREE-MODE-ROUTING-VIDEO-V1";
  status: "PASS_REAL_SORA_LOCAL_RECEIPT";
  captured_at: string;
  capture_context: {
    navigation_type: string;
    captured_after_reload: boolean;
    localhost_only: true;
    localhost_origin: string;
    provider_url_persisted: false;
    raw_provider_task_id_persisted: false;
    raw_prompt_persisted: false;
  };
  route: {
    mode: "video";
    operation: "video_image_to_video";
    planner_submissions: 1;
    image_submissions: 0;
    video_submissions: 1;
    automatic_paid_resubmissions: 0;
    provenance: {
      planner_submissions_derived_from_retained_remote_plan_and_single_submit_protocol: true;
      planner_network_request_receipt_persisted: false;
      image_submissions_derived_from_plan_scoped_jobs: true;
      video_submissions_derived_from_server_provider_submit_count: true;
      automatic_paid_resubmissions_derived_from_server_submit_count: true;
    };
    proof: {
      matching_remote_intent_count: 1;
      matching_remote_plan_count: 1;
      image_job_count_for_plan: 0;
      video_job_count_for_plan: 1;
      server_video_provider_submit_count: 1;
    };
  };
  task: {
    local_job_id: string;
    intent_id: string;
    plan_id: string;
    provider_id: "evolink-sora-2-preview";
    operation: "video";
    local_job_id_sha256: string;
    provider_task_id_sha256: string;
    request_sha256: string;
    source_sha256: string;
    upload_sha256: string;
    status_request_count: number;
    terminal_status: "completed";
  };
  media: {
    mime_type: "video/mp4";
    signature_hex: string;
    ftyp_present: true;
    sha256: string;
    bytes: number;
    duration_seconds: number;
    width: number;
    height: number;
    local_locator: string;
    indexeddb_blob_reverified: true;
  };
  lineage: {
    source_object_id: string;
    source_asset_id: string;
    source_version_id: string;
    result_object_id: string;
    result_asset_id: string;
    result_version_id: string;
    result_job_id: string;
    parent_object_preserved: true;
    parent_version_preserved: true;
  };
  bindings: {
    planner_job_sha256: string;
    source_sha256: string;
    result_sha256: string;
    run_sha256: string;
    route_proof_sha256: string;
    route_sha256: string;
    canvas_semantic_sha256: string;
    planner_job_binding: { intent_id: string; plan_id: string; job_id: string; route_operation: string; job_operation: string; provider_id: string };
    source_binding: { object_id: string; asset_id: string; version_id: string };
    result_binding: { object_id: string; asset_id: string; version_id: string; job_id: string; parent_object_id: string; parent_version_id: string };
    run_binding: { run_id: string; checkpoint_id: string; context_sha256: string; output_ids: string[] };
    route_binding: { planner_job_sha256: string; source_sha256: string; result_sha256: string; run_sha256: string; route_proof_sha256: string; request_sha256: string; mode: "video"; operation: "video_image_to_video" };
    send_authorization_raw_id_persisted: false;
    send_binding_reconstructed_from_persisted_ids: true;
  };
  agent_run: {
    run_id: string;
    checkpoint_id: string;
    context_sha256: string;
    state: "COMPLETED";
    output_ids: string[];
  };
  budget: { cap_usd: number; used_usd: number };
  receipt_sha256: string;
};

export type CaptureCore009LiveReceiptInput = {
  workspace: Workspace;
  run: PersistedAgentRunPresentation | undefined;
  blobStore: Pick<BlobStore, "get">;
  fetchImpl?: typeof fetch;
  nowIso?: string;
  navigationType?: string;
  pageOrigin?: string;
};

export const captureCore009LiveReceipt = async ({
  workspace,
  run,
  blobStore,
  fetchImpl = fetch,
  nowIso = new Date().toISOString(),
  navigationType = currentNavigationType(),
  pageOrigin = globalThis.location?.origin,
}: CaptureCore009LiveReceiptInput): Promise<Core009LiveReceipt> => {
  if (!isLoopbackOrigin(pageOrigin)) fail("CORE009_RECEIPT_NON_LOCAL_ORIGIN");
  const asset = [...workspace.assets]
    .filter((candidate) => candidate.kind === "video" && candidate.providerId === VIDEO_PROVIDER && candidate.storage?.mimeType === "video/mp4")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  requireRecord(asset, "CORE009_RECEIPT_VIDEO_ASSET_MISSING");
  requireId(asset.id, "CORE009_RECEIPT_ASSET_ID_INVALID");
  requireId(asset.jobId, "CORE009_RECEIPT_JOB_ID_INVALID");
  if (!asset.storage || asset.mimeType !== "video/mp4" || asset.storage.mimeType !== "video/mp4") fail("CORE009_RECEIPT_VIDEO_STORAGE_INVALID");

  const resultObject = workspace.nodes.find((node) => node.assetId === asset.id && node.jobId === asset.jobId && node.status === "ready");
  requireRecord(resultObject, "CORE009_RECEIPT_RESULT_OBJECT_MISSING");
  requireId(resultObject.id, "CORE009_RECEIPT_RESULT_OBJECT_ID_INVALID");
  requireId(resultObject.versionId, "CORE009_RECEIPT_RESULT_VERSION_ID_INVALID");
  requireId(resultObject.parentId, "CORE009_RECEIPT_PARENT_OBJECT_ID_INVALID");

  const resultVersion = workspace.versions.find((version) => version.id === resultObject.versionId && version.canvasObjectId === resultObject.id && version.jobId === asset.jobId);
  requireRecord(resultVersion, "CORE009_RECEIPT_RESULT_VERSION_MISSING");
  requireId(resultVersion.parentVersionId, "CORE009_RECEIPT_PARENT_VERSION_ID_INVALID");
  if (resultVersion.parentCanvasObjectId !== resultObject.parentId) fail("CORE009_RECEIPT_PARENT_OBJECT_MISMATCH");

  const sourceObject = workspace.nodes.find((node) => node.id === resultObject.parentId && node.status === "ready");
  requireRecord(sourceObject, "CORE009_RECEIPT_SOURCE_OBJECT_MISSING");
  requireId(sourceObject.assetId, "CORE009_RECEIPT_SOURCE_ASSET_ID_INVALID");
  requireId(sourceObject.versionId, "CORE009_RECEIPT_SOURCE_VERSION_ID_INVALID");
  if (sourceObject.versionId !== resultVersion.parentVersionId) fail("CORE009_RECEIPT_PARENT_VERSION_MISMATCH");
  if (!workspace.assets.some((candidate) => candidate.id === sourceObject.assetId)) fail("CORE009_RECEIPT_SOURCE_ASSET_MISSING");
  if (!workspace.versions.some((candidate) => candidate.id === sourceObject.versionId && candidate.canvasObjectId === sourceObject.id)) fail("CORE009_RECEIPT_SOURCE_VERSION_MISSING");

  const job = workspace.jobs.find((candidate) => candidate.id === asset.jobId && candidate.operation === "video" && candidate.status === "succeeded");
  requireRecord(job, "CORE009_RECEIPT_JOB_MISSING");
  if (job.targetCanvasObjectId !== sourceObject.id) fail("CORE009_RECEIPT_JOB_TARGET_MISMATCH");
  const plan = workspace.plans.find((candidate) => candidate.id === job.planId && candidate.intentId === job.intentId && candidate.operation === "video_image_to_video");
  requireRecord(plan, "CORE009_RECEIPT_PLAN_MISSING");
  const intent = workspace.intents.find((candidate) => candidate.id === job.intentId && candidate.operation === "video_image_to_video" && candidate.targetCanvasObjectId === sourceObject.id);
  requireRecord(intent, "CORE009_RECEIPT_INTENT_MISSING");
  if (intent.source !== "remote-agent" || plan.source !== "remote-agent" || plan.providerId !== VIDEO_PROVIDER || job.providerId !== VIDEO_PROVIDER) fail("CORE009_RECEIPT_REMOTE_ROUTE_INVALID");

  if (!run || run.state !== "COMPLETED" || run.creationMode !== "video" || run.budgetMilestone !== "CORE009") fail("CORE009_RECEIPT_COMPLETED_RUN_MISSING");
  requireId(run.runId, "CORE009_RECEIPT_RUN_ID_INVALID");
  requireId(run.checkpointId, "CORE009_RECEIPT_CHECKPOINT_ID_INVALID");
  requireSha(run.contextSha256, "CORE009_RECEIPT_CONTEXT_SHA_INVALID");
  const blob = await blobStore.get(asset.storage);
  if (!blob || blob.type !== "video/mp4" || blob.size !== asset.storage.bytes) fail("CORE009_RECEIPT_BLOB_INVALID");
  const blobSha256 = await sha256Blob(blob);
  if (blobSha256 !== asset.storage.sha256) fail("CORE009_RECEIPT_BLOB_SHA_MISMATCH");
  const signatureBytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (signatureBytes.length < 12 || ascii(signatureBytes.slice(4, 8)) !== "ftyp") fail("CORE009_RECEIPT_MP4_SIGNATURE_INVALID");

  const response = await fetchImpl("/api/agent/video-jobs/" + encodeURIComponent(job.id) + "/evidence", { headers: { Accept: "application/json" } });
  if (!response.ok) fail("CORE009_RECEIPT_SERVER_EVIDENCE_HTTP_" + response.status);
  const serverEvidence = await response.json() as ServerVideoEvidence;
  await validateServerEvidence(serverEvidence, { jobId: job.id, asset });

  const canvas = await buildCanvasContextGraphSnapshot(workspace, { currentPlan: plan });
  const routeProof = deriveRouteProof(workspace, { intentId: intent.id, planId: plan.id }, serverEvidence);
  const plannerJobBinding = { intent_id: intent.id, plan_id: plan.id, job_id: job.id, route_operation: plan.operation, job_operation: job.operation, provider_id: plan.providerId };
  const sourceBinding = { object_id: sourceObject.id, asset_id: sourceObject.assetId, version_id: sourceObject.versionId };
  const resultBinding = { object_id: resultObject.id, asset_id: asset.id, version_id: resultVersion.id, job_id: job.id, parent_object_id: sourceObject.id, parent_version_id: sourceObject.versionId };
  const runBinding = { run_id: run.runId, checkpoint_id: run.checkpointId, context_sha256: run.contextSha256, output_ids: [...run.outputIds].sort() };
  const bindingHashes = {
    planner_job_sha256: await sha256Json(plannerJobBinding),
    source_sha256: await sha256Json(sourceBinding),
    result_sha256: await sha256Json(resultBinding),
    run_sha256: await sha256Json(runBinding),
    route_proof_sha256: await sha256Json(routeProof),
  };
  const routeBinding = { ...bindingHashes, request_sha256: serverEvidence.requestSha256, mode: "video" as const, operation: "video_image_to_video" as const };

  const unsigned = {
    schema_version: 1 as const,
    milestone: "CORE-009-THREE-MODE-ROUTING-VIDEO-V1" as const,
    status: "PASS_REAL_SORA_LOCAL_RECEIPT" as const,
    captured_at: nowIso,
    capture_context: {
      navigation_type: navigationType,
      captured_after_reload: navigationType === "reload",
      localhost_only: true as const,
      localhost_origin: pageOrigin,
      provider_url_persisted: false as const,
      raw_provider_task_id_persisted: false as const,
      raw_prompt_persisted: false as const,
    },
    route: {
      mode: "video" as const,
      operation: "video_image_to_video" as const,
      planner_submissions: 1 as const,
      image_submissions: 0 as const,
      video_submissions: 1 as const,
      automatic_paid_resubmissions: 0 as const,
      provenance: {
        planner_submissions_derived_from_retained_remote_plan_and_single_submit_protocol: true as const,
        planner_network_request_receipt_persisted: false as const,
        image_submissions_derived_from_plan_scoped_jobs: true as const,
        video_submissions_derived_from_server_provider_submit_count: true as const,
        automatic_paid_resubmissions_derived_from_server_submit_count: true as const,
      },
      proof: routeProof,
    },
    task: {
      local_job_id: job.id,
      intent_id: intent.id,
      plan_id: plan.id,
      provider_id: "evolink-sora-2-preview" as const,
      operation: "video" as const,
      local_job_id_sha256: serverEvidence.clientJobIdSha256,
      provider_task_id_sha256: serverEvidence.providerTaskIdSha256,
      request_sha256: serverEvidence.requestSha256,
      source_sha256: serverEvidence.sourceSha256,
      upload_sha256: serverEvidence.uploadSha256,
      status_request_count: serverEvidence.statusRequestCount,
      terminal_status: "completed" as const,
    },
    media: {
      mime_type: "video/mp4" as const,
      signature_hex: toHex(signatureBytes),
      ftyp_present: true as const,
      sha256: blobSha256,
      bytes: blob.size,
      duration_seconds: asset.metadata.durationSeconds!,
      width: asset.metadata.width,
      height: asset.metadata.height,
      local_locator: asset.storage.locator,
      indexeddb_blob_reverified: true as const,
    },
    lineage: {
      source_object_id: sourceObject.id,
      source_asset_id: sourceObject.assetId,
      source_version_id: sourceObject.versionId,
      result_object_id: resultObject.id,
      result_asset_id: asset.id,
      result_version_id: resultVersion.id,
      result_job_id: job.id,
      parent_object_preserved: true as const,
      parent_version_preserved: true as const,
    },
    bindings: {
      ...bindingHashes,
      route_sha256: await sha256Json(routeBinding),
      canvas_semantic_sha256: canvas.semanticSha256,
      planner_job_binding: plannerJobBinding,
      source_binding: sourceBinding,
      result_binding: resultBinding,
      run_binding: runBinding,
      route_binding: routeBinding,
      send_authorization_raw_id_persisted: false as const,
      send_binding_reconstructed_from_persisted_ids: true as const,
    },
    agent_run: {
      run_id: run.runId,
      checkpoint_id: run.checkpointId,
      context_sha256: run.contextSha256,
      state: "COMPLETED" as const,
      output_ids: [...run.outputIds].sort(),
    },
    budget: { cap_usd: serverEvidence.budgetCapUsd, used_usd: serverEvidence.budgetUsedUsd },
  };
  return { ...unsigned, receipt_sha256: await sha256Json(unsigned) };
};

const deriveRouteProof = (workspace: Workspace, input: { intentId: string; planId: string }, evidence: ServerVideoEvidence) => {
  const matchingRemoteIntents = workspace.intents.filter((item) => item.id === input.intentId && item.source === "remote-agent" && item.operation === "video_image_to_video");
  const matchingRemotePlans = workspace.plans.filter((item) => item.id === input.planId && item.intentId === input.intentId && item.source === "remote-agent" && item.operation === "video_image_to_video" && item.providerId === VIDEO_PROVIDER);
  const scopedJobs = workspace.jobs.filter((item) => item.intentId === input.intentId && item.planId === input.planId);
  const imageJobs = scopedJobs.filter((item) => item.operation !== "video");
  const videoJobs = scopedJobs.filter((item) => item.operation === "video" && item.providerId === VIDEO_PROVIDER);
  if (matchingRemoteIntents.length !== 1 || matchingRemotePlans.length !== 1 || imageJobs.length !== 0 || videoJobs.length !== 1 || evidence.providerSubmitCount !== 1) fail("CORE009_RECEIPT_ROUTE_PROOF_INVALID");
  return {
    matching_remote_intent_count: 1 as const,
    matching_remote_plan_count: 1 as const,
    image_job_count_for_plan: 0 as const,
    video_job_count_for_plan: 1 as const,
    server_video_provider_submit_count: 1 as const,
  };
};

export const downloadCore009LiveReceipt = (receipt: Core009LiveReceipt, documentApi: Document = document, urlApi: typeof URL = URL) => {
  const bytes = new Blob([JSON.stringify(receipt, null, 2) + "\n"], { type: "application/json" });
  const url = urlApi.createObjectURL(bytes);
  const anchor = documentApi.createElement("a");
  anchor.href = url;
  anchor.download = "ELYRA-CORE-009-live-receipt-" + receipt.receipt_sha256.slice(0, 12) + ".json";
  anchor.hidden = true;
  documentApi.body.append(anchor);
  anchor.click();
  anchor.remove();
  queueMicrotask(() => urlApi.revokeObjectURL(url));
};

const validateServerEvidence = async (evidence: ServerVideoEvidence, input: { jobId: string; asset: Workspace["assets"][number] }) => {
  for (const digest of [evidence.clientJobIdSha256, evidence.requestSha256, evidence.sourceSha256, evidence.uploadSha256, evidence.providerTaskIdSha256, evidence.resultSha256]) {
    requireSha(digest, "CORE009_RECEIPT_SERVER_SHA_INVALID");
  }
  if (evidence.status !== "completed" || evidence.softCancelled || evidence.providerSubmitCount !== 1) fail("CORE009_RECEIPT_SERVER_STATUS_INVALID");
  const storage = input.asset.storage;
  if (!storage || evidence.resultSha256 !== storage.sha256 || evidence.resultBytes !== storage.bytes) fail("CORE009_RECEIPT_SERVER_MEDIA_MISMATCH");
  if (evidence.resultDurationSeconds !== input.asset.metadata.durationSeconds) fail("CORE009_RECEIPT_SERVER_DURATION_MISMATCH");
  if (evidence.resultDimensions?.[0] !== input.asset.metadata.width || evidence.resultDimensions?.[1] !== input.asset.metadata.height) fail("CORE009_RECEIPT_SERVER_DIMENSIONS_MISMATCH");
  if (await sha256Text(input.jobId) !== evidence.clientJobIdSha256) fail("CORE009_RECEIPT_JOB_HASH_MISMATCH");
};

const currentNavigationType = () => {
  const entry = globalThis.performance?.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
  return entry?.type ?? "unknown";
};
const isLoopbackOrigin = (value: unknown): value is string => typeof value === "string" && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(value);
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const stable = (value: unknown): unknown => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, item]) => [key, stable(item)]))
    : value;
const sha256Json = async (value: unknown) => {
  return sha256Text(JSON.stringify(stable(value)));
};
const sha256Text = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
};
function requireRecord<T>(value: T | undefined, code: string): asserts value is T {
  if (!value) fail(code);
}
function requireId(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !LOCAL_ID.test(value)) fail(code);
}
function requireSha(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
}
function fail(code: string): never {
  throw new Error(code);
}
