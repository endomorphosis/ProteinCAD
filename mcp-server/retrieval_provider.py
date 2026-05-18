#!/usr/bin/env python3
"""BLAST retrieval provider abstraction and remote NCBI implementation."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import subprocess
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional
from uuid import uuid4
from xml.etree import ElementTree as ET

import httpx

from runtime_config import RetrievalConfig

_STATUS_RE = re.compile(r"Status=(\w+)")
_RID_RE = re.compile(r"RID\s*=\s*([A-Z0-9-]+)")
_RTOE_RE = re.compile(r"RTOE\s*=\s*(\d+)")
_HITS_RE = re.compile(r"ThereAreHits=(yes|no)", re.IGNORECASE)
_ORGANISM_SUFFIX_RE = re.compile(r"\s*\[([^\]]+)\]\s*$")
_LOCAL_BLAST_INDEX_SUFFIXES = (".pin", ".phr", ".psq", ".nin", ".nhr", ".nsq")
_MAX_LOCAL_BLAST_ERROR_DETAIL_CHARS = 800


class RetrievalError(RuntimeError):
    """Base retrieval error."""


class RetrievalConfigError(RetrievalError):
    """Raised when retrieval inputs/config are invalid."""


class RetrievalTimeoutError(RetrievalError):
    """Raised when remote BLAST polling exceeds the configured limit."""


class RetrievalUpstreamError(RetrievalError):
    """Raised when the remote BLAST API returns a failure status."""


class RetrievalProtocolError(RetrievalError):
    """Raised when the remote BLAST API response cannot be parsed."""


@dataclass(frozen=True)
class BlastRetrievalQuery:
    sequence: str
    normalized_sequence: str
    program: str
    database: str
    hitlist_size: int
    enrichment_profile: str
    poll_interval_seconds: float
    max_poll_attempts: int
    request_timeout_seconds: float
    remote_base_url: str

    @property
    def cache_key(self) -> str:
        return build_cache_key(self)


@dataclass(frozen=True)
class BlastSubmission:
    remote_request_id: str
    remote_queue_hint_seconds: int
    raw_submission: str


@dataclass(frozen=True)
class BlastAlignment:
    hit_rank: int
    hsp_index: int
    query_from_pos: int
    query_to_pos: int
    subject_from_pos: int
    subject_to_pos: int
    alignment_length: int
    identity_count: int
    positive_count: int
    gap_count: int
    query_sequence: str
    subject_sequence: str
    midline: str
    raw_alignment: Dict[str, Any]


@dataclass(frozen=True)
class BlastHit:
    hit_rank: int
    accession: Optional[str]
    title: str
    organism: Optional[str]
    e_value: Optional[float]
    bit_score: float
    identity_fraction: float
    positives_fraction: float
    query_coverage: float
    subject_coverage: float
    alignment_length: int
    subject_length: int
    raw_hit: Dict[str, Any]


@dataclass(frozen=True)
class ProviderExecutionResult:
    provider_name: str
    cache_key: str
    submission: BlastSubmission
    raw_result: str
    hits: List[BlastHit]
    alignments: List[BlastAlignment]
    search_info_history: List[str] = field(default_factory=list)


def normalize_sequence(sequence: str) -> str:
    lines = [line.strip() for line in sequence.splitlines() if line.strip() and not line.strip().startswith(">")]
    normalized = "".join(lines).replace(" ", "").upper()
    if not normalized:
        raise RetrievalConfigError("BLAST retrieval requires a non-empty amino-acid sequence")
    if not all(char.isalpha() or char in {"*", "-"} for char in normalized):
        raise RetrievalConfigError("BLAST retrieval sequence contains unsupported characters")
    return normalized


def build_cache_key(query: BlastRetrievalQuery) -> str:
    payload = json.dumps(
        {
            "sequence": query.normalized_sequence,
            "program": query.program,
            "database": query.database,
            "hitlist_size": query.hitlist_size,
            "enrichment_profile": query.enrichment_profile,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_query_from_config(
    sequence: str,
    config: RetrievalConfig,
    *,
    program: Optional[str] = None,
    database: Optional[str] = None,
    hitlist_size: Optional[int] = None,
) -> BlastRetrievalQuery:
    normalized_sequence = normalize_sequence(sequence)
    resolved_hitlist = hitlist_size if hitlist_size is not None else config.blast.default_hitlist_size
    resolved_hitlist = max(1, min(int(resolved_hitlist), config.blast.max_hitlist_size))
    return BlastRetrievalQuery(
        sequence=sequence,
        normalized_sequence=normalized_sequence,
        program=(program or config.blast.default_program).strip() or config.blast.default_program,
        database=(database or config.blast.default_database).strip() or config.blast.default_database,
        hitlist_size=resolved_hitlist,
        enrichment_profile="evidence_v1" if config.feature_flags.evidence_enrichment else "blast_hit_v1",
        poll_interval_seconds=config.blast.poll_interval_seconds,
        max_poll_attempts=config.blast.max_poll_attempts,
        request_timeout_seconds=config.blast.request_timeout_seconds,
        remote_base_url=config.blast.remote_base_url,
    )


def parse_submission_response(payload: str) -> BlastSubmission:
    rid_match = _RID_RE.search(payload)
    rtoe_match = _RTOE_RE.search(payload)
    if not rid_match or not rtoe_match:
        raise RetrievalProtocolError("BLAST submission response did not include RID/RTOE")
    return BlastSubmission(
        remote_request_id=rid_match.group(1),
        remote_queue_hint_seconds=int(rtoe_match.group(1)),
        raw_submission=payload,
    )


def parse_search_info(payload: str) -> Dict[str, Any]:
    status_match = _STATUS_RE.search(payload)
    if not status_match:
        raise RetrievalProtocolError("BLAST polling response did not include Status")
    hits_match = _HITS_RE.search(payload)
    return {
        "status": status_match.group(1).upper(),
        "there_are_hits": None if not hits_match else hits_match.group(1).lower() == "yes",
        "raw": payload,
    }


def _extract_organism(title: str) -> tuple[str, Optional[str]]:
    """Split `Example protein [Organism]` BLAST titles into title and organism."""

    match = _ORGANISM_SUFFIX_RE.search(title)
    if not match:
        return title, None
    organism = match.group(1).strip()
    return title[: match.start()].strip(), organism or None


def parse_blast_xml(payload: str, *, query_length: int) -> tuple[List[BlastHit], List[BlastAlignment]]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise RetrievalProtocolError(f"Invalid BLAST XML payload: {exc}") from exc

    hits: List[BlastHit] = []
    alignments: List[BlastAlignment] = []
    for hit_rank, hit_elem in enumerate(root.findall(".//Hit"), start=1):
        title_text = (hit_elem.findtext("Hit_def") or "").strip()
        title, organism = _extract_organism(title_text)
        subject_length = int(hit_elem.findtext("Hit_len") or 0)
        accession = (hit_elem.findtext("Hit_accession") or "").strip() or None
        hsp_elems = hit_elem.findall("./Hit_hsps/Hsp")
        if not hsp_elems:
            continue

        best_alignment_length = 0
        best_bit_score = 0.0
        best_evalue: Optional[float] = None
        best_identity_fraction = 0.0
        best_positives_fraction = 0.0
        best_query_coverage = 0.0
        best_subject_coverage = 0.0

        for hsp_index, hsp_elem in enumerate(hsp_elems, start=1):
            alignment_length = int(hsp_elem.findtext("Hsp_align-len") or 0)
            identity_count = int(hsp_elem.findtext("Hsp_identity") or 0)
            positive_count = int(hsp_elem.findtext("Hsp_positive") or identity_count)
            gap_count = int(hsp_elem.findtext("Hsp_gaps") or 0)
            query_from = int(hsp_elem.findtext("Hsp_query-from") or 0)
            query_to = int(hsp_elem.findtext("Hsp_query-to") or 0)
            hit_from = int(hsp_elem.findtext("Hsp_hit-from") or 0)
            hit_to = int(hsp_elem.findtext("Hsp_hit-to") or 0)
            bit_score = float(hsp_elem.findtext("Hsp_bit-score") or 0.0)
            e_value = float(hsp_elem.findtext("Hsp_evalue") or 0.0)
            identity_fraction = (identity_count / alignment_length) if alignment_length else 0.0
            positives_fraction = (positive_count / alignment_length) if alignment_length else 0.0
            query_coverage = (alignment_length / query_length) if query_length else 0.0
            subject_coverage = (alignment_length / subject_length) if subject_length else 0.0

            alignments.append(
                BlastAlignment(
                    hit_rank=hit_rank,
                    hsp_index=hsp_index,
                    query_from_pos=query_from,
                    query_to_pos=query_to,
                    subject_from_pos=hit_from,
                    subject_to_pos=hit_to,
                    alignment_length=alignment_length,
                    identity_count=identity_count,
                    positive_count=positive_count,
                    gap_count=gap_count,
                    query_sequence=hsp_elem.findtext("Hsp_qseq") or "",
                    subject_sequence=hsp_elem.findtext("Hsp_hseq") or "",
                    midline=hsp_elem.findtext("Hsp_midline") or "",
                    raw_alignment={
                        "bit_score": bit_score,
                        "e_value": e_value,
                        "query_from": query_from,
                        "query_to": query_to,
                        "hit_from": hit_from,
                        "hit_to": hit_to,
                    },
                )
            )

            if bit_score >= best_bit_score:
                best_alignment_length = alignment_length
                best_bit_score = bit_score
                best_evalue = e_value
                best_identity_fraction = identity_fraction
                best_positives_fraction = positives_fraction
                best_query_coverage = query_coverage
                best_subject_coverage = subject_coverage

        hits.append(
            BlastHit(
                hit_rank=hit_rank,
                accession=accession,
                title=title or title_text or accession or f"hit_{hit_rank}",
                organism=organism,
                e_value=best_evalue,
                bit_score=best_bit_score,
                identity_fraction=best_identity_fraction,
                positives_fraction=best_positives_fraction,
                query_coverage=best_query_coverage,
                subject_coverage=best_subject_coverage,
                alignment_length=best_alignment_length,
                subject_length=subject_length,
                raw_hit={
                    "accession": accession,
                    "raw_title": title_text,
                    "hsp_count": len(hsp_elems),
                    "subject_length": subject_length,
                },
            )
        )

    return hits, alignments


class RetrievalProvider(ABC):
    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Stable provider identifier."""

    @abstractmethod
    async def submit(self, query: BlastRetrievalQuery) -> BlastSubmission:
        """Submit a remote retrieval request."""

    @abstractmethod
    async def collect_results(
        self,
        query: BlastRetrievalQuery,
        submission: BlastSubmission,
    ) -> ProviderExecutionResult:
        """Poll and normalize results for a submitted request."""

    async def execute(self, query: BlastRetrievalQuery) -> ProviderExecutionResult:
        submission = await self.submit(query)
        return await self.collect_results(query, submission)


class LocalBlastProvider(RetrievalProvider):
    """Run BLAST+ locally using configured binary/database discovery rules."""

    def __init__(
        self,
        *,
        config: RetrievalConfig,
        command_runner: Optional[Callable[[List[str], str, float], subprocess.CompletedProcess[str]]] = None,
    ) -> None:
        self._config = config
        self._command_runner = command_runner or _run_local_blast_command

    @property
    def provider_name(self) -> str:
        return "local_blast"

    async def submit(self, query: BlastRetrievalQuery) -> BlastSubmission:
        return BlastSubmission(
            remote_request_id=f"local_{uuid4().hex}",
            remote_queue_hint_seconds=0,
            raw_submission=json.dumps(
                {
                    "provider": self.provider_name,
                    "program": query.program,
                    "database": query.database,
                    "hitlist_size": query.hitlist_size,
                },
                sort_keys=True,
            ),
        )

    async def collect_results(
        self,
        query: BlastRetrievalQuery,
        submission: BlastSubmission,
    ) -> ProviderExecutionResult:
        database_path = resolve_local_database(query.database, self._config)
        binary = (self._config.blast.local_blast_binary or "").strip() or query.program
        if not binary:
            raise RetrievalConfigError("Local BLAST binary is not configured")

        command = [
            binary,
            "-db",
            database_path,
            "-query",
            "-",
            "-outfmt",
            "5",
            "-num_descriptions",
            str(query.hitlist_size),
            "-num_alignments",
            str(query.hitlist_size),
        ]
        fasta_query = f">query\n{query.normalized_sequence}\n"
        completed = await asyncio.to_thread(
            self._command_runner,
            command,
            fasta_query,
            query.request_timeout_seconds,
        )
        stderr = (completed.stderr or "").strip()
        if completed.returncode != 0:
            detail = (
                stderr[-_MAX_LOCAL_BLAST_ERROR_DETAIL_CHARS :]
                if stderr
                else f"exit code {completed.returncode}"
            )
            raise RetrievalUpstreamError(f"Local BLAST command failed: {detail}")

        raw_result = (completed.stdout or "").strip()
        if not raw_result:
            raise RetrievalProtocolError("Local BLAST command returned empty output")

        hits, alignments = parse_blast_xml(raw_result, query_length=len(query.normalized_sequence))
        return ProviderExecutionResult(
            provider_name=self.provider_name,
            cache_key=build_cache_key(query),
            submission=submission,
            raw_result=raw_result,
            hits=hits,
            alignments=alignments,
            search_info_history=[submission.raw_submission],
        )


class NCBIBlastRemoteProvider(RetrievalProvider):
    def __init__(
        self,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        sleeper: Optional[Callable[[float], Awaitable[None]]] = None,
    ) -> None:
        self._transport = transport
        self._sleeper = sleeper or asyncio.sleep

    @property
    def provider_name(self) -> str:
        return "ncbi_blast_remote"

    async def _get_search_info(self, client: httpx.AsyncClient, query: BlastRetrievalQuery, remote_request_id: str) -> Dict[str, Any]:
        response = await client.get(
            query.remote_base_url,
            params={"CMD": "Get", "RID": remote_request_id, "FORMAT_OBJECT": "SearchInfo"},
        )
        response.raise_for_status()
        return parse_search_info(response.text)

    async def _get_result_xml(self, client: httpx.AsyncClient, query: BlastRetrievalQuery, remote_request_id: str) -> str:
        response = await client.get(
            query.remote_base_url,
            params={"CMD": "Get", "RID": remote_request_id, "FORMAT_TYPE": "XML"},
        )
        response.raise_for_status()
        return response.text

    async def submit(self, query: BlastRetrievalQuery) -> BlastSubmission:
        timeout = httpx.Timeout(query.request_timeout_seconds, connect=min(5.0, query.request_timeout_seconds))
        async with httpx.AsyncClient(timeout=timeout, transport=self._transport) as client:
            response = await client.post(
                query.remote_base_url,
                data={
                    "CMD": "Put",
                    "PROGRAM": query.program,
                    "DATABASE": query.database,
                    "QUERY": query.normalized_sequence,
                    "HITLIST_SIZE": str(query.hitlist_size),
                },
            )
            response.raise_for_status()
            return parse_submission_response(response.text)

    async def collect_results(
        self,
        query: BlastRetrievalQuery,
        submission: BlastSubmission,
    ) -> ProviderExecutionResult:
        cache_key = build_cache_key(query)
        timeout = httpx.Timeout(query.request_timeout_seconds, connect=min(5.0, query.request_timeout_seconds))
        async with httpx.AsyncClient(timeout=timeout, transport=self._transport) as client:
            search_info_history: List[str] = [submission.raw_submission]

            if submission.remote_queue_hint_seconds > 0:
                await self._sleeper(float(submission.remote_queue_hint_seconds))

            for _attempt in range(query.max_poll_attempts):
                search_info = await self._get_search_info(client, query, submission.remote_request_id)
                search_info_history.append(search_info["raw"])
                status = search_info["status"]
                if status == "WAITING":
                    await self._sleeper(query.poll_interval_seconds)
                    continue
                if status == "FAILED":
                    raise RetrievalUpstreamError("Remote BLAST request failed")
                if status == "UNKNOWN":
                    raise RetrievalUpstreamError("Remote BLAST request expired or was not found")
                if status != "READY":
                    raise RetrievalProtocolError(f"Unexpected BLAST polling status: {status}")

                if search_info["there_are_hits"] is False:
                    return ProviderExecutionResult(
                        provider_name=self.provider_name,
                        cache_key=cache_key,
                        submission=submission,
                        raw_result="",
                        hits=[],
                        alignments=[],
                        search_info_history=search_info_history,
                    )

                raw_result = await self._get_result_xml(client, query, submission.remote_request_id)
                hits, alignments = parse_blast_xml(raw_result, query_length=len(query.normalized_sequence))
                return ProviderExecutionResult(
                    provider_name=self.provider_name,
                    cache_key=cache_key,
                    submission=submission,
                    raw_result=raw_result,
                    hits=hits,
                    alignments=alignments,
                    search_info_history=search_info_history,
                )
            raise RetrievalTimeoutError(
                f"Remote BLAST request exceeded {query.max_poll_attempts} polling attempts"
            )


def provider_from_config(
    config: RetrievalConfig,
    *,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    sleeper: Optional[Callable[[float], Awaitable[None]]] = None,
    local_command_runner: Optional[Callable[[List[str], str, float], subprocess.CompletedProcess[str]]] = None,
) -> RetrievalProvider:
    if config.provider == "ncbi_blast_remote":
        return NCBIBlastRemoteProvider(transport=transport, sleeper=sleeper)
    return LocalBlastProvider(config=config, command_runner=local_command_runner)


def serialize_hits(hits: List[BlastHit]) -> List[Dict[str, Any]]:
    return [asdict(hit) for hit in hits]


def serialize_alignments(alignments: List[BlastAlignment]) -> List[Dict[str, Any]]:
    return [asdict(alignment) for alignment in alignments]


def _blast_database_files_exist(prefix: Path) -> bool:
    if prefix.exists():
        return True
    return any(prefix.with_suffix(suffix).exists() for suffix in _LOCAL_BLAST_INDEX_SUFFIXES)


def _matches_database_name(discovered: Path, candidate: str) -> bool:
    return discovered.stem == candidate or discovered.name.startswith(f"{candidate}.")


def resolve_local_database(database: str, config: RetrievalConfig) -> str:
    candidate = (database or "").strip()
    if not candidate:
        fallback = (config.blast.local_database or "").strip()
        candidate = fallback or (config.blast.default_database or "").strip()
    if not candidate:
        raise RetrievalConfigError("Local BLAST database is not configured")

    candidate_path = Path(candidate).expanduser()
    if candidate_path.is_absolute():
        if _blast_database_files_exist(candidate_path):
            return str(candidate_path)
        raise RetrievalConfigError(f"Local BLAST database path does not exist: {candidate_path}")

    search_root = (config.blast.local_database_dir or "").strip()
    if search_root:
        root_path = Path(search_root).expanduser()
        if not root_path.exists():
            raise RetrievalConfigError(f"Local BLAST database directory does not exist: {root_path}")
        prefixed_candidate = root_path / candidate
        if _blast_database_files_exist(prefixed_candidate):
            return str(prefixed_candidate)
        discovery_glob = (config.blast.local_database_glob or "").strip() or "*.pin"
        for discovered in sorted(root_path.glob(discovery_glob)):
            if not _matches_database_name(discovered, candidate):
                continue
            if discovered.suffix in _LOCAL_BLAST_INDEX_SUFFIXES:
                return str(discovered.with_suffix(""))
            return str(discovered)
        raise RetrievalConfigError(
            f"Local BLAST database '{candidate}' not found in {root_path} using glob '{discovery_glob}'"
        )

    if _blast_database_files_exist(candidate_path):
        return str(candidate_path)
    raise RetrievalConfigError(
        "Local BLAST database could not be resolved; set retrieval.blast.local_database_dir "
        "or use an absolute local database path"
    )


def _run_local_blast_command(
    command: List[str],
    fasta_query: str,
    timeout_seconds: float,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        input=fasta_query,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=max(1.0, float(timeout_seconds)),
        check=False,
    )
