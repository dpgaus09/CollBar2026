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
  deriveStatedSettlements: vi.fn(),
  extractFinalOffer: vi.fn(),
  findPostingSide: vi.fn(),
  extractContractMeta: vi.fn(),
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
vi.mock("../domains/settlements", () => ({
  deriveStatedSettlements: h.deriveStatedSettlements,
  SETTLEMENT_DERIVE_VERSION: "settlement-test",
}));
vi.mock("../domains/final-offers", () => ({
  extractFinalOffer: h.extractFinalOffer,
  FINAL_OFFER_PROMPT_VERSION: "final-offer-test",
}));
vi.mock("../domains/final-offers-store", () => ({
  findPostingSide: h.findPostingSide,
}));
vi.mock("../domains/contract-meta", () => ({
  extractContractMeta: h.extractContractMeta,
  CONTRACT_META_PROMPT_VERSION: "contract-meta-test",
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

function contractMetaOk() {
  return {
    ok: true,
    status: "success",
    meta: {
      unionName: "Test EA",
      affiliation: "IEA-NEA",
      effectiveStart: "2022-07-01",
      effectiveEnd: "2025-06-30",
      termYears: 3,
    },
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelVersion: "claude-test",
    pageCount: 1,
    pagesExtracted: [1],
    fromCache: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.loadSourceDoc.mockResolvedValue({ id: "42", fileHash: "a".repeat(64) });
  h.resolvePdfBuffer.mockResolvedValue(Buffer.from("%PDF-1.4 test"));
  h.createVersion.mockResolvedValue({ version: { id: "V2" }, duplicate: false });
  h.promoteVersion.mockResolvedValue({ ok: true, targets: 1 });
  h.extractContractMeta.mockResolvedValue(contractMetaOk());
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

describe("processJob — settlement domain (derive, no PDF/vision)", () => {
  it("derives stated settlements and auto-promotes on first run", async () => {
    h.deriveStatedSettlements.mockResolvedValue({
      settlements: [{ districtId: "7", bargainingUnit: "teachers" }],
      skipped: {},
      flaggedOutOfRange: [],
    });
    h.getPromotedVersionId.mockResolvedValue(null);
    await processJob(job({ domain: "settlement" }));
    // settlements need NO PDF — the worker must not resolve PDF bytes for them.
    expect(h.resolvePdfBuffer).not.toHaveBeenCalled();
    expect(h.deriveStatedSettlements).toHaveBeenCalledTimes(1);
    expect(h.createVersion).toHaveBeenCalledTimes(1);
    expect(h.createVersion.mock.calls[0][0]).toMatchObject({ domain: "settlement" });
    expect(h.promoteVersion).toHaveBeenCalledTimes(1);
    expect(h.markJobDone).toHaveBeenCalledTimes(1);
  });
});

describe("processJob — final_offer domain", () => {
  it("resolves posting+side, extracts, versions and auto-promotes on first run", async () => {
    h.findPostingSide.mockResolvedValue({
      postingId: "9",
      caseNumber: "S-MA-2024-001",
      side: "district",
    });
    h.extractFinalOffer.mockResolvedValue({
      ok: true,
      status: "success",
      items: [{ topic: "salary" }],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      modelVersion: "claude-test",
      pageCount: 1,
      pagesExtracted: 1,
      fromCache: false,
    });
    h.getPromotedVersionId.mockResolvedValue(null);
    await processJob(job({ domain: "final_offer" }));
    expect(h.findPostingSide).toHaveBeenCalledTimes(1);
    expect(h.extractFinalOffer).toHaveBeenCalledTimes(1);
    expect(h.createVersion).toHaveBeenCalledTimes(1);
    expect(h.createVersion.mock.calls[0][0]).toMatchObject({ domain: "final_offer" });
    expect(h.promoteVersion).toHaveBeenCalledTimes(1);
    expect(h.markJobDone).toHaveBeenCalledTimes(1);
  });

  it("fails closed (no version) when the doc is wired to no posting", async () => {
    h.findPostingSide.mockResolvedValue(null);
    await processJob(job({ domain: "final_offer" }));
    expect(h.extractFinalOffer).not.toHaveBeenCalled();
    expect(h.createVersion).not.toHaveBeenCalled();
    expect(h.promoteVersion).not.toHaveBeenCalled();
    expect(h.markJobFailed).toHaveBeenCalledTimes(1);
  });
});

describe("processJob — cba expands to all three domains", () => {
  it("runs salary, provisions, and contract_meta for a 'cba' job", async () => {
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
    h.extractContractMeta.mockResolvedValue(contractMetaOk());
    h.getPromotedVersionId.mockResolvedValue(null);
    await processJob(job({ domain: "cba" }));
    expect(h.extractSalarySchedules).toHaveBeenCalledTimes(1);
    expect(h.extractProvisions).toHaveBeenCalledTimes(1);
    expect(h.extractContractMeta).toHaveBeenCalledTimes(1);
    expect(h.createVersion).toHaveBeenCalledTimes(3);
    expect(h.markJobDone).toHaveBeenCalledTimes(1);
  });
});
