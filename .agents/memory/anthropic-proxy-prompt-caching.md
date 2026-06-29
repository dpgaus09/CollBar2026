---
name: Anthropic proxy supports prompt caching
description: The Replit-managed Anthropic proxy passes through cache_control breakpoints and returns cache usage; how the Ask engine uses it.
---

The Replit-managed Anthropic proxy (`@workspace/integrations-anthropic-ai`) DOES
support prompt caching. A `cache_control: { type: "ephemeral" }` breakpoint on a
`system` text block is accepted and the response `usage` returns real
`cache_creation_input_tokens` / `cache_read_input_tokens`.

**Verified:** a two-call probe with the same cached prefix returned
`cache_creation_input_tokens=6015, cache_read=0` on the first call and
`cache_creation=0, cache_read_input_tokens=6015` on the second — i.e. a true
cache write then read. (The integration skill's docs do NOT mention caching, so
this was previously assumed unverified — it works.)

**Why it matters:** the Ask engine resends the static system+tools prefix (~4.7k
tokens) on every model round-trip and on rapid repeat questions; cached reads are
~1/10th input price.

**How to apply (Ask engine, `ask-engine.ts`):**
- Cache order is `tools → system → messages`, so a single breakpoint on the
  `system` block caches the whole tools+system prefix.
- Only mark the breakpoint on tool-bearing turns. The forced final answer turn is
  system-only (~1.4k tokens), below the model's min cacheable size, so a
  breakpoint there is wasted — gate it on `withTools`.
- Keep a process-level "caching enabled" latch + a one-shot retry-without-cache
  on an HTTP 400, so a future proxy change that rejects `cache_control` degrades
  to plain requests instead of breaking the assistant. Snapshot the latch into a
  local before the call (don't re-read the global in the catch) or a concurrent
  request can wrongly skip its own retry; also guard the retry on
  `!streamStarted` so streamed tokens are never re-sent.
- `usage.cache_creation_input_tokens` / `cache_read_input_tokens` can be null →
  coalesce with `?? 0`. When caching is active, `usage.input_tokens` is only the
  UNcached portion; track the cache counts separately for true cost.
