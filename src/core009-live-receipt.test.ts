import { describe, expect, it } from "vitest";
import { captureCore009LiveReceipt } from "./core009-live-receipt";
import { createBlobLocator, sha256Blob } from "./blob-store";
import { createBlankWorkspace, GENERATED_ASSET, PROJECT_ID, type Workspace } from "./domain";
import type { PersistedAgentRunPresentation } from "./agent-run-persistence";

const at = "2026-08-11T00:00:00.000Z";
const ids = {
  intent: "intent-video",
  plan: "plan-video",
  job: "job-video",
  sourceObject: "object-source",
  sourceAsset: "asset-source",
  sourceVersion: "version-source",
  resultObject: "object-result",
  resultAsset: "asset-result",
  resultVersion: "version-result",
  run: "agent-run-video",
  checkpoint: "checkpoint-video",
};

describe("CORE-009 live receipt", () => {
  it("cross-checks the localhost receipt, IndexedDB Blob metadata and non-destructive lineage", async () => {
    const fixture = await makeFixture();
    const receipt = await captureCore009LiveReceipt({
      workspace: fixture.workspace,
      run: fixture.run,
      blobStore: { get: async () => fixture.video },
      fetchImpl: async () => new Response(JSON.stringify(fixture.serverEvidence), { status: 200, headers: { "Content-Type": "application/json" } }),
      nowIso: at,
      navigationType: "reload",
      pageOrigin: "http://127.0.0.1:4175",
    });

    expect(receipt).toMatchObject({
      status: "PASS_REAL_SORA_LOCAL_RECEIPT",
      capture_context: { captured_after_reload: true, localhost_only: true },
      route: { planner_submissions: 1, image_submissions: 0, video_submissions: 1 },
      media: {
        signature_hex: expect.stringMatching(/^0000002066747970/),
        sha256: fixture.videoSha256,
        bytes: fixture.video.size,
        local_locator: fixture.locator,
        indexeddb_blob_reverified: true,
      },
      lineage: {
        source_object_id: ids.sourceObject,
        result_object_id: ids.resultObject,
        source_version_id: ids.sourceVersion,
        result_version_id: ids.resultVersion,
        parent_object_preserved: true,
        parent_version_preserved: true,
      },
      task: { local_job_id_sha256: fixture.serverEvidence.clientJobIdSha256, provider_task_id_sha256: "e".repeat(64) },
    });
    expect(receipt.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(receipt);
    for (const forbidden of ["https://provider", "Authorization", "RAW_PROMPT", "task-unified-"]) expect(serialized).not.toContain(forbidden);
  });

  it("fails closed when the server result digest differs from the local Blob", async () => {
    const fixture = await makeFixture();
    await expect(captureCore009LiveReceipt({
      workspace: fixture.workspace,
      run: fixture.run,
      blobStore: { get: async () => fixture.video },
      fetchImpl: async () => new Response(JSON.stringify({ ...fixture.serverEvidence, resultSha256: "f".repeat(64) }), { status: 200 }),
      navigationType: "reload",
      pageOrigin: "http://127.0.0.1:4175",
    })).rejects.toThrow("CORE009_RECEIPT_SERVER_MEDIA_MISMATCH");
  });

  it("fails closed when the same plan contains both image and video media jobs", async () => {
    const fixture = await makeFixture();
    fixture.workspace.jobs.push({
      ...fixture.workspace.jobs[0],
      id: "job-image-conflict",
      providerId: "evolink-gpt-image-2",
      operation: "generate",
    });
    await expect(captureCore009LiveReceipt({
      workspace: fixture.workspace,
      run: fixture.run,
      blobStore: { get: async () => fixture.video },
      fetchImpl: async () => new Response(JSON.stringify(fixture.serverEvidence), { status: 200 }),
      navigationType: "reload",
      pageOrigin: "http://127.0.0.1:4175",
    })).rejects.toThrow("CORE009_RECEIPT_ROUTE_PROOF_INVALID");
  });

  it("fails closed outside a loopback page origin", async () => {
    const fixture = await makeFixture();
    await expect(captureCore009LiveReceipt({
      workspace: fixture.workspace,
      run: fixture.run,
      blobStore: { get: async () => fixture.video },
      fetchImpl: async () => new Response(JSON.stringify(fixture.serverEvidence), { status: 200 }),
      navigationType: "navigate",
      pageOrigin: "https://example.invalid",
    })).rejects.toThrow("CORE009_RECEIPT_NON_LOCAL_ORIGIN");
  });
});

const makeFixture = async () => {
  const video = mp4Fixture();
  const videoSha256 = await sha256Blob(video);
  const locator = createBlobLocator(PROJECT_ID, "blob-video");
  const workspace = createBlankWorkspace();
  Object.assign(workspace, fixtureWorkspace(videoSha256, video.size, locator));
  const run: PersistedAgentRunPresentation = {
    schemaVersion: 1,
    runId: ids.run,
    state: "COMPLETED",
    creationMode: "video",
    budgetMilestone: "CORE009",
    contextSha256: "a".repeat(64),
    selectedObjectIds: [ids.resultObject],
    referencedObjectIds: [ids.sourceObject, ids.resultObject],
    objectCount: 2,
    stepIndex: 2,
    currentActionType: "finish",
    verificationOutcome: "COMPLETE",
    verificationSummary: "complete",
    remainingSteps: 2,
    maxSteps: 4,
    paused: false,
    budget: { capUsd: 5, spentUsd: 4.0148437, reservedUsd: 0 },
    outputIds: [],
    stopReason: "FINISHED",
    checkpointId: ids.checkpoint,
    updatedAt: at,
  };
  const serverEvidence = {
    clientJobIdSha256: await sha256Text(ids.job),
    requestSha256: "b".repeat(64),
    sourceSha256: "c".repeat(64),
    uploadSha256: "d".repeat(64),
    providerTaskIdSha256: "e".repeat(64),
    providerSubmitCount: 1,
    statusRequestCount: 7,
    status: "completed",
    resultSha256: videoSha256,
    resultBytes: video.size,
    resultDurationSeconds: 4.1,
    resultDimensions: [1280, 720] as [number, number],
    budgetCapUsd: 5,
    budgetUsedUsd: 4.0148437,
    softCancelled: false,
  };
  return { workspace, run, serverEvidence, video, videoSha256, locator };
};

const fixtureWorkspace = (sha256: string, bytes: number, locator: string): Partial<Workspace> => ({
  creationMode: "video",
  nodes: [
    { id: ids.sourceObject, kind: "generated", name: "source", x: 0, y: 0, width: 512, height: 512, status: "ready", version: 1, prompt: "", createdAt: at, assetId: ids.sourceAsset, versionId: ids.sourceVersion },
    { id: ids.resultObject, kind: "generated", name: "result", x: 600, y: 0, width: 512, height: 288, status: "ready", parentId: ids.sourceObject, version: 2, prompt: "", createdAt: at, assetId: ids.resultAsset, jobId: ids.job, versionId: ids.resultVersion },
  ],
  selectedIds: [ids.resultObject],
  intents: [{ id: ids.intent, kind: "modify", operation: "video_image_to_video", source: "remote-agent", creationMode: "video", prompt: "", normalizedPrompt: "", goal: "", constraints: [], targetCanvasObjectId: ids.sourceObject, createdAt: at }],
  plans: [{ id: ids.plan, intentId: ids.intent, providerId: "evolink-sora-2-preview", status: "approved", operation: "video_image_to_video", source: "remote-agent", creationMode: "video", outputKind: "video", summary: "", bullets: [], constraints: [], visualDirection: { subject: "", style: "", lighting: "", composition: "" }, shouldFail: false, createdAt: at }],
  jobs: [{ id: ids.job, intentId: ids.intent, planId: ids.plan, providerId: "evolink-sora-2-preview", operation: "video", targetCanvasObjectId: ids.sourceObject, status: "succeeded", attempt: 1, createdAt: at, updatedAt: at }],
  assets: [
    { id: ids.sourceAsset, kind: "image", source: "remote-provider", providerId: "evolink-gpt-image-2", uri: GENERATED_ASSET, mimeType: "image/png", prompt: "", createdAt: at, metadata: { deterministic: false, width: 512, height: 512 } },
    { id: ids.resultAsset, kind: "video", source: "remote-provider", providerId: "evolink-sora-2-preview", jobId: ids.job, mimeType: "video/mp4", prompt: "", createdAt: at, metadata: { deterministic: false, width: 1280, height: 720, durationSeconds: 4.1 }, storage: { locator: locator as any, projectId: PROJECT_ID, blobKey: "blob-video", sha256, bytes, mimeType: "video/mp4", createdAt: at } },
  ],
  versions: [
    { id: ids.sourceVersion, canvasObjectId: ids.sourceObject, sequence: 1, status: "ready", createdAt: at },
    { id: ids.resultVersion, canvasObjectId: ids.resultObject, parentVersionId: ids.sourceVersion, parentCanvasObjectId: ids.sourceObject, jobId: ids.job, sequence: 2, status: "ready", createdAt: at },
  ],
});

const mp4Fixture = () => new Blob([
  new Uint8Array([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
  ]),
], { type: "video/mp4" });

const sha256Text = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
