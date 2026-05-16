#!/usr/bin/env python3
"""DuckDB-backed BLAST retrieval schema bootstrap, persistence, and cache lookup."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Iterable, List, Optional

import duckdb

from runtime_config import RetrievalConfig

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 2

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
    CREATE TABLE IF NOT EXISTS blast_alignments (
        run_id VARCHAR NOT NULL,
        hit_rank INTEGER NOT NULL,
        hsp_index INTEGER NOT NULL,
        query_from_pos INTEGER,
        query_to_pos INTEGER,
        subject_from_pos INTEGER,
        subject_to_pos INTEGER,
        alignment_length INTEGER,
        identity_count INTEGER,
        positive_count INTEGER,
        gap_count INTEGER,
        query_sequence TEXT,
        subject_sequence TEXT,
        midline TEXT,
        raw_alignment_json TEXT,
        PRIMARY KEY (run_id, hit_rank, hsp_index)
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


def _row_to_dict(columns: List[str], row: Iterable[Any]) -> Dict[str, Any]:
    return {column: value for column, value in zip(columns, row)}


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

    def _connect(self, *, read_only: bool = False) -> duckdb.DuckDBPyConnection:
        self._ensure_parent_dirs()
        return duckdb.connect(str(self._duckdb_path()), read_only=read_only)

    def ensure_schema(self) -> None:
        with self._lock:
            with self._connect() as conn:
                for statement in SCHEMA_STATEMENTS:
                    conn.execute(statement)
                conn.execute(
                    """
                    INSERT INTO schema_migrations (version, description, applied_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT DO NOTHING
                    """,
                    [SCHEMA_VERSION, "BLAST retrieval schema with hits and alignments", _utcnow()],
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

    def create_request(
        self,
        *,
        request_id: str,
        cache_key: str,
        provider: str,
        query_sequence: str,
        normalized_sequence: str,
        request_params: Dict[str, Any],
        status: str,
    ) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO retrieval_requests (
                        request_id, cache_key, provider, query_sequence, normalized_sequence,
                        request_params_json, requested_at, status, error_text
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    [
                        request_id,
                        cache_key,
                        provider,
                        query_sequence,
                        normalized_sequence,
                        json.dumps(request_params, sort_keys=True),
                        _utcnow(),
                        status,
                    ],
                )

    def update_request_status(self, request_id: str, status: str, *, error_text: Optional[str] = None) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE retrieval_requests SET status = ?, error_text = ? WHERE request_id = ?",
                    [status, error_text, request_id],
                )

    def create_run(
        self,
        *,
        run_id: str,
        request_id: str,
        provider: str,
        remote_request_id: Optional[str],
        remote_queue_hint_seconds: Optional[float],
    ) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO retrieval_runs (
                        run_id, request_id, provider, remote_request_id, remote_queue_hint_seconds,
                        submitted_at, last_polled_at, completed_at, raw_payload_json, raw_payload_path
                    )
                    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
                    """,
                    [
                        run_id,
                        request_id,
                        provider,
                        remote_request_id,
                        remote_queue_hint_seconds,
                        _utcnow(),
                    ],
                )

    def update_run_poll_timestamp(self, run_id: str) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE retrieval_runs SET last_polled_at = ? WHERE run_id = ?",
                    [_utcnow(), run_id],
                )

    def complete_run(
        self,
        run_id: str,
        *,
        raw_payload_json: Optional[str],
        raw_payload_path: Optional[str],
    ) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    UPDATE retrieval_runs
                    SET completed_at = ?, last_polled_at = ?, raw_payload_json = ?, raw_payload_path = ?
                    WHERE run_id = ?
                    """,
                    [_utcnow(), _utcnow(), raw_payload_json, raw_payload_path, run_id],
                )

    def replace_hits(self, run_id: str, hits: List[Dict[str, Any]]) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM blast_hits WHERE run_id = ?", [run_id])
                for hit in hits:
                    conn.execute(
                        """
                        INSERT INTO blast_hits (
                            run_id, hit_rank, accession, title, organism, e_value, bit_score,
                            identity_fraction, positives_fraction, query_coverage, subject_coverage,
                            alignment_length, subject_length, raw_hit_json
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        [
                            run_id,
                            hit["hit_rank"],
                            hit.get("accession"),
                            hit.get("title"),
                            hit.get("organism"),
                            hit.get("e_value"),
                            hit.get("bit_score"),
                            hit.get("identity_fraction"),
                            hit.get("positives_fraction"),
                            hit.get("query_coverage"),
                            hit.get("subject_coverage"),
                            hit.get("alignment_length"),
                            hit.get("subject_length"),
                            json.dumps(hit.get("raw_hit", {}), sort_keys=True),
                        ],
                    )

    def replace_alignments(self, run_id: str, alignments: List[Dict[str, Any]]) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM blast_alignments WHERE run_id = ?", [run_id])
                for alignment in alignments:
                    conn.execute(
                        """
                        INSERT INTO blast_alignments (
                            run_id, hit_rank, hsp_index, query_from_pos, query_to_pos,
                            subject_from_pos, subject_to_pos, alignment_length, identity_count,
                            positive_count, gap_count, query_sequence, subject_sequence, midline,
                            raw_alignment_json
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        [
                            run_id,
                            alignment["hit_rank"],
                            alignment["hsp_index"],
                            alignment.get("query_from_pos"),
                            alignment.get("query_to_pos"),
                            alignment.get("subject_from_pos"),
                            alignment.get("subject_to_pos"),
                            alignment.get("alignment_length"),
                            alignment.get("identity_count"),
                            alignment.get("positive_count"),
                            alignment.get("gap_count"),
                            alignment.get("query_sequence"),
                            alignment.get("subject_sequence"),
                            alignment.get("midline"),
                            json.dumps(alignment.get("raw_alignment", {}), sort_keys=True),
                        ],
                    )

    def upsert_cache_entry(
        self,
        *,
        cache_key: str,
        request_id: str,
        provider: str,
        hit_count: int,
        storage_path: Optional[str],
    ) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO retrieval_cache_entries (
                        cache_key, request_id, provider, hit_count, storage_path, created_at, expires_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT (cache_key) DO UPDATE SET
                        request_id = excluded.request_id,
                        provider = excluded.provider,
                        hit_count = excluded.hit_count,
                        storage_path = excluded.storage_path,
                        created_at = excluded.created_at
                    """,
                    [cache_key, request_id, provider, hit_count, storage_path, _utcnow()],
                )

    def write_raw_payload(self, run_id: str, payload_text: str) -> str:
        with self._lock:
            self._ensure_parent_dirs()
            payload_path = Path(self.config.storage.raw_payload_dir).expanduser() / f"{run_id}.xml"
            payload_path.write_text(payload_text, encoding="utf-8")
            return str(payload_path)

    def get_cached_result(self, cache_key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            with self._connect(read_only=True) as conn:
                cache_row = conn.execute(
                    """
                    SELECT cache_key, request_id, provider, hit_count, storage_path, created_at, expires_at
                    FROM retrieval_cache_entries
                    WHERE cache_key = ?
                    """,
                    [cache_key],
                ).fetchone()
                if not cache_row:
                    return None
                request_id = cache_row[1]
        return self.get_request_result(request_id)

    def get_request_result(self, request_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            with self._connect(read_only=True) as conn:
                request_cur = conn.execute(
                    """
                    SELECT request_id, cache_key, provider, query_sequence, normalized_sequence,
                           request_params_json, requested_at, status, error_text
                    FROM retrieval_requests
                    WHERE request_id = ?
                    """,
                    [request_id],
                )
                request_row = request_cur.fetchone()
                if not request_row:
                    return None
                request_cols = [desc[0] for desc in request_cur.description]
                request_data = _row_to_dict(request_cols, request_row)
                if isinstance(request_data.get("request_params_json"), str):
                    request_data["request_params"] = json.loads(request_data.pop("request_params_json"))

                runs_cur = conn.execute(
                    """
                    SELECT run_id, request_id, provider, remote_request_id, remote_queue_hint_seconds,
                           submitted_at, last_polled_at, completed_at, raw_payload_json, raw_payload_path
                    FROM retrieval_runs
                    WHERE request_id = ?
                    ORDER BY submitted_at ASC
                    """,
                    [request_id],
                )
                run_cols = [desc[0] for desc in runs_cur.description]
                runs = [_row_to_dict(run_cols, row) for row in runs_cur.fetchall()]
                if not runs:
                    return {**request_data, "runs": [], "hits": [], "alignments": []}

                latest_run_id = runs[-1]["run_id"]
                hits_cur = conn.execute(
                    """
                    SELECT run_id, hit_rank, accession, title, organism, e_value, bit_score,
                           identity_fraction, positives_fraction, query_coverage, subject_coverage,
                           alignment_length, subject_length, raw_hit_json
                    FROM blast_hits
                    WHERE run_id = ?
                    ORDER BY hit_rank ASC
                    """,
                    [latest_run_id],
                )
                hit_cols = [desc[0] for desc in hits_cur.description]
                hits = [_row_to_dict(hit_cols, row) for row in hits_cur.fetchall()]
                for hit in hits:
                    if isinstance(hit.get("raw_hit_json"), str):
                        hit["raw_hit"] = json.loads(hit.pop("raw_hit_json"))

                align_cur = conn.execute(
                    """
                    SELECT run_id, hit_rank, hsp_index, query_from_pos, query_to_pos,
                           subject_from_pos, subject_to_pos, alignment_length, identity_count,
                           positive_count, gap_count, query_sequence, subject_sequence, midline,
                           raw_alignment_json
                    FROM blast_alignments
                    WHERE run_id = ?
                    ORDER BY hit_rank ASC, hsp_index ASC
                    """,
                    [latest_run_id],
                )
                align_cols = [desc[0] for desc in align_cur.description]
                alignments = [_row_to_dict(align_cols, row) for row in align_cur.fetchall()]
                for alignment in alignments:
                    if isinstance(alignment.get("raw_alignment_json"), str):
                        alignment["raw_alignment"] = json.loads(alignment.pop("raw_alignment_json"))

                return {**request_data, "runs": runs, "hits": hits, "alignments": alignments}

    def schema_tables(self) -> set[str]:
        with self._lock:
            if not self._duckdb_path().exists():
                return set()
            with self._connect(read_only=True) as conn:
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
            with self._connect(read_only=True) as conn:
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
