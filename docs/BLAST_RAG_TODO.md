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
- **Status**: Milestone 5 complete
- **Default storage direction**: DuckDB first, Parquet for export, `ipfs_datasets_py` optional for ETL
- **Current milestone**: Milestone 5 complete
- **Next in-progress task**: None — all Milestone 5 items are done; begin Milestone 6 scoping if needed
- **Primary edit targets**:
  - `mcp-server/retrieval_store.py`
  - `mcp-server/retrieval_bridge_daemon.py`
  - `mcp-server/server.py`
  - `tests/test_retrieval_bridge_daemon.py`
  - `docs/BLAST_RAG_TODO.md`
  - `docs/BLAST_RAG_INTEGRATION_PLAN.md`
- **Open decisions blocking deeper implementation**:
  - none
- **Recommended next slice** (if scope continues):
  1. Add a `retrieval_bridge_watch` script that polls completed bridge result files and calls `set_manifest_publication` on the store to keep DuckDB in sync after bridge jobs finish
  2. Consider adding a vector-embedding adjunct to the evidence store for semantic search
  3. Add rate-limit guards or back-off to the local BLAST+ provider for bulk job parallelism

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

- [x] Add a retrieval provider abstraction under `mcp-server/`
- [x] Implement NCBI BLAST Common URL API submission (`CMD=Put`)
- [x] Capture and persist `RID` and `RTOE`
- [x] Implement polling flow (`CMD=Get`) with bounded retries/backoff
- [x] Persist raw BLAST payloads to DuckDB
- [x] Normalize BLAST hits and alignments into DuckDB tables
- [x] Add cache key deduplication so repeated queries skip duplicate remote submissions
- [x] Add structured error handling for timeout, invalid response, and upstream failure cases

### Exit criteria

- a sequence query returns normalized BLAST hits
- repeat queries can reuse cache
- remote failures are diagnosable

---

## Milestone 2 — Evidence Enrichment

Goal: turn BLAST hits into promptable evidence with provenance.

- [x] Define normalized annotation record shape
- [x] Add accession/title/organism enrichment pipeline
- [x] Add evidence document table and retention rules
- [x] Generate short evidence packets for MCP consumers
- [x] Add provenance columns for source system, source id, retrieval time, and transform version
- [x] Identify where `ipfs_datasets_py` is truly needed for non-BLAST source ingestion
- [x] Add optional Parquet export for enriched evidence batches

### Exit criteria

- top hits include usable evidence summaries
- provenance is queryable from DuckDB

---

## Milestone 3 — MCP Server Exposure

Goal: make retrieval usable without the dashboard first.

- [x] Add REST endpoint to submit retrieval requests
- [x] Add REST endpoint to poll retrieval status/results
- [x] Add REST endpoint to list cached retrieval entries
- [x] Add MCP tool to start BLAST retrieval
- [x] Add MCP tool to fetch retrieval summary/evidence
- [x] Add MCP resource(s) for cached evidence bundles
- [x] Add tests for MCP and REST retrieval flows using mocked BLAST responses

### Exit criteria

- MCP clients can retrieve and inspect evidence
- REST endpoints expose the same normalized model

---

## Milestone 4 — Dashboard Exposure

Goal: expose retrieval controls and evidence visually.

- [x] Add retrieval settings UI near backend settings
- [x] Add per-job retrieval status indicator
- [x] Add evidence browser/table for BLAST hits
- [x] Add summary cards for top homologs and cache state
- [x] Add UI toggle for “ground this design with BLAST evidence”
- [x] Add dashboard tests for settings and evidence rendering

### Exit criteria

- dashboard users can enable retrieval and inspect evidence without raw API access

---

## Milestone 5 — Optional Local BLAST+ and Dataset Packaging

Goal: support reproducible offline workflows after the remote path is stable.

- [x] Add local BLAST+ provider interface
- [x] Define local database configuration and discovery rules
- [x] Add export/import path for retrieval data as Parquet bundles
- [x] Add optional `ipfs_datasets_py` bridge scripts for scraping/transformation workflows
- [x] Add optional manifest fields for IPFS CID/CAR references
- [x] Document when to choose remote BLAST vs local BLAST+

### Exit criteria

- provider abstraction supports remote and local BLAST
- reproducible offline dataset workflows are documented

---

## Ordered Next Tasks

If a new session needs an unambiguous place to start, work top-down through this list:

1. [x] Decide whether BLAST grounding stays opt-in when MCP endpoints/resources ship
2. [x] Add dashboard tests for retrieval settings and evidence rendering
3. [x] Harden retrieval contract/evidence wiring based on dashboard and MCP feedback
4. [x] Add local BLAST+ provider support after the remote evidence path is stable
5. [x] Add export/import path for retrieval data as Parquet bundles
6. [x] Add optional manifest fields for IPFS CID/CAR references
7. [x] Add optional `ipfs_datasets_py` bridge scripts only after a non-BLAST ETL source requires them (daemon/supervisor scaffolding landed)
8. [x] Document when to choose remote BLAST vs local BLAST+

---

## Session Handoff Notes

Use this block at the end of each Copilot session. Replace the placeholders instead of appending prose elsewhere.

- **Last completed task**: add optional IPFS CID/CAR manifest fields, bridge daemon back-annotation for publication results, REST/MCP publication endpoints, and remote vs local BLAST+ selection documentation
- **Next recommended task**: Milestone 5 is complete. If scope continues, consider: (1) bridge watch script to sync DuckDB with completed bridge result CIDs, (2) evidence semantic search via embeddings, or (3) rate-limit guards for local BLAST+ bulk jobs
- **Files to open first next time**:
  - `docs/BLAST_RAG_TODO.md`
  - `mcp-server/retrieval_store.py`
  - `mcp-server/retrieval_service.py`
  - `mcp-server/server.py`
  - `mcp-server/retrieval_bridge_daemon.py`
  - `tests/test_blast_retrieval_config.py`
  - `tests/test_retrieval_bridge_daemon.py`
  - `docs/BLAST_RAG_INTEGRATION_PLAN.md`
- **Known blockers**:
  - none
- **Validation to run next time**:
  - `pytest /home/runner/work/ProteinCAD/ProteinCAD/tests/test_retrieval_bridge_daemon.py`
  - `cd /home/runner/work/ProteinCAD/ProteinCAD/mcp-dashboard && npm run lint`
  - `cd /home/runner/work/ProteinCAD/ProteinCAD/mcp-dashboard && npm run build`
  - `pytest /home/runner/work/ProteinCAD/ProteinCAD/tests/test_blast_retrieval_config.py`
  - `docker build -t test-mcp-server /home/runner/work/ProteinCAD/ProteinCAD/mcp-server`

Keep this section current so a new Copilot session can resume work quickly without re-deriving project context.
