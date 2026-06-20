---
name: Ask endpoint SSE streaming
description: Why /api/dashboard/ask streams via SSE with a "reset" event, and the proxy/compression constraints that make it work.
---

# /api/dashboard/ask SSE streaming

The authenticated Ask endpoint streams the model answer as Server-Sent Events
(POST response, `data: <json>\n\n` frames). Event types: `token` (text delta),
`reset` (discard what was streamed this turn), `results` (cumulative result
cards), `done`, `error`.

## The `reset` event exists because of a model quirk
claude-haiku-4-5 still emits a prose preamble (e.g. "I'll search for…") *before*
its `tool_use` blocks, even when the system prompt explicitly says not to. You
cannot know in advance whether a turn's early text is preamble or the real
answer, so you must forward text deltas live and then, once a turn resolves to
`tool_use`, send a `reset` so the client clears that preamble. Do NOT "simplify"
by deleting the reset path — the preamble will leak into the UI.

**Why:** the no-preamble system-prompt rule is unreliable; reset is the safety net.
**How to apply:** any change to the streaming loop must keep: forward `token`
deltas live → on `tool_use` send `reset` before running tools → send cumulative
`results` after tools → stream the final answer → `results` + `done`.

## Pre-stream vs mid-stream failures
Auth (401) and rate-limit (429) run as middleware before the handler; question
validation (empty / >1000 chars → 400) replies as JSON. SSE headers flush lazily
on the first `send()`, so a failure of the very first model call still returns a
clean JSON 502; a failure after headers are sent emits an `error` SSE event.

## Client disconnect
`req.on("close")` sets a `clientGone` flag AND aborts an `AbortController` whose
signal is passed to `anthropic.messages.stream(body, { signal })`. Without the
signal the model request keeps running (and billing) after the client leaves.
On abort the catch block returns early (clientGone) so it never writes to the
dead socket. The browser client treats a stream that ends without a `done` event
as a failure (rolls back), not a truncated success.

## Proxy / compression constraints
SSE works end-to-end through both the Vite dev proxy and the Replit preview
proxy as long as there is NO compression middleware in app.ts. Response headers
set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` to keep
intermediaries from buffering. Adding compression later would break live
streaming (it buffers), so gate any such addition to skip text/event-stream.
