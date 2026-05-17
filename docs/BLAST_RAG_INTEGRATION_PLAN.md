# BLAST Retrieval-Augmented Generation Integration Plan

## Executive Summary

This plan adds a BLAST-backed retrieval layer to ProteinCAD so the MCP server and dashboard can ground protein-design workflows in homologous sequence evidence, annotations, and provenance-aware dataset snapshots. The default local persistence layer should be DuckDB, with `endomorphosis/ipfs_datasets_py` used selectively for external dataset acquisition, scraping, normalization, Parquet conversion, and optional IPFS packaging when upstream sources are not already available in a structured format.

For a resumable, execution-oriented checklist that can be carried across Copilot sessions, see [BLAST_RAG_TODO.md](BLAST_RAG_TODO.md).

The recommended rollout is incremental:

1. Introduce a DuckDB-backed retrieval store and manifest format.
2. Add a BLAST provider that can query NCBI BLAST remotely through the Common URL API.
3. Materialize BLAST hits, annotations, and evidence text into DuckDB tables for retrieval.
4. Expose retrieval controls and evidence summaries through MCP server endpoints, MCP tools, and dashboard UI.
5. Add optional offline/local BLAST+ support and optional IPFS dataset publishing after the remote path is stable.

---

## Implementation Status

- Milestone 0 scaffolding is complete.
- Milestone 1 remote BLAST retrieval is now implemented in the MCP server internals via:
  - `mcp-server/retrieval_provider.py`
  - `mcp-server/retrieval_service.py`
  - `mcp-server/retrieval_store.py`
- Remote retrieval currently covers NCBI BLAST `CMD=Put`, `CMD=Get` polling, DuckDB persistence, raw payload retention, alignment normalization, cache reuse, and mocked test coverage.
- Milestone 2 now has a first enrichment slice: normalized annotation records, accession/title/organism enrichment, evidence documents with provenance fields, and short evidence packets are produced from cached BLAST hits.
- The `ipfs_datasets_py` boundary is now defined: BLAST query-time retrieval, caching, normalization, and evidence packets stay in the MCP server; only non-BLAST scraping, heterogeneous ETL, Parquet packaging, and optional IPFS publication should cross into `ipfs_datasets_py`.
- Milestone 2 now also supports optional DuckDB-backed Parquet bundle export plus dataset manifest persistence for enriched retrieval batches.
- Remaining work is focused on exposing retrieval evidence through MCP/REST and dashboard UX.

---

## Goals

- Add BLAST as a first-class retrieval source for sequence-centric grounding.
- Keep DuckDB as the default storage, caching, and retrieval engine.
- Reuse the existing MCP server runtime-config pattern for provider selection and fallback.
- Preserve provenance for every retrieved hit, annotation, transform, and generated summary.
- Make external scraping and transformation optional, delegated to `ipfs_datasets_py` only when the source requires custom acquisition or normalization.
- Support both interactive use in the dashboard and automated use through MCP tools and REST APIs.

## Non-Goals

- Replacing the existing design pipeline steps with BLAST.
- Building a new distributed datastore before the feature proves value.
- Defaulting to IPFS or a vector database for the first implementation.
- Turning the initial milestone into a fully autonomous web crawler.

---

## Current Repository Fit

ProteinCAD already has the core extension points needed for this work:

- `mcp-server/server.py` exposes REST endpoints plus MCP tools/resources.
- `mcp-server/runtime_config.py` already models provider routing and persisted runtime configuration.
- `mcp-dashboard/components/BackendSettings.tsx` provides a pattern for editable server-side settings.
- The repository already treats documentation plans in `docs/` as a normal deliverable for architecture work.

That means the BLAST integration should be added as a new retrieval subsystem beside the current model-routing subsystem, not as an ad hoc script.

---

## External Source Strategy

### Primary source: NCBI BLAST

Use `https://blast.ncbi.nlm.nih.gov/Blast.cgi` via the BLAST Common URL API for the initial online integration. The remote workflow should follow the supported `CMD=Put` and `CMD=Get` model:

- submit a query with `CMD=Put`
- capture `RID` and `RTOE`
- wait at least `RTOE`
- poll with `CMD=Get`
- persist the raw result payload plus normalized hit records

This path is appropriate for a first milestone because it avoids shipping massive local BLAST databases immediately. The integration should still be designed so a local BLAST+ provider can be added later under the same interface.

### Optional source helper: `ipfs_datasets_py`

Use `endomorphosis/ipfs_datasets_py` only for tasks such as:

- scraping or mirroring non-BLAST evidence pages
- converting heterogeneous source material into Parquet/JSONL
- packaging curated corpora for reproducible reuse
- optional IPFS publication of dataset bundles and manifests

It should remain an auxiliary ingestion dependency, not the default query-time retrieval engine.

---

## Target User Experience

### MCP and API users

Users should be able to:

- submit a protein sequence and request BLAST grounding
- inspect top homologs, alignments, annotations, and source provenance
- constrain retrieval by database, organism, e-value, identity, or hit count
- re-use cached retrieval results when the same query is repeated
- include retrieved evidence in downstream design and analysis prompts

### Dashboard users

Users should be able to:

- enable or disable BLAST retrieval in settings
- choose retrieval mode: remote BLAST now, local BLAST later
- see retrieval status, cache hit status, and evidence summaries
- browse normalized hit tables and linked source documents
- decide whether a design run should require retrieval grounding or treat it as optional enrichment

---

## Initial Implementation Defaults

To unblock the first implementation slice, use these defaults unless project requirements change:

- BLAST provider: remote NCBI BLAST Common URL API
- BLAST program preset: `blastp`
- BLAST database preset: `swissprot`
- default hitlist size: `25`
- max hitlist size before explicit tuning: `100`
- default poll interval: `5` seconds
- default max poll attempts: `60`
- default request timeout: `30` seconds
- default DuckDB file: `MCP_RETRIEVAL_DUCKDB_PATH` or `MCP_RETRIEVAL_DATA_DIR/blast_retrieval.duckdb`

These defaults should remain configurable through runtime config and environment overrides, but they are now the canonical bootstrap values for Milestone 0.

---

## Proposed Architecture

### 1. Retrieval domain layer

Add a retrieval module in the MCP server responsible for:

- query normalization
- provider dispatch
- asynchronous job submission and polling
- parsing and normalization of BLAST results
- retrieval scoring and evidence selection
- persistence into DuckDB

Suggested internal concepts:

- retrieval request
- provider result
- normalized hit
- evidence document
- retrieval cache entry
- dataset manifest

### 2. Provider abstraction

Define retrieval providers similarly to the existing model providers:

- `blast_remote` for NCBI BLAST Common URL API
- `blast_local` for future BLAST+ CLI or containerized local execution
- `duckdb_cache` as the default cache/read path layered beneath both
- `ipfs_dataset_ingest` as an offline ingestion helper, not a live query provider

The runtime config should allow:

- enable/disable per provider
- ordering and fallback
- timeouts and polling intervals
- database and parameter presets
- cache retention policy

### 3. DuckDB-first storage

DuckDB should be the system of record for retrieval state and normalized evidence. Use Parquet for bulk import/export and DuckDB for query orchestration, joins, and lightweight analytics.

Suggested tables:

- `retrieval_queries`
- `blast_requests`
- `blast_hits`
- `blast_alignments`
- `protein_annotations`
- `evidence_documents`
- `dataset_manifests`
- `retrieval_cache_entries`

Store both raw source payloads and normalized records so the system can be re-parsed if schemas evolve.

### 4. Evidence pipeline

The evidence pipeline should separate three concerns:

1. sequence search
2. metadata enrichment
3. prompt assembly

That makes it possible to:

- use BLAST for candidate discovery
- use DuckDB joins to attach annotations and prior run metadata
- optionally use `ipfs_datasets_py` to enrich records with scraped abstracts, pages, or mirrored datasets
- generate concise retrieval packets for agents, dashboards, and reports

---

## Data Model and Storage Plan

### Canonical query identity

Define a deterministic query key from:

- normalized amino-acid sequence
- BLAST program
- target database
- retrieval parameters
- requested enrichment profile

This key becomes the cache key in DuckDB and prevents duplicate remote submissions.

### Core entities

- **Query**: the original sequence and parameter set
- **Run**: one execution against one provider
- **Hit**: one BLAST subject result
- **Alignment**: detailed alignment segments and statistics
- **Annotation**: titles, organisms, source DB records, functional text
- **Evidence document**: curated summary text, abstract fragments, or source snippets
- **Manifest**: lineage for datasets imported through `ipfs_datasets_py` or other ETL jobs

### Storage formats

- DuckDB database file for operational state
- Parquet snapshots for bulk transport and reproducibility
- JSON blobs for raw upstream responses
- optional IPFS CAR or CID references in manifests when datasets are published externally

---

## Retrieval and Ranking Strategy

The first version should stay simple and transparent:

- rank candidate hits primarily by BLAST statistics
- apply configurable post-filters for organism, sequence coverage, identity, and annotation completeness
- build a compact evidence set from the highest-confidence hits
- store both the full hit list and the short evidence packet

After the baseline works, add:

- domain-specific reranking
- clustering or diversity sampling across homologs
- prompt-size budgeting
- optional vector or graph augmentation for text evidence, still sourced from DuckDB-backed manifests

---

## Integration Points in This Repository

### MCP server

Planned additions:

- retrieval configuration schema in `mcp-server/runtime_config.py`
- retrieval provider and storage modules under `mcp-server/`
- REST endpoints for submitting retrieval queries, polling status, listing cached evidence, and reading manifests
- MCP tools for starting BLAST retrieval, listing evidence, and fetching retrieval summaries
- MCP resources for cached evidence bundles tied to jobs or standalone sequence queries

### Dashboard

Planned additions:

- retrieval settings panel adjacent to backend settings
- retrieval status widgets in job views
- evidence browser for hits, annotations, and provenance
- optional “ground design with BLAST evidence” controls in submission flows

### Scripts and ops

Planned additions:

- data-init scripts to create DuckDB schema and seed presets
- optional ETL wrappers that call `ipfs_datasets_py`
- maintenance scripts for cache pruning, manifest verification, and Parquet export

---

## Implementation Phases

### Phase 1: Architecture and schema foundation

- Add a dedicated BLAST RAG plan and implementation checklist.
- Define DuckDB schema, cache keys, and manifest conventions.
- Extend runtime config with retrieval provider settings and sensible defaults.
- Add feature flags so retrieval can ship dark by default if needed.

### Exit criteria

- schema and config shape are stable
- retrieval feature boundaries are documented
- no existing workflows are affected when retrieval is disabled

### Phase 2: Remote BLAST provider

- Implement remote submission and polling against the NCBI BLAST Common URL API.
- Persist raw responses plus normalized hits into DuckDB.
- Add retry, timeout, and backoff behavior that respects upstream service limits.
- Add query deduplication so repeated requests hit DuckDB before remote BLAST.

### Exit criteria

- users can submit a sequence and retrieve normalized BLAST hits
- repeated requests reuse cached results
- upstream failures surface clear diagnostics

### Phase 3: Evidence enrichment

- Normalize organism, accession, title, and alignment metadata.
- Add optional annotation enrichment passes for selected hits.
- Support ETL adapters that can call `ipfs_datasets_py` when source material needs scraping or conversion.
- Generate compact evidence summaries for downstream prompting.

### Exit criteria

- top hits have structured metadata and human-readable evidence packets
- enrichment is provenance-aware and reproducible

### Phase 4: MCP and dashboard exposure

- Add REST endpoints, MCP tools, and MCP resources for retrieval.
- Add dashboard controls and evidence views.
- Allow design jobs to opt into retrieval grounding and store the associated evidence bundle.

### Exit criteria

- retrieval is usable from both MCP clients and the dashboard
- evidence can be inspected without reading raw database tables

### Phase 5: Local BLAST+ and reproducible datasets

- Add an optional local BLAST+ provider for labs with local databases.
- Add optional mirroring and publication workflows for curated corpora.
- Export retrieval datasets as Parquet bundles and optionally publish them through IPFS-backed manifests.

### Exit criteria

- provider abstraction supports both remote and local BLAST
- reproducible offline datasets are supported without changing the query interface

---

## DuckDB Defaults

DuckDB should be the default because it matches this feature’s needs well:

- embedded and easy to ship with the MCP server
- strong support for Parquet and analytical joins
- suitable for caching, manifests, and evidence tables
- easy to inspect locally during development and operations

Default policies:

- local DuckDB file under a configurable data directory
- Parquet export for every reproducible ETL batch
- normalized tables plus raw payload retention
- explicit migration versioning for schema changes

DuckDB should remain the default even if later phases add vector, graph, or IPFS-backed adjunct systems.

Recommended Milestone 0 path layout:

- `MCP_RETRIEVAL_DATA_DIR` for the retrieval working directory
- `MCP_RETRIEVAL_DUCKDB_PATH` for the canonical DuckDB file
- `MCP_RETRIEVAL_PARQUET_DIR` for reproducible Parquet exports
- `MCP_RETRIEVAL_RAW_PAYLOAD_DIR` for raw BLAST response retention
- `MCP_RETRIEVAL_MANIFEST_DIR` for dataset manifests and provenance bundles

---

## `ipfs_datasets_py` Usage Policy

Use `ipfs_datasets_py` when one of these conditions is true:

- a required evidence source is only available through scraping or custom extraction
- a source needs transformation into Parquet/JSONL before DuckDB ingestion
- a curated dataset bundle should be packaged for sharing or long-term reproducibility
- provenance needs optional IPFS publication and content-addressed references

Do not use it for:

- the default query cache
- the first-pass BLAST request/response loop
- features that can be satisfied entirely by DuckDB plus direct BLAST normalization

This keeps the first release simpler while still leaving a clear path to richer ingestion workflows.

### Current repository boundary

For the current ProteinCAD repository layout, the boundary should be:

| Keep in ProteinCAD / `mcp-server` | Defer to `ipfs_datasets_py` only when needed |
|---|---|
| NCBI BLAST `CMD=Put` / `CMD=Get` query execution | scraping non-BLAST evidence pages or portals |
| DuckDB request/run/hit/alignment persistence | custom extraction from HTML, PDFs, or mixed upstream formats |
| annotation and evidence packet generation from normalized BLAST hits | conversion of scraped corpora into Parquet/JSONL datasets |
| cache lookup, raw payload retention, and MCP/REST-facing evidence reads | packaging reusable dataset bundles or publishing optional IPFS-backed manifests |
| local manifest bookkeeping in `dataset_manifests` and `MCP_RETRIEVAL_MANIFEST_DIR` | standalone ETL jobs that run outside the live retrieval request path |

Concretely, that means:

- `mcp-server/retrieval_provider.py`, `mcp-server/retrieval_service.py`, and `mcp-server/retrieval_store.py` remain the runtime path for live BLAST retrieval.
- `dataset_manifests`, `MCP_RETRIEVAL_PARQUET_DIR`, and `MCP_RETRIEVAL_MANIFEST_DIR` are local staging/provenance hooks first, not a requirement to adopt `ipfs_datasets_py` immediately.
- The first time this repository should add an `ipfs_datasets_py` bridge is when enrichment depends on non-BLAST sources that cannot be ingested cleanly from structured API payloads already normalized inside the MCP server.
- Parquet export can be implemented inside ProteinCAD first; only dataset sharing, offline mirroring, or content-addressed publication should require handing the batch off to `ipfs_datasets_py`.

### Session resume state

Update resumable execution state in `docs/BLAST_RAG_TODO.md`, specifically:

- `Supervisor Snapshot`
- `Ordered Next Tasks`
- `Session Handoff Notes`

That keeps the todo daemon state durable across Copilot sessions without duplicating implementation notes in multiple docs.

---

## Reliability, Compliance, and Safety

### Remote service limits

Because the first provider uses NCBI BLAST remotely, the implementation should include:

- polling discipline based on `RTOE`
- bounded concurrency
- exponential backoff
- cache-first deduplication
- operator controls to disable remote retrieval or redirect to local BLAST

### Provenance

Every normalized record should track:

- source system
- source identifier
- retrieval timestamp
- transform version
- manifest or dataset batch id

### Security

- sanitize sequence and parameter inputs
- validate remote responses before persistence
- separate raw payload retention from prompt-facing summaries
- avoid letting untrusted source text flow directly into prompts without normalization and truncation

---

## Validation Plan

Validation should be phased alongside implementation:

- unit tests for query normalization, cache-key generation, BLAST parsing, and DuckDB persistence
- integration tests for remote submission, polling, and result normalization with mocked BLAST responses
- end-to-end MCP tests for retrieval tool invocation and resource reads
- dashboard tests for settings, retrieval state, and evidence rendering
- fixture-based regression tests for schema migrations and manifest re-ingestion

Success metrics:

- repeat queries hit cache instead of re-submitting upstream
- retrieval adds useful grounded evidence to design workflows
- dashboard and MCP consumers expose the same evidence model
- DuckDB remains the canonical local source of truth

---

## Recommended Deliverables

1. DuckDB retrieval schema and migration support
2. BLAST remote provider with polling and caching
3. MCP tools and REST endpoints for retrieval
4. dashboard retrieval settings and evidence views
5. optional ETL bridge to `ipfs_datasets_py`
6. operational docs for dataset refresh, cache pruning, and provenance review

---

## Open Decisions

- Which BLAST program and database presets should be exposed first for protein workflows?
- Should retrieval run automatically for every design job or remain opt-in at first?
- Which annotation sources beyond BLAST hit metadata are worth enriching in milestone one?
- How long should remote BLAST results remain in cache by default?
- When should the project invest in local BLAST+ mirrors versus continuing with remote BLAST for the initial rollout?

---

## Recommended Next Step

Start with a small implementation slice: DuckDB schema plus a remote BLAST provider and MCP-only retrieval endpoints. Once that is stable, add evidence enrichment and dashboard support, then bring in `ipfs_datasets_py` only where external ETL complexity justifies it.
