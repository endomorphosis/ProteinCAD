#!/usr/bin/env python3
"""High-level BLAST retrieval orchestration with cache reuse and persistence."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any, Awaitable, Callable, Dict, Optional
from uuid import uuid4

import httpx

from retrieval_provider import (
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
            result = self._store.get_request_result(request_id) or {}
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
                result=result,
            )
        except RetrievalError as exc:
            self._store.update_request_status(request_id, "failed", error_text=str(exc))
            result = self._store.get_request_result(request_id) or {
                "request_id": request_id,
                "status": "failed",
                "error_text": str(exc),
                "runs": [],
                "hits": [],
                "alignments": [],
            }
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
                result=result,
            )

    def _persist_provider_result(
        self,
        request_id: str,
        run_id: str,
        submission: BlastSubmission,
        provider_result: ProviderExecutionResult,
    ) -> None:
        for _search_info in provider_result.search_info_history[1:]:
            self._store.update_run_poll_timestamp(run_id)
        raw_payload_path = self._store.write_raw_payload(run_id, provider_result.raw_result)
        raw_payload_dict = {
            "submission": asdict(submission),
            "search_info_history": provider_result.search_info_history,
            "hit_count": len(provider_result.hits),
            "alignment_count": len(provider_result.alignments),
        }
        self._store.complete_run(
            run_id,
            raw_payload_json=json_dumps(raw_payload_dict),
            raw_payload_path=raw_payload_path,
        )
        self._store.replace_hits(run_id, serialize_hits(provider_result.hits))
        self._store.replace_alignments(run_id, serialize_alignments(provider_result.alignments))
        self._store.update_request_status(request_id, "completed")
        self._store.upsert_cache_entry(
            cache_key=provider_result.cache_key,
            request_id=request_id,
            provider=provider_result.provider_name,
            hit_count=len(provider_result.hits),
            storage_path=raw_payload_path,
        )


def json_dumps(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True)
