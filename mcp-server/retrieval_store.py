#!/usr/bin/env python3
"""DuckDB-backed BLAST retrieval schema bootstrap and diagnostics."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Optional

import duckdb

from runtime_config import RetrievalConfig

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMP NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS retrieval_requests (
        request_id VARCHAR PRIMARY KEY,
        cache_key VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        query_sequence TEXT NOT NULL,
        normalized_sequence TEXT NOT NULL,
        request_params_json TEXT,
        requested_at TIMESTAMP NOT NULL,
        status VARCHAR NOT NULL,
        error_text TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS retrieval_runs (
        run_id VARCHAR PRIMARY KEY,
        request_id VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        remote_request_id VARCHAR,
        remote_queue_hint_seconds DOUBLE,
        submitted_at TIMESTAMP NOT NULL,
        last_polled_at TIMESTAMP,
        completed_at TIMESTAMP,
        raw_payload_json TEXT,
        raw_payload_path VARCHAR
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS blast_hits (
        run_id VARCHAR NOT NULL,
        hit_rank INTEGER NOT NULL,
        accession VARCHAR,
        title TEXT,
        organism VARCHAR,
        e_value DOUBLE,
        bit_score DOUBLE,
        identity_fraction DOUBLE,
        positives_fraction DOUBLE,
        query_coverage DOUBLE,
        subject_coverage DOUBLE,
        alignment_length INTEGER,
        subject_length INTEGER,
        raw_hit_json TEXT,
        PRIMARY KEY (run_id, hit_rank)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS evidence_documents (
        evidence_id VARCHAR PRIMARY KEY,
        request_id VARCHAR NOT NULL,
        source_kind VARCHAR NOT NULL,
        source_identifier VARCHAR NOT NULL,
        title TEXT,
        content_text TEXT,
        content_json TEXT,
        transform_version VARCHAR,
        manifest_id VARCHAR,
        created_at TIMESTAMP NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS retrieval_cache_entries (
        cache_key VARCHAR PRIMARY KEY,
        request_id VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        hit_count INTEGER DEFAULT 0,
        storage_path VARCHAR,
        created_at TIMESTAMP NOT NULL,
        expires_at TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS dataset_manifests (
        manifest_id VARCHAR PRIMARY KEY,
        provider VARCHAR NOT NULL,
        source_system VARCHAR NOT NULL,
        transform_version VARCHAR NOT NULL,
        parquet_path VARCHAR,
        raw_payload_dir VARCHAR,
        manifest_json TEXT,
        created_at TIMESTAMP NOT NULL
    )
    """,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class RetrievalStore:
    config: RetrievalConfig
    initialized: bool = False
    last_error: Optional[str] = None
    _lock: Lock = field(default_factory=Lock, init=False, repr=False)

    def _duckdb_path(self) -> Path:
        return Path(self.config.storage.duckdb_path).expanduser()

    def _ensure_parent_dirs(self) -> None:
        for raw_path in (
            self.config.storage.data_dir,
            self.config.storage.parquet_export_dir,
            self.config.storage.raw_payload_dir,
            self.config.storage.manifest_dir,
            str(self._duckdb_path().parent),
        ):
            Path(raw_path).expanduser().mkdir(parents=True, exist_ok=True)

    def ensure_schema(self) -> None:
        with self._lock:
            self._ensure_parent_dirs()
            db_path = self._duckdb_path()
            with duckdb.connect(str(db_path)) as conn:
                for statement in SCHEMA_STATEMENTS:
                    conn.execute(statement)
                conn.execute(
                    """
                    INSERT INTO schema_migrations (version, description, applied_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT DO NOTHING
                    """,
                    [SCHEMA_VERSION, "Initial BLAST retrieval schema bootstrap", _utcnow()],
                )
            self.initialized = True
            self.last_error = None

    def initialize_if_enabled(self) -> Optional[str]:
        with self._lock:
            enabled = self.config.feature_flags.enabled
            create_schema = self.config.feature_flags.create_schema_on_startup
            if not enabled or not create_schema:
                self.initialized = False
                self.last_error = None
                return None
        try:
            self.ensure_schema()
        except Exception as exc:
            with self._lock:
                self.initialized = False
                self.last_error = str(exc)
            logger.warning("BLAST retrieval schema initialization failed: %s", exc)
            return self.last_error
        return None

    def update_config(self, config: RetrievalConfig) -> None:
        with self._lock:
            self.config = config
            self.initialized = False
            self.last_error = None

    def schema_tables(self) -> set[str]:
        with self._lock:
            if not self._duckdb_path().exists():
                return set()
            with duckdb.connect(str(self._duckdb_path()), read_only=True) as conn:
                return {
                    row[0]
                    for row in conn.execute(
                        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"
                    ).fetchall()
                }

    def migration_versions(self) -> list[int]:
        with self._lock:
            if not self._duckdb_path().exists():
                return []
            with duckdb.connect(str(self._duckdb_path()), read_only=True) as conn:
                return [row[0] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()]

    def diagnostics(self) -> Dict[str, Any]:
        return {
            "enabled": self.config.feature_flags.enabled,
            "provider": self.config.provider,
            "schema_initialized": self.initialized,
            "create_schema_on_startup": self.config.feature_flags.create_schema_on_startup,
            "duckdb_path": self.config.storage.duckdb_path,
            "parquet_export_dir": self.config.storage.parquet_export_dir,
            "raw_payload_dir": self.config.storage.raw_payload_dir,
            "manifest_dir": self.config.storage.manifest_dir,
            "last_error": self.last_error,
            "schema_version": SCHEMA_VERSION,
        }
