# BLAST RAG Actionable Todo / Session Resume Guide

This document turns the higher-level plan in [BLAST_RAG_INTEGRATION_PLAN.md](BLAST_RAG_INTEGRATION_PLAN.md) into a supervisor-friendly working checklist that can be resumed across GitHub Copilot sessions with minimal warm-up time.

## Quick Resume for a New Session

Open these files first, in order:

1. `docs/BLAST_RAG_TODO.md`
2. `docs/BLAST_RAG_INTEGRATION_PLAN.md`
3. `docs/AGENTS.md`
4. `mcp-server/runtime_config.py`
5. `mcp-server/server.py`

Then answer these questions before making changes:

- What is the current active milestone below?
- Which single task is marked as the next in-progress task?
- What unresolved decisions or blockers are listed in the supervisor snapshot?
- Which files are the likely edit targets for that task?

If the snapshot is stale, update it before starting implementation work.

---

## Supervisor Snapshot

- **Project**: BLAST-backed retrieval-augmented generation for ProteinCAD
- **Status**: Milestone 0 completed, Milestone 1 ready
- **Default storage direction**: DuckDB first, Parquet for export, `ipfs_datasets_py` optional for ETL
- **Current milestone**: Milestone 1 — remote BLAST provider
- **Next in-progress task**: add a retrieval provider abstraction under `mcp-server/`
- **Primary edit targets**:
  - `mcp-server/server.py`
  - `mcp-server/retrieval_store.py`
  - `mcp-server/runtime_config.py`
  - `mcp-server/model_backends.py`
  - `docs/BLAST_RAG_INTEGRATION_PLAN.md`
- **Open decisions blocking deeper implementation**:
  - whether BLAST grounding is opt-in or enabled by default for design jobs
- **Recommended first implementation slice**:
  1. remote BLAST provider abstraction
  2. remote submission/polling against NCBI BLAST
  3. raw payload persistence plus normalized hit writes
  4. MCP-only endpoints/tools

Update this snapshot at the end of every meaningful session so a future Copilot run can resume immediately.

---

## Todo Daemon Operating Rules

Treat this document as the durable task ledger for BLAST RAG work.

- Keep exactly one task marked as the immediate in-progress item in the supervisor snapshot.
- When a task is completed, check it off here and move the next task into the snapshot.
- If work is partially done, add a short note in the handoff section rather than leaving context only in commit messages.
- Prefer resuming from the topmost unchecked item in the active milestone unless a blocker requires reordering.
- If implementation changes the plan materially, update both this file and `docs/BLAST_RAG_INTEGRATION_PLAN.md`.

---

## Milestone 0 — Implementation Scaffolding

Goal: establish the minimal structure needed to start real implementation without changing runtime behavior yet.

- [x] Add retrieval settings models to `mcp-server/runtime_config.py`
- [x] Decide and document initial BLAST presets (`program`, `database`, `hitlist_size`, polling/backoff defaults)
- [x] Define DuckDB file location and environment/config keys
- [x] Create retrieval schema/migration module for DuckDB tables
- [x] Add retrieval feature flag(s) so the subsystem can stay dark by default
- [x] Add a small `docs/` section describing where resumption state should be updated after each session

### Exit criteria

- retrieval config shape exists
- DuckDB schema location is defined
- the initial implementation slice is unblocked

---

## Milestone 1 — Remote BLAST Provider

Goal: enable remote BLAST query submission and normalized hit persistence.

- [ ] Add a retrieval provider abstraction under `mcp-server/`
- [ ] Implement NCBI BLAST Common URL API submission (`CMD=Put`)
- [ ] Capture and persist `RID` and `RTOE`
- [ ] Implement polling flow (`CMD=Get`) with bounded retries/backoff
- [ ] Persist raw BLAST payloads to DuckDB
- [ ] Normalize BLAST hits and alignments into DuckDB tables
- [ ] Add cache key deduplication so repeated queries skip duplicate remote submissions
- [ ] Add structured error handling for timeout, invalid response, and upstream failure cases

### Exit criteria

- a sequence query returns normalized BLAST hits
- repeat queries can reuse cache
- remote failures are diagnosable

---

## Milestone 2 — Evidence Enrichment

Goal: turn BLAST hits into promptable evidence with provenance.

- [ ] Define normalized annotation record shape
- [ ] Add accession/title/organism enrichment pipeline
- [ ] Add evidence document table and retention rules
- [ ] Generate short evidence packets for MCP consumers
- [ ] Add provenance columns for source system, source id, retrieval time, and transform version
- [ ] Identify where `ipfs_datasets_py` is truly needed for non-BLAST source ingestion
- [ ] Add optional Parquet export for enriched evidence batches

### Exit criteria

- top hits include usable evidence summaries
- provenance is queryable from DuckDB

---

## Milestone 3 — MCP Server Exposure

Goal: make retrieval usable without the dashboard first.

- [ ] Add REST endpoint to submit retrieval requests
- [ ] Add REST endpoint to poll retrieval status/results
- [ ] Add REST endpoint to list cached retrieval entries
- [ ] Add MCP tool to start BLAST retrieval
- [ ] Add MCP tool to fetch retrieval summary/evidence
- [ ] Add MCP resource(s) for cached evidence bundles
- [ ] Add tests for MCP and REST retrieval flows using mocked BLAST responses

### Exit criteria

- MCP clients can retrieve and inspect evidence
- REST endpoints expose the same normalized model

---

## Milestone 4 — Dashboard Exposure

Goal: expose retrieval controls and evidence visually.

- [ ] Add retrieval settings UI near backend settings
- [ ] Add per-job retrieval status indicator
- [ ] Add evidence browser/table for BLAST hits
- [ ] Add summary cards for top homologs and cache state
- [ ] Add UI toggle for “ground this design with BLAST evidence”
- [ ] Add dashboard tests for settings and evidence rendering

### Exit criteria

- dashboard users can enable retrieval and inspect evidence without raw API access

---

## Milestone 5 — Optional Local BLAST+ and Dataset Packaging

Goal: support reproducible offline workflows after the remote path is stable.

- [ ] Add local BLAST+ provider interface
- [ ] Define local database configuration and discovery rules
- [ ] Add export/import path for retrieval data as Parquet bundles
- [ ] Add optional `ipfs_datasets_py` bridge scripts for scraping/transformation workflows
- [ ] Add optional manifest fields for IPFS CID/CAR references
- [ ] Document when to choose remote BLAST vs local BLAST+

### Exit criteria

- provider abstraction supports remote and local BLAST
- reproducible offline dataset workflows are documented

---

## Ordered Next Tasks

If a new session needs an unambiguous place to start, work top-down through this list:

1. [ ] Add remote BLAST provider interface and placeholder wiring
2. [ ] Implement NCBI BLAST `CMD=Put` submission and `RID`/`RTOE` capture
3. [ ] Implement `CMD=Get` polling with bounded retries/backoff
4. [ ] Persist raw BLAST payloads plus normalized hits into DuckDB
5. [ ] Add mocked tests for BLAST response parsing and polling
6. [ ] Add MCP-only retrieval endpoints/tools before dashboard UI

---

## Session Handoff Notes

Use this block at the end of each Copilot session. Replace the placeholders instead of appending prose elsewhere.

- **Last completed task**: Milestone 0 scaffolding — runtime config, DuckDB schema bootstrap, feature flags, and resume-state docs
- **Next recommended task**: add a retrieval provider abstraction under `mcp-server/`
- **Files to open first next time**:
  - `docs/BLAST_RAG_TODO.md`
  - `mcp-server/retrieval_store.py`
  - `mcp-server/runtime_config.py`
  - `docs/BLAST_RAG_INTEGRATION_PLAN.md`
- **Known blockers**:
  - decide whether BLAST grounding stays opt-in once MCP endpoints exist
- **Validation to run next time**:
  - `pytest /home/runner/work/ProteinCAD/ProteinCAD/tests/test_blast_retrieval_config.py`
  - `docker build -t test-mcp-server /home/runner/work/ProteinCAD/ProteinCAD/mcp-server`

Keep this section current so a new Copilot session can resume work quickly without re-deriving project context.
