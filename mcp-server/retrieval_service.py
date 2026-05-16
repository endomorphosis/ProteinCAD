#!/usr/bin/env python3
"""High-level BLAST retrieval orchestration with cache reuse and persistence."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Optional
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx

from retrieval_provider import (
    BlastHit,
    BlastSubmission,
    ProviderExecutionResult,
    RetrievalConfigError,
    RetrievalError,
    build_query_from_config,
    provider_from_config,
    serialize_alignments,
    serialize_hits,
)
from retrieval_store import RetrievalStore
from runtime_config import RetrievalConfig

EVIDENCE_TRANSFORM_VERSION = "blast_evidence_v1"
MAX_EVIDENCE_PACKET_SIZE = 5
# Use a stable namespace so evidence IDs stay deterministic across cache refreshes.
EVIDENCE_UUID_NAMESPACE = NAMESPACE_URL


@dataclass(frozen=True)
class AnnotationRecord:
    run_id: str
    hit_rank: int
    source_system: str
    source_id: str
    accession: Optional[str]
    title: str
    organism: Optional[str]
    annotation: Dict[str, Any]
    retrieved_at: str
    transform_version: str = EVIDENCE_TRANSFORM_VERSION


@dataclass(frozen=True)
class EvidenceDocument:
    evidence_id: str
    run_id: Optional[str]
    hit_rank: Optional[int]
    source_system: Optional[str]
    source_id: Optional[str]
    title: str
    content_text: str
    content: Dict[str, Any]
    transform_version: str
    manifest_id: Optional[str]
    retrieved_at: str
    created_at: str


@dataclass(frozen=True)
class BlastRetrievalResult:
    request_id: str
    run_id: Optional[str]
    cache_key: str
    provider: str
    cached: bool
    status: str
    remote_request_id: Optional[str]
    remote_queue_hint_seconds: Optional[float]
    raw_payload_path: Optional[str]
    hit_count: int
    annotation_count: int
    evidence_count: int
    result: Dict[str, Any]


class BlastRetrievalService:
    def __init__(
        self,
        *,
        config: RetrievalConfig,
        store: RetrievalStore,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        sleeper: Optional[Callable[[float], Awaitable[None]]] = None,
    ) -> None:
        self._config = config
        self._store = store
        self._provider = provider_from_config(config, transport=transport, sleeper=sleeper)

    async def retrieve(
        self,
        sequence: str,
        *,
        program: Optional[str] = None,
        database: Optional[str] = None,
        hitlist_size: Optional[int] = None,
    ) -> BlastRetrievalResult:
        if not self._config.feature_flags.enabled:
            raise RetrievalConfigError("BLAST retrieval is disabled in runtime config")

        self._store.ensure_schema()
        query = build_query_from_config(
            sequence,
            self._config,
            program=program,
            database=database,
            hitlist_size=hitlist_size,
        )
        cache_key = query.cache_key

        cached_result = self._store.get_cached_result(cache_key)
        if cached_result and cached_result.get("status") == "completed":
            latest_run = (cached_result.get("runs") or [{}])[-1]
            cached_result = self._with_evidence_packet(cached_result)
            return BlastRetrievalResult(
                request_id=cached_result["request_id"],
                run_id=latest_run.get("run_id"),
                cache_key=cache_key,
                provider=str(cached_result.get("provider") or self._provider.provider_name),
                cached=True,
                status=str(cached_result.get("status") or "completed"),
                remote_request_id=latest_run.get("remote_request_id"),
                remote_queue_hint_seconds=latest_run.get("remote_queue_hint_seconds"),
                raw_payload_path=latest_run.get("raw_payload_path"),
                hit_count=len(cached_result.get("hits") or []),
                annotation_count=len(cached_result.get("annotations") or []),
                evidence_count=len(cached_result.get("evidence_documents") or []),
                result=cached_result,
            )

        request_id = f"retrieval_{uuid4().hex}"
        run_id: Optional[str] = None
        self._store.create_request(
            request_id=request_id,
            cache_key=cache_key,
            provider=self._provider.provider_name,
            query_sequence=query.sequence,
            normalized_sequence=query.normalized_sequence,
            request_params={
                "program": query.program,
                "database": query.database,
                "hitlist_size": query.hitlist_size,
                "enrichment_profile": query.enrichment_profile,
            },
            status="submitted",
        )

        try:
            run_id = f"run_{uuid4().hex}"
            submission = await self._provider.submit(query)
            self._store.create_run(
                run_id=run_id,
                request_id=request_id,
                provider=self._provider.provider_name,
                remote_request_id=submission.remote_request_id,
                remote_queue_hint_seconds=submission.remote_queue_hint_seconds,
            )
            self._store.update_request_status(request_id, "running")
            provider_result = await self._provider.collect_results(query, submission)
            self._persist_provider_result(request_id, run_id, submission, provider_result)
            result = self._with_evidence_packet(self._store.get_request_result(request_id) or {})
            return BlastRetrievalResult(
                request_id=request_id,
                run_id=run_id,
                cache_key=cache_key,
                provider=self._provider.provider_name,
                cached=False,
                status="completed",
                remote_request_id=provider_result.submission.remote_request_id,
                remote_queue_hint_seconds=provider_result.submission.remote_queue_hint_seconds,
                raw_payload_path=(result.get("runs") or [{}])[-1].get("raw_payload_path"),
                hit_count=len(provider_result.hits),
                annotation_count=len(result.get("annotations") or []),
                evidence_count=len(result.get("evidence_documents") or []),
                result=result,
            )
        except RetrievalError as exc:
            self._store.update_request_status(request_id, "failed", error_text=str(exc))
            result = self._with_evidence_packet(self._store.get_request_result(request_id) or {
                "request_id": request_id,
                "status": "failed",
                "error_text": str(exc),
                "runs": [],
                "hits": [],
                "alignments": [],
                "annotations": [],
                "evidence_documents": [],
            })
            return BlastRetrievalResult(
                request_id=request_id,
                run_id=run_id,
                cache_key=cache_key,
                provider=self._provider.provider_name,
                cached=False,
                status="failed",
                remote_request_id=None,
                remote_queue_hint_seconds=None,
                raw_payload_path=None,
                hit_count=0,
                annotation_count=0,
                evidence_count=0,
                result=result,
            )

    def _with_evidence_packet(self, result: Dict[str, Any]) -> Dict[str, Any]:
        evidence_documents = list(result.get("evidence_documents") or [])
        packet_documents = []
        for evidence_document in evidence_documents[:MAX_EVIDENCE_PACKET_SIZE]:
            packet_documents.append(
                {
                    "evidence_id": evidence_document.get("evidence_id"),
                    "hit_rank": evidence_document.get("hit_rank"),
                    "title": evidence_document.get("title"),
                    "content_text": evidence_document.get("content_text"),
                    "source_system": evidence_document.get("source_system"),
                    "source_id": evidence_document.get("source_id"),
                    "retrieved_at": evidence_document.get("retrieved_at"),
                    "transform_version": evidence_document.get("transform_version"),
                }
            )

        return {
            **result,
            "evidence_packet": {
                "request_id": result.get("request_id"),
                "status": result.get("status"),
                "document_count": len(evidence_documents),
                "documents": packet_documents,
            },
        }

    def _persist_provider_result(
        self,
        request_id: str,
        run_id: str,
        submission: BlastSubmission,
        provider_result: ProviderExecutionResult,
    ) -> None:
        annotations: list[AnnotationRecord] = []
        evidence_documents: list[EvidenceDocument] = []
        if self._config.feature_flags.evidence_enrichment:
            annotations = self._build_annotation_records(run_id, provider_result)
        evidence_documents = self._build_evidence_documents(
            cache_key=provider_result.cache_key,
            run_id=run_id,
            annotations=annotations,
            hits=provider_result.hits,
        )
        for _search_info in provider_result.search_info_history[1:]:
            self._store.update_run_poll_timestamp(run_id)
        raw_payload_path = self._store.write_raw_payload(run_id, provider_result.raw_result)
        raw_payload_dict = {
            "submission": asdict(submission),
            "search_info_history": provider_result.search_info_history,
            "hit_count": len(provider_result.hits),
            "alignment_count": len(provider_result.alignments),
            "annotation_count": len(annotations),
            "evidence_count": len(evidence_documents),
        }
        self._store.complete_run(
            run_id,
            raw_payload_json=json_dumps(raw_payload_dict),
            raw_payload_path=raw_payload_path,
        )
        self._store.replace_hits(run_id, serialize_hits(provider_result.hits))
        self._store.replace_alignments(run_id, serialize_alignments(provider_result.alignments))
        self._store.replace_annotations(request_id, [asdict(annotation) for annotation in annotations])
        self._store.replace_evidence_documents(request_id, [asdict(evidence_document) for evidence_document in evidence_documents])
        self._store.update_request_status(request_id, "completed")
        self._store.upsert_cache_entry(
            cache_key=provider_result.cache_key,
            request_id=request_id,
            provider=provider_result.provider_name,
            hit_count=len(provider_result.hits),
            storage_path=raw_payload_path,
        )

    def _build_annotation_records(
        self,
        run_id: str,
        provider_result: ProviderExecutionResult,
    ) -> list[AnnotationRecord]:
        retrieved_at = _utcnow_iso()
        return [
            AnnotationRecord(
                run_id=run_id,
                hit_rank=hit.hit_rank,
                source_system="ncbi_blast",
                source_id=hit.accession or f"hit_{hit.hit_rank}",
                accession=hit.accession,
                title=hit.title,
                organism=hit.organism,
                annotation={
                    "provider": provider_result.provider_name,
                    "bit_score": hit.bit_score,
                    "e_value": hit.e_value,
                    "identity_fraction": hit.identity_fraction,
                    "positives_fraction": hit.positives_fraction,
                    "query_coverage": hit.query_coverage,
                    "subject_coverage": hit.subject_coverage,
                    "alignment_length": hit.alignment_length,
                    "subject_length": hit.subject_length,
                },
                retrieved_at=retrieved_at,
            )
            for hit in provider_result.hits
        ]

    def _build_evidence_documents(
        self,
        *,
        cache_key: str,
        run_id: str,
        annotations: list[AnnotationRecord],
        hits: list[BlastHit],
    ) -> list[EvidenceDocument]:
        if not annotations or not hits:
            return []
        if len(annotations) != len(hits):
            raise RetrievalConfigError("Annotation enrichment produced mismatched hit and annotation counts")

        created_at = _utcnow_iso()
        evidence_documents: list[EvidenceDocument] = []
        for annotation, hit in zip(annotations, hits, strict=True):
            summary_parts = [f"BLAST hit #{hit.hit_rank}"]
            if hit.accession:
                summary_parts.append(hit.accession)
            summary_parts.append(hit.title)
            if hit.organism:
                summary_parts.append(f"from {hit.organism}")
            summary_parts.append(f"bit score {hit.bit_score:.1f}")
            if hit.e_value is not None:
                summary_parts.append(f"e-value {hit.e_value:.2e}")
            if hit.query_coverage is not None:
                summary_parts.append(f"query coverage {hit.query_coverage:.1%}")

            stable_source_id = annotation.source_id or f"hit_{hit.hit_rank}"
            # The enrichment profile is part of the cache identity, so profile changes intentionally mint new evidence IDs.
            evidence_id = str(uuid5(EVIDENCE_UUID_NAMESPACE, f"{cache_key}:{stable_source_id}:{hit.hit_rank}"))
            evidence_documents.append(
                EvidenceDocument(
                    evidence_id=evidence_id,
                    run_id=run_id,
                    hit_rank=hit.hit_rank,
                    source_system=annotation.source_system,
                    source_id=annotation.source_id,
                    title=annotation.title,
                    content_text=", ".join(summary_parts),
                    content={
                        "accession": annotation.accession,
                        "organism": annotation.organism,
                        "summary_kind": "blast_hit",
                        "statistics": annotation.annotation,
                    },
                    transform_version=annotation.transform_version,
                    manifest_id=None,
                    retrieved_at=annotation.retrieved_at,
                    created_at=created_at,
                )
            )
        return evidence_documents


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_dumps(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True)
