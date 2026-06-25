// Thin wrapper around the Anthropic messages API for image+text (vision) calls.
//
// Uses the pre-configured Replit AI-integration client (no API key handling).
// Retries on rate-limit / 5xx with exponential backoff, surfaces token usage
// and the resolved model id (for the cache's model_version), and reports
// truncation (stop_reason === "max_tokens") so callers can fail closed instead
// of trusting a clipped JSON response.

import type Anthropic from "@anthropic-ai/sdk";
import {
  anthropic,
  isRateLimitError,
} from "@workspace/integrations-anthropic-ai";
import { logger } from "../../lib/logger";

export type VisionBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: "image/png"; data: string };
    };

export interface VisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface VisionResult {
  text: string;
  // Resolved model id from the response (e.g. claude-haiku-4-5-YYYYMMDD); used
  // as the cache's model_version.
  model: string;
  stopReason: string | null;
  // True when stop_reason === "max_tokens": the JSON is partial — discard it.
  truncated: boolean;
  usage: VisionUsage;
}

export const DEFAULT_MODEL = "claude-haiku-4-5";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function callVision(opts: {
  blocks: VisionBlock[];
  maxTokens: number;
  model?: string;
  retries?: number;
}): Promise<VisionResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const retries = opts.retries ?? 4;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await anthropic.messages.create({
        model,
        max_tokens: opts.maxTokens,
        messages: [
          {
            role: "user",
            content: opts.blocks as Anthropic.Messages.ContentBlockParam[],
          },
        ],
      });
      const block = resp.content[0];
      const text = block && block.type === "text" ? block.text : "";
      return {
        text,
        model: resp.model ?? model,
        stopReason: resp.stop_reason ?? null,
        truncated: resp.stop_reason === "max_tokens",
        usage: {
          inputTokens: resp.usage?.input_tokens ?? 0,
          outputTokens: resp.usage?.output_tokens ?? 0,
        },
      };
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number } | null)?.status;
      const retryable =
        isRateLimitError(err) || (typeof status === "number" && status >= 500);
      if (!retryable || attempt === retries) break;
      const backoff = Math.min(30_000, 1_000 * 2 ** attempt) + Math.random() * 250;
      logger.warn(
        { err, attempt, backoff },
        "vision call failed; retrying with backoff",
      );
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
