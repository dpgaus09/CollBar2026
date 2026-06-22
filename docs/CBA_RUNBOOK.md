# CollBar — CBA Update & Promotion Runbook

**Audience:** CollBar staff who add and verify collective-bargaining agreements (CBAs) and push them live.
**What this covers:** (1) how to add & vet CBAs in **Development**, and (2) how to promote vetted data to **Production**.

---

## 0. The big picture (read this first)

CollBar runs in **two completely separate environments**, each with its own database:

| | Development ("dev") | Production ("prod") |
|---|---|---|
| What it's for | A safe workspace to add, fix, and verify CBA data | The live site customers use |
| URL | The development app (Replit workspace preview) → `/admin` | `https://app.collbar.com` → `/admin` |
| Who edits it | Curators, every day | **Nobody edits it directly** |

**The golden rule:**
> Always curate data in **Development** first. Production is only ever changed by running the **promotion** step described in Part B. Never hand-edit production.

**Why:** the promotion step takes a backup, previews every change before it happens, and is safe to re-run. Hand-editing prod has none of those safety nets.

**Three things promotion will NEVER touch in production:** customer accounts, logins, and saved conversations. Promotion only moves CBA *reference data* (districts, documents, contracts, provisions, settlements, final offers, minimum-salary records).

---

## Part A — Add & vet CBAs in Development

All day-to-day curation happens in the **Admin Dashboard**: open the development app and go to **`/admin`**. Log in with the admin password.

The dashboard has these tabs:

| Tab | What you use it for |
|---|---|
| **Overview** | Health check + live row counts for every table. Your "is everything OK?" screen. |
| **Crawl Report** | See which districts we've found CBAs for, and kick off the automatic web crawler. |
| **Extraction** | Turn downloaded PDFs into structured data; see failures and retry them. |
| **Upload CBA** | Manually add a single CBA PDF you already have. |
| **Review Queue** | Verify and correct the numbers the system pulled out of each contract. |
| **Alerts** | Data-quality warnings that need a human to look. |
| **EIS Cross-Check** | Compare our contract data against the State (ISBE) directory to catch mismatches. |
| **Customers** | Manage customer logins (not part of CBA curation). |

The normal flow is: **get the PDF in → extract it → verify it → clean up flags.** Here's each step.

### Step 1 — Get the CBA PDF into the system

You have two ways:

**A) Let the crawler find it (bulk, automatic)**
1. Go to **Crawl Report**.
2. Use the district log to see which districts are `found`, `failed`, or `search failed`.
3. Click **Start IL Crawl** to run the automatic crawler. It visits district websites, finds CBA PDFs, verifies they're real PDFs, and files them under document type `cba_pdf`.
4. The status indicator shows when it's still running. Let it finish.

**B) Upload one PDF yourself (manual)**
Use this when you already have the file, or the crawler couldn't find it.
1. Go to **Upload CBA**.
2. Pick the **district**, the **bargaining unit** (Teachers, Paraprofessionals, etc.), and the **school year**.
3. Choose the PDF file and submit (max 64 MB).
4. The system saves it and **automatically starts extraction** on that one document. If the exact file is already on file, it'll tell you instead of duplicating it.

### Step 2 — Extraction (PDF → structured data)

Extraction reads the PDF text (using OCR for scanned documents) and uses AI to pull out the contract terms into the database (`contracts` and `contract_provisions`).

- After a **manual upload**, this runs automatically for that document.
- For everything the **crawler** brought in, go to the **Extraction** tab and run extraction to process the new pending documents.
- The **Extraction** tab also shows failures (e.g. a corrupt PDF) with a reason, and lets you **retry** a specific document after it's fixed.

### Step 3 — Review & verify the data (most important step)

Go to the **Review Queue**. This is where a human confirms the AI got it right.

The queue surfaces the items most likely to need attention:
- provisions the AI was **not confident** about, and
- a **random sample** of confident ones (a spot-check for quality).

For each item:
1. Compare the extracted value/text against the actual PDF.
2. **Correct** the number or excerpt if it's wrong.
3. Mark it **verified** (agree) or flag a problem (disagree).

Verifying sets the `human_verified` flag on that provision so we know a person has signed off on it.

### Step 4 — Cross-checks & cleanup

- **EIS Cross-Check** — compares our contract figures to the State directory. Investigate anything that doesn't line up.
- **Alerts** — work through any data-quality warnings shown here.
- **Overview** — sanity-check the row counts look reasonable before you promote.

### Understanding the data-quality flags

| Flag | Meaning |
|---|---|
| **OCR quality** | For scanned PDFs, how confident the text-reading was (0–100). Anything **below 70** is treated as low quality and flagged for review. |
| **doc_type** | What a document actually is: `cba_pdf` (a real contract), `non_cba` (not a contract — e.g. an agenda), `policy_manual`, `final_offer`. Mislabeled files get re-typed during audits so they don't pollute the data. |
| **human_verified** | `true` once a curator approves a provision in the Review Queue. |

### Advanced: command-line pipeline (engineers only)

Curators can do everything above from the dashboard. Engineers with workspace shell access can also run the underlying scripts directly from the `pipeline/` folder, e.g.:

```bash
cd pipeline
python3 11_crawl_il_cbas.py --search-fallback     # discover/crawl IL CBAs
python3 06_extract_contracts.py --state IL        # extract pending IL documents
python3 14_audit_stored_cbas.py --fast            # audit stored docs for mislabeled files
```

These are the same actions the dashboard buttons trigger. The numbered prefixes indicate the pipeline order.

---

## Part B — Promote vetted data to Production

When the data in Development looks good, you promote it to the live site. Promotion is run from the **workspace shell** (the `pipeline/` folder), not from the website. It's a deliberate two-command process: **preview first, then apply.**

### What promotion does (and its safety guarantees)

- Copies the vetted CBA reference data from **dev → prod**.
- **Takes a backup** of every production row it's about to change (for rollback).
- Matches records by their real-world identity (district + unit + year, etc.), so **re-running is safe** — it only adds or updates what's actually different.
- **Never** touches customer accounts, logins, or conversations.

### Pre-flight checklist

- [ ] You've verified the new data in Development (Part A).
- [ ] The **Overview** counts in dev look right.
- [ ] You're in the workspace shell, in the `pipeline/` folder.

### Step 1 — Preview the changes (dry-run, writes nothing)

```bash
cd pipeline
python3 21_promote_to_prod.py --base https://app.collbar.com
```

This exports the current dev data, sends it to production in **preview mode**, and prints a per-table summary of what *would* change — how many rows would be **inserted**, **updated**, **skipped**, plus any **warnings**. Nothing is written to production yet.

### Step 2 — Review the preview

Look at the printed counts:
- Numbers that match what you added in dev → good.
- A surprisingly large diff, or any **warnings/skips** → stop and investigate before applying.

### Step 3 — Apply for real

When the preview looks right, run the same command with `--apply`:

```bash
python3 21_promote_to_prod.py --base https://app.collbar.com --apply
```

This takes a backup, then applies all changes in a single all-or-nothing transaction (if anything fails, nothing is committed). It records the run in production's promotion history.

### Step 4 — Verify it's live

1. Open `https://app.collbar.com/admin` → **Overview** and confirm the row counts went up as expected.
2. Spot-check a district/contract you just promoted on the live site.

### What gets promoted vs. left alone

| Promoted (CBA reference data) | Never touched | Skipped (rebuilt automatically) |
|---|---|---|
| districts, source documents, contracts, contract provisions, settlements, final-offer postings/items/comparisons, minimum-teacher-salary | users, customer accounts, conversations, messages | caches, alerts, staging/log tables |

### Re-running is safe

If you add more data later, just run the same two commands again. Promotion only moves the *new* differences; already-promoted records are left as-is.

---

## Troubleshooting

| Symptom | What it means / what to do |
|---|---|
| Promotion fails with **404 (not found)** | The production app doesn't have the promotion endpoint yet. **Republish/redeploy** the app once, then re-run. (Only needed when the promotion code itself changes.) |
| Promotion fails with **401/403 (auth)** | The admin credential isn't available to the script. Confirm the production app has its admin password configured; the script uses it automatically. |
| Preview shows a **huge or unexpected diff** | Don't apply. Re-check the dev data first — something may have been added or changed by mistake. |
| Crawl/extraction **"already running"** | A previous run is still in progress. Wait for it to finish (check the status indicator) before starting another. |
| Upload says **"already on file"** | That exact PDF is already stored. No action needed. |
| Need to **undo** a promotion | Every applied promotion backs up the rows it changed before changing them. Ask an engineer to restore from the backup for that promotion run — this is a manual recovery step, not a one-click button. |

---

## Quick reference

**Admin dashboard:** dev app `/admin` · prod `https://app.collbar.com/admin`

**Daily curation:** Crawl Report (or Upload CBA) → Extraction → Review Queue → Alerts/EIS Cross-Check → Overview.

**Promote to production (from `pipeline/`):**
```bash
python3 21_promote_to_prod.py --base https://app.collbar.com            # 1. preview
python3 21_promote_to_prod.py --base https://app.collbar.com --apply    # 2. apply
```
