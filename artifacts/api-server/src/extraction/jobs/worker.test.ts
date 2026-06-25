import { describe, it, expect, beforeEach, vi } from "vitest";

// The worker must be FAIL-CLOSED (a failed extraction records no version and
// never promotes) and AUTO-PROMOTE ONLY ON FIRST extraction (re-runs require a
// manual promote). Mock every collaborator so we assert exactly those rules.
const h = vi.hoisted(() => ({
  loadSourceDoc: vi.fn(),
  resolvePdfBuffer: vi.fn(),
  extractSalarySchedules: vi.fn(),
  extractProvisions: vi.fn(),
  verifyProvisionsAgainstText: vi.fn(),
  openPdf: vi.fn(),
  createVersion: vi.fn(),
  promoteVersion: vi.fn(),
  getPromotedVersionId: vi.fn(),
  markJobDone: vi.fn(),
  markJobFailed: vi.fn(),
  claimNextJob: vi.fn(),
  recoverStaleJobs: vi.fn(),
}));

vi.mock("../source-docs", () => ({
  loadSourceDoc: h.loadSourceDoc,
  resolvePdfBuffer: h.resolvePdfBuffer,
}));
vi.mock("../domains/salary", () => ({
  extractSalarySchedules: h.extractSalarySchedules,
  SALARY_PROMPT_VERSION: "salary-test",
}));
vi.mock("../domains/provisions", () => ({
  extractProvisions: h.extractProvisions,
  PROVISIONS_PROMPT_VERSION: "provisions-test",
}));
vi.mock("../domains/provisions-verify", () => ({
  verifyProvisionsAgainstText: h.verifyProvisionsAgainstText,
}));
vi.mock("../pdf/renderer", () => ({
  openPdf: h.openPdf,
  RENDER_VERSION: "render-test",
}));
vi.mock("./versions", () => ({
  createVersion: h.createVersion,
  promoteVersion: h.promoteVersion,
  getPromotedVersionId: h.getPromotedVersionId,
}));
vi.mock("./queue", () => ({
  markJobDone: h.markJobDone,
  markJobFailed: h.markJobFailed,
  claimNextJob: h.claimNextJob,
  recoverStaleJobs: h.recoverStaleJobs,
}));

import { processJob } from "./worker";

function salaryOk() {
  return {
    ok: true,
    status: "success",
    schedules: [{ cells: [{}], confidence: 0.9, needsReview: false }],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelVersion: "claude-test",
    pageCount: 1,
    pagesExtracted: [1],
    fromCache: false,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    sourceDocId: "42",
    domain: "salary",
    status: "running",
    priority: 100,
    attempts: 1,
    maxAttempts: 1,
    model: null,
    requestedBy: "admin",
    requestReason: "test",
    error: null,
    result: null,
    leasedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as Parameters<typeof processJob>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.loadSourceDoc.mockResolvedValue({ id: "42", fileHash: "a".repeat(64) });
  h.resolvePdfBuffer.mockResolvedValue(Buffer.from("%PDF-1.4 test"));
  h.createVersion.mockResolvedValue({ version: { id: "V2" }, duplicate: false });
  h.promoteVersion.mockResolvedValue({ ok: true, targets: 1 });
});

describe("processJob — fail-closed", () => {
  it("records NO version and does NOT promote when extraction fails", async () => {
    h.extractSalarySchedules.mockResolvedValue({ ok: false, status: "truncated", schedules: [] });
    await processJob(job());
    expect(h.createVersion).not.toHaveBeenCalled();
    expect(h.promoteVersion).not.toHaveBeenCalled();
    expect(h.markJobDone).not.toHaveBeenCalled();
    expect(h.markJobFailed).toHaveBeenCalledTimes(1);
  });
});

describe("processJob — auto-promote only on first extraction", () => {
  it("creates a version AND auto-promotes when no promotion pointer exists yet", async () => {
    h.extractSalarySchedules.mockResolvedValue(salaryOk());
    h.getPromotedVersionId.mockResolvedValue(null);
    await processJob(job());
    expect(h.createVersion).toHaveBeenCalledTimes(1);
    expect(h.promoteVersion).toHaveBeenCalledTimes(1);
    expect(h.promoteVersion).toHaveBeenCalledWith("V2", { promotedBy: "auto" });
    expect(h.markJobDone).toHaveBeenCalledTimes(1);
  });

  it("creates a version but does NOT auto-promote when a pointer already exists", async () => {
    h.extractSalarySchedules.mockResolvedValue(salaryOk());
    h.getPromotedVersionId.mockResolvedValue("V1");
    await processJob(job());
    expect(h.createVersion).toHaveBeenCalledTimes(1);
    expect(h.promoteVersion).not.toHaveBeenCalled();
    expect(h.markJobDone).toHaveBeenCalledTimes(1);
  });
});

describe("processJob — cba expands to both domains", () => {
  it("runs salary and provisions for a 'cba' job", async () => {
    h.extractSalarySchedules.mockResolvedValue(salaryOk());
    h.extractProvisions.mockResolvedValue({
      ok: true,
      status: "success",
      contracts: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      modelVersion: "claude-test",
      pageCount: 1,
      pagesExtracted: [1],
      fromCache: false,
    });
    h.getPromotedVersionId.mockResolvedValue(null);
    await processJob(job({ domain: "cba" }));
    expect(h.extractSalarySchedules).toHaveBeenCalledTimes(1);
    expect(h.extractProvisions).toHaveBeenCalledTimes(1);
    expect(h.createVersion).toHaveBeenCalledTimes(2);
    expect(h.markJobDone).toHaveBeenCalledTimes(1);
  });
});
