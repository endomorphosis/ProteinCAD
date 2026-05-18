#!/usr/bin/env python3

import asyncio
import importlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Callable, Dict, List, Tuple

import duckdb
import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp-server"))
mcp_server_module = importlib.import_module("server")

from retrieval_provider import (
    LocalBlastProvider,
    RetrievalConfigError,
    build_query_from_config,
    parse_submission_response,
)
from retrieval_service import BlastRetrievalService
from retrieval_store import RetrievalStore
from runtime_config import MCPServerConfig, RuntimeConfigManager

TEST_FASTA_QUERY = ">query\nACDEFGHIKL\n"
MOCK_BLAST_XML = """<?xml version="1.0"?>
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


def _mock_blast_handler() -> Tuple[Callable[[httpx.Request], httpx.Response], Dict[str, int]]:
    request_counts = {"submit": 0, "search_info": 0, "result": 0}

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
            return httpx.Response(200, text=MOCK_BLAST_XML)
        return httpx.Response(400, text="unexpected request")

    return handler, request_counts


def _configure_and_reset_server_for_retrieval(
    tmp_path,
    handler,
    *,
    evidence_enrichment=True,
    export_parquet=False,
):
    server = mcp_server_module
    retrieval = server.config_manager.get().retrieval
    retrieval.feature_flags.enabled = True
    retrieval.feature_flags.expose_rest = True
    retrieval.feature_flags.expose_mcp = True
    retrieval.feature_flags.evidence_enrichment = evidence_enrichment
    retrieval.feature_flags.export_parquet = export_parquet
    retrieval.feature_flags.create_schema_on_startup = True
    retrieval.storage.data_dir = str(tmp_path / "retrieval")
    retrieval.storage.duckdb_path = str(tmp_path / "retrieval" / "blast_retrieval.duckdb")
    retrieval.storage.parquet_export_dir = str(tmp_path / "retrieval" / "parquet")
    retrieval.storage.raw_payload_dir = str(tmp_path / "retrieval" / "raw_payloads")
    retrieval.storage.manifest_dir = str(tmp_path / "retrieval" / "manifests")

    store = RetrievalStore(retrieval)
    server.app.state.retrieval_store = store
    server.app.state.retrieval_service = BlastRetrievalService(
        config=retrieval,
        store=store,
        transport=httpx.MockTransport(handler),
        sleeper=lambda _: asyncio.sleep(0),
    )
    server.jobs_db.clear()
    return server


def test_retrieval_defaults_follow_blast_scaffolding(tmp_path, monkeypatch):
    monkeypatch.delenv("MCP_RETRIEVAL_ENABLED", raising=False)
    monkeypatch.delenv("MCP_RETRIEVAL_ENABLE_JOB_GROUNDING", raising=False)
    monkeypatch.delenv("MCP_RETRIEVAL_DATA_DIR", raising=False)
    monkeypatch.delenv("MCP_RETRIEVAL_DUCKDB_PATH", raising=False)
    config_path = tmp_path / "config" / "mcp_config.json"

    manager = RuntimeConfigManager(path=str(config_path))
    retrieval = manager.get().retrieval

    assert retrieval.provider == "ncbi_blast_remote"
    assert retrieval.feature_flags.enabled is False
    assert retrieval.feature_flags.allow_job_grounding is False
    assert retrieval.feature_flags.export_parquet is False
    assert retrieval.blast.default_program == "blastp"
    assert retrieval.blast.default_database == "swissprot"
    assert retrieval.blast.default_hitlist_size == 25
    assert Path(retrieval.storage.duckdb_path).name == "blast_retrieval.duckdb"
    assert Path(retrieval.storage.data_dir) == config_path.parent / "retrieval"


def test_retrieval_env_overrides_apply_to_runtime_config(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_RETRIEVAL_ENABLED", "true")
    monkeypatch.setenv("MCP_RETRIEVAL_ENABLE_JOB_GROUNDING", "true")
    monkeypatch.setenv("MCP_RETRIEVAL_PROVIDER", "local_blast")
    monkeypatch.setenv("MCP_RETRIEVAL_DATA_DIR", str(tmp_path / "blast-data"))
    monkeypatch.setenv("MCP_RETRIEVAL_PROGRAM", "blastx")
    monkeypatch.setenv("MCP_RETRIEVAL_DATABASE", "nr")
    monkeypatch.setenv("MCP_RETRIEVAL_HITLIST_SIZE", "40")
    monkeypatch.setenv("MCP_RETRIEVAL_MAX_POLL_ATTEMPTS", "12")
    monkeypatch.setenv("MCP_RETRIEVAL_EXPORT_PARQUET", "true")
    monkeypatch.setenv("MCP_RETRIEVAL_LOCAL_BLAST_BINARY", "/usr/local/bin/blastp")
    monkeypatch.setenv("MCP_RETRIEVAL_LOCAL_DATABASE", "swissprot_local")
    monkeypatch.setenv("MCP_RETRIEVAL_LOCAL_DATABASE_DIR", str(tmp_path / "blast-data" / "databases"))
    monkeypatch.setenv("MCP_RETRIEVAL_LOCAL_DATABASE_GLOB", "*.pin")

    cfg = MCPServerConfig()
    manager = RuntimeConfigManager(path=str(tmp_path / "config.json"))
    manager.reset_to_defaults()
    retrieval = manager.get().retrieval

    assert cfg.retrieval.provider == "local_blast"
    assert retrieval.feature_flags.enabled is True
    assert retrieval.feature_flags.allow_job_grounding is True
    assert retrieval.feature_flags.export_parquet is True
    assert retrieval.provider == "local_blast"
    assert retrieval.blast.default_program == "blastx"
    assert retrieval.blast.default_database == "nr"
    assert retrieval.blast.local_blast_binary == "/usr/local/bin/blastp"
    assert retrieval.blast.local_database == "swissprot_local"
    assert Path(retrieval.blast.local_database_dir) == tmp_path / "blast-data" / "databases"
    assert retrieval.blast.local_database_glob == "*.pin"
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


def test_local_blast_provider_resolves_database_and_parses_hits(tmp_path):
    cfg = MCPServerConfig()
    cfg.retrieval.provider = "local_blast"
    cfg.retrieval.feature_flags.enabled = True
    cfg.retrieval.blast.local_blast_binary = "blastp-local"
    cfg.retrieval.blast.local_database_dir = str(tmp_path / "blastdb")
    cfg.retrieval.blast.local_database_glob = "*.pin"
    cfg.retrieval.blast.default_database = "swissprot_local"
    db_dir = Path(cfg.retrieval.blast.local_database_dir)
    db_dir.mkdir(parents=True, exist_ok=True)
    (db_dir / "swissprot_local.pin").write_text("", encoding="utf-8")

    captured: Dict[str, object] = {}

    def runner(command: List[str], fasta_query: str, timeout_seconds: float):
        captured["command"] = list(command)
        captured["fasta_query"] = fasta_query
        captured["timeout_seconds"] = timeout_seconds
        return subprocess.CompletedProcess(command, 0, MOCK_BLAST_XML, "")

    provider = LocalBlastProvider(config=cfg.retrieval, command_runner=runner)
    query = build_query_from_config(TEST_FASTA_QUERY, cfg.retrieval)
    submission = asyncio.run(provider.submit(query))
    result = asyncio.run(provider.collect_results(query, submission))

    assert result.provider_name == "local_blast"
    assert len(result.hits) == 1
    assert captured["command"][0] == "blastp-local"
    assert "-db" in captured["command"]
    db_arg_index = captured["command"].index("-db") + 1
    assert captured["command"][db_arg_index] == str(db_dir / "swissprot_local")
    assert str(captured["fasta_query"]).startswith(">query")


def test_local_blast_provider_fails_when_database_is_missing(tmp_path):
    cfg = MCPServerConfig()
    cfg.retrieval.provider = "local_blast"
    cfg.retrieval.feature_flags.enabled = True
    cfg.retrieval.blast.local_blast_binary = "blastp-local"
    cfg.retrieval.blast.local_database_dir = str(tmp_path / "blastdb")
    cfg.retrieval.blast.default_database = "missing_db"
    Path(cfg.retrieval.blast.local_database_dir).mkdir(parents=True, exist_ok=True)

    def runner(command: List[str], fasta_query: str, timeout_seconds: float):
        raise AssertionError("Local BLAST runner should not be called when database resolution fails")

    provider = LocalBlastProvider(config=cfg.retrieval, command_runner=runner)
    query = build_query_from_config(TEST_FASTA_QUERY, cfg.retrieval)
    submission = asyncio.run(provider.submit(query))
    with pytest.raises(RetrievalConfigError, match="not found"):
        asyncio.run(provider.collect_results(query, submission))


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

    handler, request_counts = _mock_blast_handler()

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

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        if request.method == "POST":
            return httpx.Response(200, text="RID = TEST123\nRTOE = 0\n")
        if params.get("FORMAT_OBJECT") == "SearchInfo":
            return httpx.Response(200, text="Status=READY\nThereAreHits=yes\n")
        if params.get("FORMAT_TYPE") == "XML":
            return httpx.Response(200, text=MOCK_BLAST_XML)
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
    evidence_count = duckdb.execute(
        "SELECT COUNT(*) FROM read_parquet(?)",
        [manifest["manifest"]["parquet_files"]["evidence_documents"]],
    ).fetchone()[0]
    hit_count = duckdb.execute(
        "SELECT COUNT(*) FROM read_parquet(?)",
        [manifest["manifest"]["parquet_files"]["hits"]],
    ).fetchone()[0]
    assert evidence_count == 0
    assert hit_count == 1


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


def test_retrieval_service_imports_parquet_bundle_into_fresh_store(tmp_path):
    source_cfg = MCPServerConfig()
    source_cfg.retrieval.feature_flags.enabled = True
    source_cfg.retrieval.feature_flags.evidence_enrichment = True
    source_cfg.retrieval.feature_flags.export_parquet = True
    source_cfg.retrieval.storage.data_dir = str(tmp_path / "source" / "retrieval")
    source_cfg.retrieval.storage.duckdb_path = str(tmp_path / "source" / "retrieval" / "blast_retrieval.duckdb")
    source_cfg.retrieval.storage.parquet_export_dir = str(tmp_path / "source" / "retrieval" / "parquet")
    source_cfg.retrieval.storage.raw_payload_dir = str(tmp_path / "source" / "retrieval" / "raw_payloads")
    source_cfg.retrieval.storage.manifest_dir = str(tmp_path / "source" / "retrieval" / "manifests")
    handler, _request_counts = _mock_blast_handler()
    source_store = RetrievalStore(source_cfg.retrieval)
    source_service = BlastRetrievalService(
        config=source_cfg.retrieval,
        store=source_store,
        transport=httpx.MockTransport(handler),
        sleeper=lambda _: asyncio.sleep(0),
    )
    source_result = asyncio.run(source_service.retrieve(TEST_FASTA_QUERY))
    manifest_path = source_result.result["dataset_manifests"][0]["manifest"]["manifest_path"]

    target_cfg = MCPServerConfig()
    target_cfg.retrieval.feature_flags.enabled = True
    target_cfg.retrieval.feature_flags.evidence_enrichment = True
    target_cfg.retrieval.feature_flags.export_parquet = False
    target_cfg.retrieval.storage.data_dir = str(tmp_path / "target" / "retrieval")
    target_cfg.retrieval.storage.duckdb_path = str(tmp_path / "target" / "retrieval" / "blast_retrieval.duckdb")
    target_cfg.retrieval.storage.parquet_export_dir = str(tmp_path / "target" / "retrieval" / "parquet")
    target_cfg.retrieval.storage.raw_payload_dir = str(tmp_path / "target" / "retrieval" / "raw_payloads")
    target_cfg.retrieval.storage.manifest_dir = str(tmp_path / "target" / "retrieval" / "manifests")
    target_store = RetrievalStore(target_cfg.retrieval)
    target_service = BlastRetrievalService(config=target_cfg.retrieval, store=target_store)

    imported = target_service.import_parquet_bundle(manifest_path)
    imported_result = imported["result"]

    assert imported["request_id"] == source_result.request_id
    assert imported_result["request_id"] == source_result.request_id
    assert imported_result["status"] == "completed"
    assert imported_result["hits"][0]["accession"] == "ABC123"
    assert imported_result["evidence_documents"][0]["source_id"] == "ABC123"
    assert imported_result["dataset_manifests"][0]["manifest_id"] == f"{source_result.request_id}_parquet"
    cache_entries = target_service.list_cached_requests()
    assert any(entry["request_id"] == source_result.request_id for entry in cache_entries)


def test_retrieval_rest_and_mcp_endpoints_expose_evidence(tmp_path):
    handler, request_counts = _mock_blast_handler()
    server = _configure_and_reset_server_for_retrieval(tmp_path, handler, export_parquet=True)

    async def exercise_server() -> None:
        transport = httpx.ASGITransport(app=server.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            tools_response = await client.get("/mcp/v1/tools")
            assert tools_response.status_code == 200
            tool_names = {tool["name"] for tool in tools_response.json()["tools"]}
            assert {
                "start_blast_retrieval",
                "get_blast_retrieval",
                "export_blast_retrieval_bundle",
                "import_blast_retrieval_bundle",
            } <= tool_names

            create_response = await client.post(
                "/api/retrieval/requests",
                json={"sequence": TEST_FASTA_QUERY, "hitlist_size": 10},
            )
            assert create_response.status_code == 200
            created = create_response.json()
            assert created["status"] == "completed"
            assert created["cached"] is False
            assert created["hit_count"] == 1
            assert created["result"]["evidence_packet"]["document_count"] == 1
            manifest_id = created["result"]["dataset_manifests"][0]["manifest_id"]
            manifest_path = created["result"]["dataset_manifests"][0]["manifest"]["manifest_path"]

            request_id = created["request_id"]
            fetch_response = await client.get(f"/api/retrieval/requests/{request_id}")
            assert fetch_response.status_code == 200
            fetched = fetch_response.json()
            assert fetched["request_id"] == request_id
            assert fetched["result"]["evidence_packet"]["documents"][0]["source_id"] == "ABC123"
            assert fetched["hit_count"] == 1
            assert fetched["evidence_count"] == 1

            cache_response = await client.get("/api/retrieval/cache")
            assert cache_response.status_code == 200
            entries = cache_response.json()["entries"]
            assert len(entries) == 1
            assert entries[0]["request_id"] == request_id
            assert entries[0]["status"] == "completed"
            assert entries[0]["evidence_count"] == 1

            export_response = await client.post(f"/api/retrieval/requests/{request_id}/export")
            assert export_response.status_code == 200
            exported_payload = export_response.json()
            assert exported_payload["request_id"] == request_id
            assert exported_payload["manifest"]["manifest_id"] == manifest_id

            import_response = await client.post("/api/retrieval/import", json={"manifest_path": manifest_path})
            assert import_response.status_code == 200
            imported_payload = import_response.json()
            assert imported_payload["request_id"] == request_id
            assert imported_payload["manifest"]["manifest_id"] == manifest_id
            assert imported_payload["retrieval"]["request_id"] == request_id
            assert imported_payload["retrieval"]["hit_count"] == 1

            resources_response = await client.get("/mcp/v1/resources")
            assert resources_response.status_code == 200
            resource_uris = {resource["uri"] for resource in resources_response.json()["resources"]}
            assert f"retrieval://{request_id}" in resource_uris
            assert f"retrieval-manifest://{manifest_id}" in resource_uris

            start_tool_response = await client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "start_blast_retrieval",
                        "arguments": {"sequence": TEST_FASTA_QUERY, "hitlist_size": 10},
                    },
                },
            )
            assert start_tool_response.status_code == 200
            start_tool_result = start_tool_response.json()["result"]
            start_tool_payload = json.loads(start_tool_result["content"][0]["text"])
            assert start_tool_payload["request_id"] == request_id
            assert start_tool_payload["cached"] is True

            get_tool_response = await client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "get_blast_retrieval",
                        "arguments": {"request_id": request_id},
                    },
                },
            )
            assert get_tool_response.status_code == 200
            get_tool_result = get_tool_response.json()["result"]
            get_tool_payload = json.loads(get_tool_result["content"][0]["text"])
            assert get_tool_payload["request_id"] == request_id
            assert get_tool_payload["result"]["evidence_packet"]["document_count"] == 1

            export_tool_response = await client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "export_blast_retrieval_bundle",
                        "arguments": {"request_id": request_id},
                    },
                },
            )
            assert export_tool_response.status_code == 200
            export_tool_payload = json.loads(export_tool_response.json()["result"]["content"][0]["text"])
            assert export_tool_payload["request_id"] == request_id
            assert export_tool_payload["manifest"]["manifest_id"] == manifest_id

            import_tool_response = await client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {
                        "name": "import_blast_retrieval_bundle",
                        "arguments": {"manifest_path": manifest_path},
                    },
                },
            )
            assert import_tool_response.status_code == 200
            import_tool_payload = json.loads(import_tool_response.json()["result"]["content"][0]["text"])
            assert import_tool_payload["request_id"] == request_id
            assert import_tool_payload["manifest"]["manifest_id"] == manifest_id
            assert import_tool_payload["retrieval"]["request_id"] == request_id

            resource_read_response = await client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 6,
                    "method": "resources/read",
                    "params": {"uri": f"retrieval://{request_id}"},
                },
            )
            assert resource_read_response.status_code == 200
            resource_contents = resource_read_response.json()["result"]["contents"]
            resource_payload = json.loads(resource_contents[0]["text"])
            assert resource_payload["request_id"] == request_id
            assert resource_payload["result"]["evidence_packet"]["document_count"] == 1

            manifest_read_response = await client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "resources/read",
                    "params": {"uri": f"retrieval-manifest://{manifest_id}"},
                },
            )
            assert manifest_read_response.status_code == 200
            manifest_contents = manifest_read_response.json()["result"]["contents"]
            manifest_payload = json.loads(manifest_contents[0]["text"])
            assert manifest_payload["manifest_id"] == manifest_id
            assert manifest_payload["request_id"] == request_id
            assert Path(manifest_payload["manifest"]["parquet_files"]["hits"]).is_file() is True

    asyncio.run(exercise_server())
    assert request_counts == {"submit": 1, "search_info": 2, "result": 1}


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


def test_job_creation_accepts_grounding_inputs(tmp_path):
    handler, _ = _mock_blast_handler()
    server = _configure_and_reset_server_for_retrieval(tmp_path, handler, export_parquet=False)

    async def exercise_server() -> None:
        server.jobs_db.clear()
        transport = httpx.ASGITransport(app=server.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/api/jobs",
                json={
                    "sequence": TEST_FASTA_QUERY,
                    "num_designs": 1,
                    "ground_with_blast_evidence": True,
                    "retrieval_program": "blastp",
                    "retrieval_database": "swissprot",
                    "retrieval_hitlist_size": 10,
                },
            )
            assert response.status_code == 200
            payload = response.json()
            assert payload["input"]["ground_with_blast_evidence"] is True
            assert payload["input"]["retrieval"]["program"] == "blastp"
            assert payload["input"]["retrieval"]["database"] == "swissprot"
            assert payload["input"]["retrieval"]["hitlist_size"] == 10
            assert payload["retrieval"]["requested"] is True

    asyncio.run(exercise_server())
