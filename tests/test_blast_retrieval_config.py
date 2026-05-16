#!/usr/bin/env python3

from pathlib import Path
import sys

import duckdb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp-server"))

from retrieval_store import RetrievalStore
from runtime_config import MCPServerConfig, RuntimeConfigManager


def test_retrieval_defaults_follow_blast_scaffolding(tmp_path, monkeypatch):
    monkeypatch.delenv("MCP_RETRIEVAL_ENABLED", raising=False)
    monkeypatch.delenv("MCP_RETRIEVAL_DATA_DIR", raising=False)
    monkeypatch.delenv("MCP_RETRIEVAL_DUCKDB_PATH", raising=False)
    config_path = tmp_path / "config" / "mcp_config.json"

    manager = RuntimeConfigManager(path=str(config_path))
    retrieval = manager.get().retrieval

    assert retrieval.provider == "ncbi_blast_remote"
    assert retrieval.feature_flags.enabled is False
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

    cfg = MCPServerConfig()
    manager = RuntimeConfigManager(path=str(tmp_path / "config.json"))
    manager.reset_to_defaults()
    retrieval = manager.get().retrieval

    assert cfg.retrieval.provider == "local_blast"
    assert retrieval.feature_flags.enabled is True
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

    with duckdb.connect(cfg.retrieval.storage.duckdb_path) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"
            ).fetchall()
        }
        assert "retrieval_requests" in tables
        assert "blast_hits" in tables
        assert "dataset_manifests" in tables
        migration_rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
        assert migration_rows == [(1,)]
