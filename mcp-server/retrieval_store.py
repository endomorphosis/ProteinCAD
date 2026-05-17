#!/usr/bin/env python3
"""DuckDB-backed BLAST retrieval schema bootstrap, persistence, and cache lookup."""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Iterable, List, Optional

import duckdb

from runtime_config import RetrievalConfig

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 4

SCHEMA_STATEMENTS = (
    # Latest schema definition for fresh databases.
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
    CREATE TABLE IF NOT EXISTS protein_annotations (
        request_id VARCHAR NOT NULL,
        run_id VARCHAR NOT NULL,
        hit_rank INTEGER NOT NULL,
        source_system VARCHAR NOT NULL,
        source_id VARCHAR NOT NULL,
        accession VARCHAR,
        title TEXT,
        organism VARCHAR,
        annotation_json TEXT,
        retrieved_at TIMESTAMP NOT NULL,
        transform_version VARCHAR NOT NULL,
        PRIMARY KEY (request_id, hit_rank)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS evidence_documents (
        evidence_id VARCHAR PRIMARY KEY,
        request_id VARCHAR NOT NULL,
        run_id VARCHAR,
        hit_rank INTEGER,
        source_system VARCHAR,
        source_id VARCHAR,
        title TEXT,
        content_text TEXT,
        content_json TEXT,
        transform_version VARCHAR,
        manifest_id VARCHAR,
        retrieved_at TIMESTAMP,
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
        request_id VARCHAR,
        run_id VARCHAR,
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

MIGRATION_STATEMENTS = (
    # Schema version 2 -> 3 upgrade path for databases where evidence_documents already existed.
    # Historical rows may retain NULL provenance fields until they are re-enriched and rewritten.
    "ALTER TABLE evidence_documents ADD COLUMN IF NOT EXISTS run_id VARCHAR",
    "ALTER TABLE evidence_documents ADD COLUMN IF NOT EXISTS hit_rank INTEGER",
    "ALTER TABLE evidence_documents ADD COLUMN IF NOT EXISTS source_system VARCHAR",
    "ALTER TABLE evidence_documents ADD COLUMN IF NOT EXISTS source_id VARCHAR",
    "ALTER TABLE evidence_documents ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMP",
    "ALTER TABLE dataset_manifests ADD COLUMN IF NOT EXISTS request_id VARCHAR",
    "ALTER TABLE dataset_manifests ADD COLUMN IF NOT EXISTS run_id VARCHAR",
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

    def _connect(self, *, read_only: bool = False) -> duckdb.DuckDBPyConnection:
        if not read_only:
            self._ensure_parent_dirs()
        return duckdb.connect(str(self._duckdb_path()), read_only=read_only)

    def _row_to_dict(self, columns: List[str], row: Iterable[Any]) -> Dict[str, Any]:
        return dict(zip(columns, row))

    def ensure_schema(self) -> None:
        with self._lock:
            with self._connect() as conn:
                for statement in SCHEMA_STATEMENTS:
                    conn.execute(statement)
                for statement in MIGRATION_STATEMENTS:
                    conn.execute(statement)
                conn.execute(
                    """
                    INSERT INTO schema_migrations (version, description, applied_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT DO NOTHING
                    """,
                    [SCHEMA_VERSION, "BLAST retrieval schema with evidence enrichment and parquet exports", _utcnow()],
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

    def replace_annotations(self, request_id: str, annotations: List[Dict[str, Any]]) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM protein_annotations WHERE request_id = ?", [request_id])
                for annotation in annotations:
                    conn.execute(
                        """
                        INSERT INTO protein_annotations (
                            request_id, run_id, hit_rank, source_system, source_id, accession, title,
                            organism, annotation_json, retrieved_at, transform_version
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        [
                            request_id,
                            annotation["run_id"],
                            annotation["hit_rank"],
                            annotation["source_system"],
                            annotation["source_id"],
                            annotation.get("accession"),
                            annotation.get("title"),
                            annotation.get("organism"),
                            json.dumps(annotation.get("annotation", {}), sort_keys=True),
                            annotation["retrieved_at"],
                            annotation["transform_version"],
                        ],
                    )

    def replace_evidence_documents(self, request_id: str, evidence_documents: List[Dict[str, Any]]) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM evidence_documents WHERE request_id = ?", [request_id])
                for evidence_document in evidence_documents:
                    conn.execute(
                        """
                        INSERT INTO evidence_documents (
                            evidence_id, request_id, run_id, hit_rank, source_system, source_id, title,
                            content_text, content_json, transform_version, manifest_id, retrieved_at, created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        [
                            evidence_document["evidence_id"],
                            request_id,
                            evidence_document["run_id"],
                            evidence_document.get("hit_rank"),
                            evidence_document["source_system"],
                            evidence_document["source_id"],
                            evidence_document.get("title"),
                            evidence_document.get("content_text"),
                            json.dumps(evidence_document.get("content", {}), sort_keys=True),
                            evidence_document.get("transform_version"),
                            evidence_document.get("manifest_id"),
                            evidence_document.get("retrieved_at"),
                            evidence_document["created_at"],
                        ],
                    )

    def upsert_dataset_manifest(
        self,
        *,
        manifest_id: str,
        request_id: str,
        run_id: Optional[str],
        provider: str,
        source_system: str,
        transform_version: str,
        parquet_path: str,
        raw_payload_dir: str,
        manifest_json: str,
    ) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO dataset_manifests (
                        manifest_id, request_id, run_id, provider, source_system, transform_version, parquet_path,
                        raw_payload_dir, manifest_json, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (manifest_id) DO UPDATE SET
                        request_id = excluded.request_id,
                        run_id = excluded.run_id,
                        provider = excluded.provider,
                        source_system = excluded.source_system,
                        transform_version = excluded.transform_version,
                        parquet_path = excluded.parquet_path,
                        raw_payload_dir = excluded.raw_payload_dir,
                        manifest_json = excluded.manifest_json,
                        created_at = excluded.created_at
                    """,
                    [
                        manifest_id,
                        request_id,
                        run_id,
                        provider,
                        source_system,
                        transform_version,
                        parquet_path,
                        raw_payload_dir,
                        manifest_json,
                        _utcnow(),
                    ],
                )

    def export_request_parquet_bundle(
        self,
        *,
        request_id: str,
        run_id: Optional[str],
        provider: str,
        source_system: str,
        transform_version: str,
    ) -> Dict[str, Any]:
        manifest_id = f"{request_id}_parquet"
        bundle_root = Path(self.config.storage.parquet_export_dir).expanduser()
        bundle_dir = bundle_root / request_id
        manifest_path = Path(self.config.storage.manifest_dir).expanduser() / f"{manifest_id}.json"
        temp_manifest_path = manifest_path.with_suffix(".tmp.json")
        self._ensure_parent_dirs()
        temp_bundle_dir: Optional[Path] = None
        temp_bundle_dir = Path(
            tempfile.mkdtemp(prefix="parquet-export-", dir=str(bundle_root))
        )

        parquet_files = {
            "request": str(temp_bundle_dir / "request.parquet"),
            "runs": str(temp_bundle_dir / "runs.parquet"),
            "hits": str(temp_bundle_dir / "hits.parquet"),
            "alignments": str(temp_bundle_dir / "alignments.parquet"),
            "annotations": str(temp_bundle_dir / "annotations.parquet"),
            "evidence_documents": str(temp_bundle_dir / "evidence_documents.parquet"),
        }

        try:
            with self._lock:
                with self._connect() as conn:
                    conn.execute(
                        "UPDATE evidence_documents SET manifest_id = ? WHERE request_id = ?",
                        [manifest_id, request_id],
                    )
                    conn.execute(
                        """
                        COPY (
                            SELECT request_id, cache_key, provider, query_sequence, normalized_sequence,
                                   request_params_json, requested_at, status, error_text
                            FROM retrieval_requests
                            WHERE request_id = $1
                        ) TO $2 (FORMAT PARQUET)
                        """,
                        [request_id, parquet_files["request"]],
                    )
                    conn.execute(
                        """
                        COPY (
                            SELECT run_id, request_id, provider, remote_request_id, remote_queue_hint_seconds,
                                   submitted_at, last_polled_at, completed_at, raw_payload_json, raw_payload_path
                            FROM retrieval_runs
                            WHERE request_id = $1
                            ORDER BY submitted_at ASC
                        ) TO $2 (FORMAT PARQUET)
                        """,
                        [request_id, parquet_files["runs"]],
                    )
                    conn.execute(
                        """
                        COPY (
                            SELECT h.run_id, h.hit_rank, h.accession, h.title, h.organism, h.e_value, h.bit_score,
                                   h.identity_fraction, h.positives_fraction, h.query_coverage, h.subject_coverage,
                                   h.alignment_length, h.subject_length, h.raw_hit_json
                            FROM blast_hits h
                            INNER JOIN retrieval_runs r ON r.run_id = h.run_id
                            WHERE r.request_id = $1
                            ORDER BY h.run_id ASC, h.hit_rank ASC
                        ) TO $2 (FORMAT PARQUET)
                        """,
                        [request_id, parquet_files["hits"]],
                    )
                    conn.execute(
                        """
                        COPY (
                            SELECT a.run_id, a.hit_rank, a.hsp_index, a.query_from_pos, a.query_to_pos,
                                   a.subject_from_pos, a.subject_to_pos, a.alignment_length, a.identity_count,
                                   a.positive_count, a.gap_count, a.query_sequence, a.subject_sequence, a.midline,
                                   a.raw_alignment_json
                            FROM blast_alignments a
                            INNER JOIN retrieval_runs r ON r.run_id = a.run_id
                            WHERE r.request_id = $1
                            ORDER BY a.run_id ASC, a.hit_rank ASC, a.hsp_index ASC
                        ) TO $2 (FORMAT PARQUET)
                        """,
                        [request_id, parquet_files["alignments"]],
                    )
                    conn.execute(
                        """
                        COPY (
                            SELECT request_id, run_id, hit_rank, source_system, source_id, accession, title,
                                   organism, annotation_json, retrieved_at, transform_version
                            FROM protein_annotations
                            WHERE request_id = $1
                            ORDER BY hit_rank ASC
                        ) TO $2 (FORMAT PARQUET)
                        """,
                        [request_id, parquet_files["annotations"]],
                    )
                    conn.execute(
                        """
                        COPY (
                            SELECT evidence_id, request_id, run_id, hit_rank, source_system, source_id, title,
                                   content_text, content_json, transform_version, manifest_id, retrieved_at, created_at
                            FROM evidence_documents
                            WHERE request_id = $1
                            ORDER BY hit_rank ASC NULLS LAST, created_at ASC NULLS LAST
                        ) TO $2 (FORMAT PARQUET)
                        """,
                        [request_id, parquet_files["evidence_documents"]],
                    )
                    count_row = conn.execute(
                        """
                        SELECT
                            (SELECT COUNT(*) FROM retrieval_runs WHERE request_id = ?) AS run_count,
                            (SELECT COUNT(*) FROM blast_hits h INNER JOIN retrieval_runs r ON r.run_id = h.run_id WHERE r.request_id = ?) AS hit_count,
                            (SELECT COUNT(*) FROM blast_alignments a INNER JOIN retrieval_runs r ON r.run_id = a.run_id WHERE r.request_id = ?) AS alignment_count,
                            (SELECT COUNT(*) FROM protein_annotations WHERE request_id = ?) AS annotation_count,
                            (SELECT COUNT(*) FROM evidence_documents WHERE request_id = ?) AS evidence_count
                        """,
                        [request_id, request_id, request_id, request_id, request_id],
                    ).fetchone()
        except Exception:
            if temp_bundle_dir and temp_bundle_dir.exists():
                shutil.rmtree(temp_bundle_dir)
            if temp_manifest_path.exists():
                temp_manifest_path.unlink()
            raise

        manifest = {
            "manifest_id": manifest_id,
            "request_id": request_id,
            "run_id": run_id,
            "provider": provider,
            "source_system": source_system,
            "transform_version": transform_version,
            "parquet_path": str(bundle_dir),
            "raw_payload_dir": self.config.storage.raw_payload_dir,
            "manifest_path": str(manifest_path),
            "parquet_files": {
                name: str(bundle_dir / Path(path).name)
                for name, path in parquet_files.items()
            },
            "run_count": int(count_row[0] or 0),
            "hit_count": int(count_row[1] or 0),
            "alignment_count": int(count_row[2] or 0),
            "annotation_count": int(count_row[3] or 0),
            "evidence_count": int(count_row[4] or 0),
            "created_at": _utcnow().isoformat(),
        }
        manifest_json = json.dumps(manifest, sort_keys=True)
        temp_manifest_path.write_text(manifest_json, encoding="utf-8")
        if bundle_dir.exists():
            shutil.rmtree(bundle_dir)
        temp_bundle_dir.replace(bundle_dir)
        temp_manifest_path.replace(manifest_path)
        self.upsert_dataset_manifest(
            manifest_id=manifest_id,
            request_id=request_id,
            run_id=run_id,
            provider=provider,
            source_system=source_system,
            transform_version=transform_version,
            parquet_path=str(bundle_dir),
            raw_payload_dir=self.config.storage.raw_payload_dir,
            manifest_json=manifest_json,
        )
        return manifest

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
                request_data = self._row_to_dict(request_cols, request_row)
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
                runs = [self._row_to_dict(run_cols, row) for row in runs_cur.fetchall()]
                if not runs:
                    return {
                        **request_data,
                        "runs": [],
                        "hits": [],
                        "alignments": [],
                        "annotations": [],
                        "evidence_documents": [],
                        "dataset_manifests": [],
                    }

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
                hits = [self._row_to_dict(hit_cols, row) for row in hits_cur.fetchall()]
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
                alignments = [self._row_to_dict(align_cols, row) for row in align_cur.fetchall()]
                for alignment in alignments:
                    if isinstance(alignment.get("raw_alignment_json"), str):
                        alignment["raw_alignment"] = json.loads(alignment.pop("raw_alignment_json"))

                annotation_cur = conn.execute(
                    """
                    SELECT request_id, run_id, hit_rank, source_system, source_id, accession, title,
                           organism, annotation_json, retrieved_at, transform_version
                    FROM protein_annotations
                    WHERE request_id = ?
                    ORDER BY hit_rank ASC
                    """,
                    [request_id],
                )
                annotation_cols = [desc[0] for desc in annotation_cur.description]
                annotations = [self._row_to_dict(annotation_cols, row) for row in annotation_cur.fetchall()]
                for annotation in annotations:
                    if isinstance(annotation.get("annotation_json"), str):
                        annotation["annotation"] = json.loads(annotation.pop("annotation_json"))

                evidence_cur = conn.execute(
                    """
                    SELECT evidence_id, request_id, run_id, hit_rank, source_system, source_id, title,
                           content_text, content_json, transform_version, manifest_id, retrieved_at, created_at
                    FROM evidence_documents
                    WHERE request_id = ?
                    ORDER BY hit_rank ASC NULLS LAST, created_at ASC NULLS LAST
                    """,
                    [request_id],
                )
                evidence_cols = [desc[0] for desc in evidence_cur.description]
                evidence_documents = [self._row_to_dict(evidence_cols, row) for row in evidence_cur.fetchall()]
                for evidence_document in evidence_documents:
                    if isinstance(evidence_document.get("content_json"), str):
                        evidence_document["content"] = json.loads(evidence_document.pop("content_json"))

                manifest_cur = conn.execute(
                    """
                    SELECT manifest_id, request_id, run_id, provider, source_system, transform_version, parquet_path,
                           raw_payload_dir, manifest_json, created_at
                    FROM dataset_manifests
                    WHERE request_id = ?
                    ORDER BY created_at ASC
                    """,
                    [request_id],
                )
                manifest_cols = [desc[0] for desc in manifest_cur.description]
                dataset_manifests = [self._row_to_dict(manifest_cols, row) for row in manifest_cur.fetchall()]
                for manifest in dataset_manifests:
                    if isinstance(manifest.get("manifest_json"), str):
                        manifest["manifest"] = json.loads(manifest.pop("manifest_json"))

                return {
                    **request_data,
                    "runs": runs,
                    "hits": hits,
                    "alignments": alignments,
                    "annotations": annotations,
                    "evidence_documents": evidence_documents,
                    "dataset_manifests": dataset_manifests,
                }

    def list_cached_requests(self, *, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            if not self._duckdb_path().exists():
                return []
            with self._connect(read_only=True) as conn:
                cur = conn.execute(
                    """
                    SELECT
                        c.cache_key,
                        c.request_id,
                        c.provider,
                        c.hit_count,
                        c.storage_path,
                        c.created_at,
                        c.expires_at,
                        r.status,
                        r.requested_at,
                        (
                            SELECT COUNT(*)
                            FROM protein_annotations a
                            WHERE a.request_id = c.request_id
                        ) AS annotation_count,
                        (
                            SELECT COUNT(*)
                            FROM evidence_documents e
                            WHERE e.request_id = c.request_id
                        ) AS evidence_count,
                        (
                            SELECT COUNT(*)
                            FROM dataset_manifests m
                            WHERE m.request_id = c.request_id
                        ) AS manifest_count,
                        (
                            SELECT run_id
                            FROM retrieval_runs rr
                            WHERE rr.request_id = c.request_id
                            ORDER BY submitted_at DESC
                            LIMIT 1
                        ) AS latest_run_id,
                        (
                            SELECT completed_at
                            FROM retrieval_runs rr
                            WHERE rr.request_id = c.request_id
                            ORDER BY submitted_at DESC
                            LIMIT 1
                        ) AS latest_completed_at
                    FROM retrieval_cache_entries c
                    INNER JOIN retrieval_requests r ON r.request_id = c.request_id
                    ORDER BY c.created_at DESC
                    LIMIT ?
                    """,
                    [max(1, limit)],
                )
                columns = [desc[0] for desc in cur.description]
                return [self._row_to_dict(columns, row) for row in cur.fetchall()]

    def get_dataset_manifest(self, manifest_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            if not self._duckdb_path().exists():
                return None
            with self._connect(read_only=True) as conn:
                cur = conn.execute(
                    """
                    SELECT manifest_id, request_id, run_id, provider, source_system, transform_version, parquet_path,
                           raw_payload_dir, manifest_json, created_at
                    FROM dataset_manifests
                    WHERE manifest_id = ?
                    """,
                    [manifest_id],
                )
                row = cur.fetchone()
                if not row:
                    return None
                columns = [desc[0] for desc in cur.description]
                manifest = self._row_to_dict(columns, row)
                if isinstance(manifest.get("manifest_json"), str):
                    manifest["manifest"] = json.loads(manifest.pop("manifest_json"))
                return manifest

    def list_dataset_manifests(self, *, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            if not self._duckdb_path().exists():
                return []
            with self._connect(read_only=True) as conn:
                cur = conn.execute(
                    """
                    SELECT manifest_id, request_id, run_id, provider, source_system, transform_version, parquet_path,
                           raw_payload_dir, manifest_json, created_at
                    FROM dataset_manifests
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    [max(1, limit)],
                )
                columns = [desc[0] for desc in cur.description]
                manifests = [self._row_to_dict(columns, row) for row in cur.fetchall()]
                for manifest in manifests:
                    if isinstance(manifest.get("manifest_json"), str):
                        manifest["manifest"] = json.loads(manifest.pop("manifest_json"))
                return manifests

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
