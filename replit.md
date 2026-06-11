# CollBar

K-12 collective bargaining settlement database and district dashboard — Ohio scope for v1, schema multi-state ready.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the Express API server
- `pnpm --filter @workspace/collbar-web run dev` — run the CollBar web frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — typecheck shared libs only
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes to dev database (run after schema changes)
- `python3 pipeline/seed_test.py` — insert and delete 3 TEST_ districts, print acceptance row-count table
- Required env secret: `DATABASE_URL` — already provisioned via Replit managed PostgreSQL

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Web frontend: React 19 + Vite (artifacts/collbar-web), Tailwind CSS, Wouter, TanStack Query
- API: Express 5 (artifacts/api-server)
- DB: PostgreSQL + Drizzle ORM (`@workspace/db`)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from `lib/api-spec/openapi.yaml`)
- Pipeline: Python 3 scripts in `/pipeline` (psycopg, requests, BeautifulSoup, pdfplumber)
- LLM extraction: Anthropic API (Phase 3)

## Where things live

- `lib/db/src/schema/` — Drizzle table definitions (source of truth for DB schema)
  - `districts.ts`, `source_documents.ts`, `contracts.ts`, `contract_provisions.ts`
  - `settlements.ts`, `factfinding_proposals.ts`, `extraction_runs.ts`, `users.ts`
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for API contracts)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/collbar-web/src/` — React frontend (pages, components)
- `pipeline/` — Python data acquisition and extraction scripts
- `pipeline/seed_test.py` — Phase 1 acceptance test seed script

## Architecture decisions

- React+Vite used instead of Next.js 14+: The pnpm monorepo is scaffolded for Vite frontends with a separate Express API server. Switching to Next.js would require restructuring the entire monorepo; the Vite+Express split provides the same capabilities for this project's needs.
- Multi-state schema: `districts.state` column + `UNIQUE(state, state_district_id)` constraint; v1 UI is Ohio-only but the schema accepts any 2-char state code.
- Provenance model: every extracted value traces to `source_doc_id` → `source_documents` → `source_url`, `file_hash`, `retrieved_at`. PDF blobs live in object storage; only metadata+keys in Postgres.
- LLM extraction confidence: values with `confidence < 0.8` are flagged in `contract_provisions.human_verified = false` and surfaced in admin review queue (Phase 4).
- Secrets in Replit only: `DATABASE_URL`, `ANTHROPIC_API_KEY` etc. are never in code or logs.

## Product

CollBar lets school business officials (CFOs/treasurers) see their entire labor landscape in one screen: contract terms, salary benchmarks, comparable-district settlements, and fact-finding history. Admin users can view any district and see the full data pipeline status.

## User preferences

- Build strictly one phase at a time; stop for human review at the end of each phase
- Never fabricate or placeholder real-looking data; surface errors explicitly
- Scrape politely: max 1 req/2s, User-Agent `CollBarBot/1.0 (hello@collbar.com)`
- Print acceptance summary table (row counts) at end of each phase

## Gotchas

- Always run `pnpm --filter @workspace/db run push` after any schema change in `lib/db/src/schema/`
- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml`
- `drizzle-kit push-force` available if push fails with column conflicts
- `psycopg` (not `psycopg2`) is the Python Postgres client for pipeline scripts
- The `pipeline/` directory contains Python scripts — run them with `python3`, not `node`
- Scraper crawl state files live in `pipeline/crawl_state/` (created in Phase 2)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Spec source: `attached_assets/CollBar_Ohio_v1_Replit_Spec_*.docx`
