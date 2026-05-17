#!/usr/bin/env python3

import asyncio
import sys
from pathlib import Path

import duckdb
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp-server"))

from retrieval_provider import parse_submission_response
from retrieval_service import BlastRetrievalService
from retrieval_store import RetrievalStore
from runtime_config import MCPServerConfig, RuntimeConfigManager

TEST_FASTA_QUERY = ">query\nACDEFGHIKL\n"


def test_retrieval_defaults_follow_blast_scaffolding(tmp_path, monkeypatch):
    monkeypatch.delenv("MCP_RETRIEVAL_ENABLED", raising=False)
    monkeypatch.delenv("MCP_RETRIEVAL_DATA_DIR", raising=False)
    monkeypatch.delenv("MCP_RETRIEVAL_DUCKDB_PATH", raising=False)
    config_path = tmp_path / "config" / "mcp_config.json"

    manager = RuntimeConfigManager(path=str(config_path))
    retrieval = manager.get().retrieval

    assert retrieval.provider == "ncbi_blast_remote"
    assert retrieval.feature_flags.enabled is False
    assert retrieval.feature_flags.export_parquet is False
    assert retrieval.blast.default_program == "blastp"
    assert retrieval.blast.default_database == "swissprot"
    assert retrieval.blast.default_hitlist_size == 25
    assert Path(retrieval.storage.duckdb_path).name == "blast_retrieval.duckdb"
    assert Path(retrieval.storage.data_dir) == config_path.parent / "retrieval"


def test_retrieval_env_overrides_apply_to_runtime_config(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_RETRIEVAL_ENABLED", "true")
    monkeypatch.setenv("MCP_RETRIEVAL_PROVIDER", "local_blast")
    monkeypatch.setenv("MCP_RETRIEVAL_DATA_DIR", str(tmp_path / "blast-data"))
    monkeypatch.setenv("MCP_RETRIEVAL_PROGRAM", "blastx")
    monkeypatch.setenv("MCP_RETRIEVAL_DATABASE", "nr")
    monkeypatch.setenv("MCP_RETRIEVAL_HITLIST_SIZE", "40")
    monkeypatch.setenv("MCP_RETRIEVAL_MAX_POLL_ATTEMPTS", "12")
    monkeypatch.setenv("MCP_RETRIEVAL_EXPORT_PARQUET", "true")

    cfg = MCPServerConfig()
    manager = RuntimeConfigManager(path=str(tmp_path / "config.json"))
    manager.reset_to_defaults()
    retrieval = manager.get().retrieval

    assert cfg.retrieval.provider == "local_blast"
    assert retrieval.feature_flags.enabled is True
    assert retrieval.feature_flags.export_parquet is True
    assert retrieval.provider == "local_blast"
    assert retrieval.blast.default_program == "blastx"
    assert retrieval.blast.default_database == "nr"
    assert retrieval.blast.default_hitlist_size == 40
    assert retrieval.blast.max_poll_attempts == 12
    assert Path(retrieval.storage.data_dir) == tmp_path / "blast-data"
    assert Path(retrieval.storage.duckdb_path) == tmp_path / "blast-data" / "blast_retrieval.duckdb"


def test_retrieval_store_initializes_duckdb_schema(tmp_path):
    cfg = MCPServerConfig()
    cfg.retrieval.feature_flags.enabled = True
    cfg.retrieval.storage.data_dir = str(tmp_path / "retrieval")
    cfg.retrieval.storage.duckdb_path = str(tmp_path / "retrieval" / "blast_retrieval.duckdb")
    cfg.retrieval.storage.parquet_export_dir = str(tmp_path / "retrieval" / "parquet")
    cfg.retrieval.storage.raw_payload_dir = str(tmp_path / "retrieval" / "raw_payloads")
    cfg.retrieval.storage.manifest_dir = str(tmp_path / "retrieval" / "manifests")

    store = RetrievalStore(cfg.retrieval)
    store.initialize_if_enabled()

    assert store.initialized is True
    assert store.last_error is None
    tables = store.schema_tables()
    assert "retrieval_requests" in tables
    assert "blast_hits" in tables
    assert "blast_alignments" in tables
    assert "protein_annotations" in tables
    assert "dataset_manifests" in tables
    with duckdb.connect(cfg.retrieval.storage.duckdb_path, read_only=True) as conn:
        evidence_columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info('evidence_documents')").fetchall()
        }
    assert {"run_id", "hit_rank", "source_system", "source_id", "retrieved_at"} <= evidence_columns
    versions = store.migration_versions()
    assert 4 in versions
    assert max(versions) == 4


def test_retrieval_store_skips_schema_when_disabled(tmp_path):
    cfg = MCPServerConfig()
    cfg.retrieval.feature_flags.enabled = False
    cfg.retrieval.storage.data_dir = str(tmp_path / "retrieval")
    cfg.retrieval.storage.duckdb_path = str(tmp_path / "retrieval" / "blast_retrieval.duckdb")

    store = RetrievalStore(cfg.retrieval)
    assert store.initialize_if_enabled() is None
    assert store.initialized is False
    assert Path(cfg.retrieval.storage.duckdb_path).exists() is False


def test_parse_submission_response_extracts_rid_and_rtoe():
    submission = parse_submission_response("RID = TEST123\nRTOE = 7\n")

    assert submission.remote_request_id == "TEST123"
    assert submission.remote_queue_hint_seconds == 7


def test_remote_retrieval_service_persists_hits_alignments_and_cache(tmp_path):
    cfg = MCPServerConfig()
    cfg.retrieval.feature_flags.enabled = True
    cfg.retrieval.feature_flags.evidence_enrichment = True
    cfg.retrieval.feature_flags.export_parquet = True
    cfg.retrieval.storage.data_dir = str(tmp_path / "retrieval")
    cfg.retrieval.storage.duckdb_path = str(tmp_path / "retrieval" / "blast_retrieval.duckdb")
    cfg.retrieval.storage.parquet_export_dir = str(tmp_path / "retrieval" / "parquet")
    cfg.retrieval.storage.raw_payload_dir = str(tmp_path / "retrieval" / "raw_payloads")
    cfg.retrieval.storage.manifest_dir = str(tmp_path / "retrieval" / "manifests")

    request_counts = {"submit": 0, "search_info": 0, "result": 0}
    xml_payload = """<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>
        <Hit>
          <Hit_def>Example protein [Testus organismus]</Hit_def>
          <Hit_accession>ABC123</Hit_accession>
          <Hit_len>100</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_bit-score>55.0</Hsp_bit-score>
              <Hsp_evalue>1e-20</Hsp_evalue>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>10</Hsp_query-to>
              <Hsp_hit-from>5</Hsp_hit-from>
              <Hsp_hit-to>14</Hsp_hit-to>
              <Hsp_identity>8</Hsp_identity>
              <Hsp_positive>9</Hsp_positive>
              <Hsp_align-len>10</Hsp_align-len>
              <Hsp_gaps>0</Hsp_gaps>
              <Hsp_qseq>ACDEFGHIKL</Hsp_qseq>
              <Hsp_hseq>ACDEYGHIKL</Hsp_hseq>
              <Hsp_midline>|||| |||||</Hsp_midline>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>
"""

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        if request.method == "POST":
            request_counts["submit"] += 1
            return httpx.Response(200, text="RID = TEST123\nRTOE = 0\n")
        if params.get("FORMAT_OBJECT") == "SearchInfo":
            request_counts["search_info"] += 1
            if request_counts["search_info"] == 1:
                return httpx.Response(200, text="Status=WAITING\n")
            return httpx.Response(200, text="Status=READY\nThereAreHits=yes\n")
        if params.get("FORMAT_TYPE") == "XML":
            request_counts["result"] += 1
            return httpx.Response(200, text=xml_payload)
        return httpx.Response(400, text="unexpected request")

    store = RetrievalStore(cfg.retrieval)
    service = BlastRetrievalService(
        config=cfg.retrieval,
        store=store,
        transport=httpx.MockTransport(handler),
        sleeper=lambda _: asyncio.sleep(0),
    )

    first = asyncio.run(service.retrieve(TEST_FASTA_QUERY))
    second = asyncio.run(service.retrieve(TEST_FASTA_QUERY))

    assert first.status == "completed"
    assert first.cached is False
    assert first.hit_count == 1
    assert first.remote_request_id == "TEST123"
    assert first.result["hits"][0]["accession"] == "ABC123"
    assert first.result["hits"][0]["organism"] == "Testus organismus"
    assert first.annotation_count == 1
    assert first.evidence_count == 1
    assert first.result["annotations"][0]["source_system"] == "ncbi_blast"
    assert first.result["annotations"][0]["source_id"] == "ABC123"
    assert first.result["annotations"][0]["annotation"]["bit_score"] == 55.0
    assert first.result["evidence_documents"][0]["title"] == "Example protein"
    assert "bit score 55.0" in first.result["evidence_documents"][0]["content_text"]
    assert first.result["evidence_documents"][0]["manifest_id"] == f"{first.request_id}_parquet"
    assert first.result["evidence_packet"]["document_count"] == 1
    assert first.result["evidence_packet"]["documents"][0]["source_id"] == "ABC123"
    assert len(first.result["dataset_manifests"]) == 1
    manifest = first.result["dataset_manifests"][0]
    assert manifest["manifest_id"] == f"{first.request_id}_parquet"
    assert manifest["request_id"] == first.request_id
    assert manifest["run_id"] == first.run_id
    assert manifest["provider"] == "ncbi_blast_remote"
    assert Path(manifest["parquet_path"]).is_dir() is True
    assert Path(manifest["manifest"]["manifest_path"]).is_file() is True
    assert Path(manifest["manifest"]["parquet_files"]["hits"]).is_file() is True
    assert Path(manifest["manifest"]["parquet_files"]["evidence_documents"]).is_file() is True
    assert manifest["manifest"]["evidence_count"] == 1
    assert len(first.result["alignments"]) == 1
    assert Path(first.raw_payload_path or "").exists() is True

    assert second.status == "completed"
    assert second.cached is True
    assert second.annotation_count == 1
    assert second.evidence_count == 1
    assert second.result["evidence_packet"]["document_count"] == 1
    assert second.result["dataset_manifests"][0]["manifest_id"] == f"{second.request_id}_parquet"
    assert request_counts == {"submit": 1, "search_info": 2, "result": 1}


def test_remote_retrieval_service_exports_parquet_without_evidence_documents(tmp_path):
    cfg = MCPServerConfig()
    cfg.retrieval.feature_flags.enabled = True
    cfg.retrieval.feature_flags.evidence_enrichment = False
    cfg.retrieval.feature_flags.export_parquet = True
    cfg.retrieval.storage.data_dir = str(tmp_path / "retrieval")
    cfg.retrieval.storage.duckdb_path = str(tmp_path / "retrieval" / "blast_retrieval.duckdb")
    cfg.retrieval.storage.parquet_export_dir = str(tmp_path / "retrieval" / "parquet")
    cfg.retrieval.storage.raw_payload_dir = str(tmp_path / "retrieval" / "raw_payloads")
    cfg.retrieval.storage.manifest_dir = str(tmp_path / "retrieval" / "manifests")

    xml_payload = """<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>
        <Hit>
          <Hit_def>Example protein [Testus organismus]</Hit_def>
          <Hit_accession>ABC123</Hit_accession>
          <Hit_len>100</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_bit-score>55.0</Hsp_bit-score>
              <Hsp_evalue>1e-20</Hsp_evalue>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>10</Hsp_query-to>
              <Hsp_hit-from>5</Hsp_hit-from>
              <Hsp_hit-to>14</Hsp_hit-to>
              <Hsp_identity>8</Hsp_identity>
              <Hsp_positive>9</Hsp_positive>
              <Hsp_align-len>10</Hsp_align-len>
              <Hsp_gaps>0</Hsp_gaps>
              <Hsp_qseq>ACDEFGHIKL</Hsp_qseq>
              <Hsp_hseq>ACDEYGHIKL</Hsp_hseq>
              <Hsp_midline>|||| |||||</Hsp_midline>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>
"""

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        if request.method == "POST":
            return httpx.Response(200, text="RID = TEST123\nRTOE = 0\n")
        if params.get("FORMAT_OBJECT") == "SearchInfo":
            return httpx.Response(200, text="Status=READY\nThereAreHits=yes\n")
        if params.get("FORMAT_TYPE") == "XML":
            return httpx.Response(200, text=xml_payload)
        return httpx.Response(400, text="unexpected request")

    store = RetrievalStore(cfg.retrieval)
    service = BlastRetrievalService(
        config=cfg.retrieval,
        store=store,
        transport=httpx.MockTransport(handler),
        sleeper=lambda _: asyncio.sleep(0),
    )

    result = asyncio.run(service.retrieve(TEST_FASTA_QUERY))

    assert result.status == "completed"
    assert result.annotation_count == 0
    assert result.evidence_count == 0
    assert len(result.result["dataset_manifests"]) == 1
    manifest = result.result["dataset_manifests"][0]
    assert manifest["manifest_id"] == f"{result.request_id}_parquet"
    assert manifest["request_id"] == result.request_id
    assert manifest["run_id"] == result.run_id
    assert manifest["manifest"]["evidence_count"] == 0
    assert Path(manifest["manifest"]["parquet_files"]["hits"]).is_file() is True
    assert Path(manifest["manifest"]["parquet_files"]["evidence_documents"]).is_file() is True
    with duckdb.connect() as conn:
        evidence_count = conn.execute(
            "SELECT COUNT(*) FROM read_parquet(?)",
            [manifest["manifest"]["parquet_files"]["evidence_documents"]],
        ).fetchone()[0]
    assert evidence_count == 0


def test_remote_retrieval_service_surfaces_upstream_failures(tmp_path):
    cfg = MCPServerConfig()
    cfg.retrieval.feature_flags.enabled = True
    cfg.retrieval.storage.data_dir = str(tmp_path / "retrieval")
    cfg.retrieval.storage.duckdb_path = str(tmp_path / "retrieval" / "blast_retrieval.duckdb")

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        if request.method == "POST":
            return httpx.Response(200, text="RID = FAIL123\nRTOE = 0\n")
        if params.get("FORMAT_OBJECT") == "SearchInfo":
            return httpx.Response(200, text="Status=FAILED\n")
        return httpx.Response(400, text="unexpected request")

    store = RetrievalStore(cfg.retrieval)
    service = BlastRetrievalService(
        config=cfg.retrieval,
        store=store,
        transport=httpx.MockTransport(handler),
        sleeper=lambda _: asyncio.sleep(0),
    )

    result = asyncio.run(service.retrieve(TEST_FASTA_QUERY))

    assert result.status == "failed"
    assert result.cached is False
    assert "failed" in str(result.result.get("error_text", "")).lower()


def test_retrieval_store_skips_schema_when_startup_bootstrap_disabled(tmp_path):
    cfg = MCPServerConfig()
    cfg.retrieval.feature_flags.enabled = True
    cfg.retrieval.feature_flags.create_schema_on_startup = False
    cfg.retrieval.storage.data_dir = str(tmp_path / "retrieval")
    cfg.retrieval.storage.duckdb_path = str(tmp_path / "retrieval" / "blast_retrieval.duckdb")

    store = RetrievalStore(cfg.retrieval)
    assert store.initialize_if_enabled() is None
    assert store.initialized is False
    assert Path(cfg.retrieval.storage.duckdb_path).exists() is False
