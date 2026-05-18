#!/usr/bin/env python3
"""Runtime configuration for model routing.

Goal: allow non-technical users to switch between:
- NVIDIA NIM services
- externally hosted model services (any container or service implementing the same REST contract)
- embedded execution inside the MCP server container (last-resort convenience)

The dashboard can read/update this config via MCP server REST endpoints.

Config is optionally persisted to disk via MCP_CONFIG_PATH.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field
from pydantic import ConfigDict


ServiceName = Literal["alphafold", "rfdiffusion", "proteinmpnn", "alphafold_multimer"]
ProviderName = Literal["nim", "external", "embedded"]
RetrievalProviderName = Literal["ncbi_blast_remote", "local_blast"]
CURRENT_CONFIG_VERSION = 4


def _truthy_env(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_bool(name: str, default: bool) -> bool:
    if name not in os.environ:
        return default
    return _truthy_env(name)


def _resolve_env_url(key: str) -> Optional[str]:
    if key not in os.environ:
        return None
    value = (os.environ.get(key) or "").strip()
    if not value or value.lower() in {"disabled", "none", "null"}:
        return None
    return value


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _default_retrieval_data_dir() -> str:
    explicit = (os.getenv("MCP_RETRIEVAL_DATA_DIR") or "").strip()
    if explicit:
        return explicit
    config_path = (os.getenv("MCP_CONFIG_PATH") or "").strip()
    if config_path:
        return str(Path(config_path).expanduser().resolve().parent / "retrieval")
    return "/tmp/proteincad/retrieval"


def _retrieval_storage_paths(data_dir: str) -> Dict[str, str]:
    root = Path(data_dir)
    return {
        "duckdb_path": str(root / "blast_retrieval.duckdb"),
        "parquet_export_dir": str(root / "parquet"),
        "raw_payload_dir": str(root / "raw_payloads"),
        "manifest_dir": str(root / "manifests"),
    }


def _default_retrieval_duckdb_path() -> str:
    explicit = (os.getenv("MCP_RETRIEVAL_DUCKDB_PATH") or "").strip()
    if explicit:
        return explicit
    return _retrieval_storage_paths(_default_retrieval_data_dir())["duckdb_path"]


def _default_retrieval_provider() -> RetrievalProviderName:
    provider = (os.getenv("MCP_RETRIEVAL_PROVIDER") or "").strip().lower()
    if provider in {"ncbi_blast_remote", "local_blast"}:
        return provider  # type: ignore[return-value]
    return "ncbi_blast_remote"


def default_nim_urls() -> Dict[ServiceName, Optional[str]]:
    # Defaults match the original repo defaults.
    def _env_or_default(env_key: str, default_url: str) -> Optional[str]:
        # If the env var is present, honor it even if it disables the service.
        if env_key in os.environ:
            return _resolve_env_url(env_key)
        return default_url

    return {
        "alphafold": _env_or_default("ALPHAFOLD_URL", "http://localhost:8081"),
        "rfdiffusion": _env_or_default("RFDIFFUSION_URL", "http://localhost:8082"),
        "proteinmpnn": _env_or_default("PROTEINMPNN_URL", "http://localhost:8083"),
        "alphafold_multimer": _env_or_default("ALPHAFOLD_MULTIMER_URL", "http://localhost:8084"),
    }


_NIM_LOCALHOST_DEFAULTS: Dict[ServiceName, str] = {
    "alphafold": "http://localhost:8081",
    "rfdiffusion": "http://localhost:8082",
    "proteinmpnn": "http://localhost:8083",
    "alphafold_multimer": "http://localhost:8084",
}


_NIM_ENV_KEYS: Dict[ServiceName, str] = {
    "alphafold": "ALPHAFOLD_URL",
    "rfdiffusion": "RFDIFFUSION_URL",
    "proteinmpnn": "PROTEINMPNN_URL",
    "alphafold_multimer": "ALPHAFOLD_MULTIMER_URL",
}


def _migrate_localhost_nim_urls_from_env(cfg: "MCPServerConfig") -> bool:
    """If a persisted config still uses old localhost defaults, migrate those
    entries to current env-provided URLs (or disable if env explicitly disables).

    This avoids confusing "not_ready" caused by stale defaults inside Docker
    stacks where service discovery uses compose DNS (e.g. http://alphafold:8000).

    It is intentionally conservative: it only rewrites values that exactly match
    the historical localhost defaults.
    """

    changed = False

    def _running_in_docker() -> bool:
        try:
            return Path("/.dockerenv").exists() or _truthy_env("DOCKER_CONTAINER")
        except Exception:
            return False

    def _looks_like_compose_dns() -> bool:
        try:
            urls = (cfg.nim.service_urls or {}).values()
            for u in urls:
                if not isinstance(u, str):
                    continue
                # Compose DNS style (service name on internal network)
                if "://alphafold:" in u or "://rfdiffusion:" in u or "://proteinmpnn:" in u or "://alphafold-multimer:" in u:
                    return True
        except Exception:
            return False
        return False
    nim_urls = dict(cfg.nim.service_urls or {})
    for service_name, default_url in _NIM_LOCALHOST_DEFAULTS.items():
        current = nim_urls.get(service_name)
        if current != default_url:
            continue
        env_key = _NIM_ENV_KEYS[service_name]

        # In containerized stacks, localhost defaults are almost always wrong
        # (they point at the MCP container itself). If the env var is absent,
        # treat it as disabled for that service.
        if (env_key in os.environ) or _running_in_docker() or _looks_like_compose_dns():
            nim_urls[service_name] = _resolve_env_url(env_key)
            changed = True

    if changed:
        cfg.nim.service_urls = nim_urls
    return changed


def _apply_embedded_env_overrides(cfg: "MCPServerConfig") -> bool:
    """Apply runtime env overrides for embedded provisioning toggles.

    This supports zero-touch deployments where operators control bootstrap via
    environment variables even if a persisted config exists.
    """

    changed = False
    try:
        if "MCP_EMBEDDED_AUTO_DOWNLOAD" in os.environ:
            v = _truthy_env("MCP_EMBEDDED_AUTO_DOWNLOAD")
            if getattr(cfg.embedded, "auto_download", False) != v:
                cfg.embedded.auto_download = v
                changed = True
        if "MCP_EMBEDDED_AUTO_INSTALL" in os.environ:
            v = _truthy_env("MCP_EMBEDDED_AUTO_INSTALL")
            if getattr(cfg.embedded, "auto_install", False) != v:
                cfg.embedded.auto_install = v
                changed = True
    except Exception:
        return changed

    return changed


def _apply_routing_env_overrides(cfg: "MCPServerConfig") -> bool:
    """Apply runtime env overrides for routing.

    Supported env vars:
      - MCP_ROUTING_MODE: "single" or "fallback"
      - MCP_ROUTING_PRIMARY: ProviderName
      - MCP_ROUTING_ORDER: comma-separated ProviderName list
    """

    changed = False
    try:
        if "MCP_ROUTING_MODE" in os.environ:
            mode = (os.getenv("MCP_ROUTING_MODE") or "").strip().lower()
            if mode in {"single", "fallback"} and cfg.routing.mode != mode:
                cfg.routing.mode = mode  # type: ignore[assignment]
                changed = True

        if "MCP_ROUTING_PRIMARY" in os.environ:
            primary = (os.getenv("MCP_ROUTING_PRIMARY") or "").strip().lower()
            if primary in {"nim", "external", "embedded"} and cfg.routing.primary != primary:
                cfg.routing.primary = primary  # type: ignore[assignment]
                changed = True

        if "MCP_ROUTING_ORDER" in os.environ:
            raw = (os.getenv("MCP_ROUTING_ORDER") or "").strip()
            if raw:
                parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
                order = [p for p in parts if p in {"nim", "external", "embedded"}]
                # de-dup preserving order
                dedup: List[ProviderName] = []
                for p in order:
                    if p not in dedup:
                        dedup.append(p)  # type: ignore[arg-type]
                if dedup and cfg.routing.order != dedup:
                    cfg.routing.order = dedup
                    changed = True
    except Exception:
        return changed

    return changed


def _apply_retrieval_env_overrides(cfg: "MCPServerConfig") -> bool:
    """Apply runtime env overrides for BLAST retrieval config."""

    changed = False
    try:
        feature_flag_bools = {
            "MCP_RETRIEVAL_ENABLED": "enabled",
            "MCP_RETRIEVAL_EXPOSE_REST": "expose_rest",
            "MCP_RETRIEVAL_EXPOSE_MCP": "expose_mcp",
            "MCP_RETRIEVAL_ENABLE_JOB_GROUNDING": "allow_job_grounding",
            "MCP_RETRIEVAL_EVIDENCE_ENRICHMENT": "evidence_enrichment",
            "MCP_RETRIEVAL_EXPORT_PARQUET": "export_parquet",
            "MCP_RETRIEVAL_CREATE_SCHEMA_ON_STARTUP": "create_schema_on_startup",
        }
        for env_name, field_name in feature_flag_bools.items():
            if env_name in os.environ:
                value = _truthy_env(env_name)
                if getattr(cfg.retrieval.feature_flags, field_name) != value:
                    setattr(cfg.retrieval.feature_flags, field_name, value)
                    changed = True

        if "MCP_RETRIEVAL_PROVIDER" in os.environ:
            provider = (os.getenv("MCP_RETRIEVAL_PROVIDER") or "").strip().lower()
            if provider in {"ncbi_blast_remote", "local_blast"} and cfg.retrieval.provider != provider:
                cfg.retrieval.provider = provider  # type: ignore[assignment]
                changed = True

        string_overrides = {
            "MCP_RETRIEVAL_REMOTE_BASE_URL": ("blast", "remote_base_url"),
            "MCP_RETRIEVAL_PROGRAM": ("blast", "default_program"),
            "MCP_RETRIEVAL_DATABASE": ("blast", "default_database"),
            "MCP_RETRIEVAL_DUCKDB_PATH": ("storage", "duckdb_path"),
            "MCP_RETRIEVAL_PARQUET_DIR": ("storage", "parquet_export_dir"),
            "MCP_RETRIEVAL_RAW_PAYLOAD_DIR": ("storage", "raw_payload_dir"),
            "MCP_RETRIEVAL_MANIFEST_DIR": ("storage", "manifest_dir"),
        }
        for env_name, (section_name, field_name) in string_overrides.items():
            if env_name in os.environ:
                value = (os.getenv(env_name) or "").strip()
                section = getattr(cfg.retrieval, section_name)
                if value and getattr(section, field_name) != value:
                    setattr(section, field_name, value)
                    changed = True

        if "MCP_RETRIEVAL_DATA_DIR" in os.environ:
            data_dir = (os.getenv("MCP_RETRIEVAL_DATA_DIR") or "").strip()
            if data_dir and cfg.retrieval.storage.data_dir != data_dir:
                cfg.retrieval.storage.data_dir = data_dir
                changed = True
            derived_paths = _retrieval_storage_paths(data_dir) if data_dir else {}
            if data_dir and "MCP_RETRIEVAL_DUCKDB_PATH" not in os.environ:
                duckdb_path = derived_paths["duckdb_path"]
                if cfg.retrieval.storage.duckdb_path != duckdb_path:
                    cfg.retrieval.storage.duckdb_path = duckdb_path
                    changed = True
            env_map = {
                "parquet_export_dir": "MCP_RETRIEVAL_PARQUET_DIR",
                "raw_payload_dir": "MCP_RETRIEVAL_RAW_PAYLOAD_DIR",
                "manifest_dir": "MCP_RETRIEVAL_MANIFEST_DIR",
            }
            for field_name, derived_value in derived_paths.items():
                if field_name == "duckdb_path":
                    continue
                if data_dir and env_map[field_name] not in os.environ and getattr(cfg.retrieval.storage, field_name) != derived_value:
                    setattr(cfg.retrieval.storage, field_name, derived_value)
                    changed = True

        int_overrides = {
            "MCP_RETRIEVAL_HITLIST_SIZE": ("blast", "default_hitlist_size"),
            "MCP_RETRIEVAL_MAX_HITLIST_SIZE": ("blast", "max_hitlist_size"),
            "MCP_RETRIEVAL_MAX_POLL_ATTEMPTS": ("blast", "max_poll_attempts"),
        }
        for env_name, (section_name, field_name) in int_overrides.items():
            if env_name in os.environ:
                raw = (os.getenv(env_name) or "").strip()
                try:
                    value = int(raw)
                except ValueError:
                    continue
                section = getattr(cfg.retrieval, section_name)
                if getattr(section, field_name) != value:
                    setattr(section, field_name, value)
                    changed = True

        float_overrides = {
            "MCP_RETRIEVAL_POLL_INTERVAL_S": ("blast", "poll_interval_seconds"),
            "MCP_RETRIEVAL_REQUEST_TIMEOUT_S": ("blast", "request_timeout_seconds"),
        }
        for env_name, (section_name, field_name) in float_overrides.items():
            if env_name in os.environ:
                raw = (os.getenv(env_name) or "").strip()
                try:
                    value = float(raw)
                except ValueError:
                    continue
                section = getattr(cfg.retrieval, section_name)
                if getattr(section, field_name) != value:
                    setattr(section, field_name, value)
                    changed = True
    except Exception:
        return changed

    return changed


def _apply_retrieval_path_defaults(cfg: "MCPServerConfig", config_path: Optional[Path]) -> bool:
    """Derive retrieval storage defaults from the persisted config location."""

    if not config_path:
        return False
    if any(
        env_name in os.environ
        for env_name in {
            "MCP_RETRIEVAL_DATA_DIR",
            "MCP_RETRIEVAL_DUCKDB_PATH",
            "MCP_RETRIEVAL_PARQUET_DIR",
            "MCP_RETRIEVAL_RAW_PAYLOAD_DIR",
            "MCP_RETRIEVAL_MANIFEST_DIR",
        }
    ):
        return False

    retrieval_root = config_path.expanduser().resolve().parent / "retrieval"
    storage = cfg.retrieval.storage
    changed = False
    desired_values = {
        "data_dir": str(retrieval_root),
        **_retrieval_storage_paths(str(retrieval_root)),
    }
    for field_name, expected in desired_values.items():
        if getattr(storage, field_name) != expected:
            setattr(storage, field_name, expected)
            changed = True
    return changed


def default_external_urls() -> Dict[ServiceName, Optional[str]]:
    # Optional secondary URL set for non-NIM model services.
    return {
        "alphafold": _resolve_env_url("EXTERNAL_ALPHAFOLD_URL"),
        "rfdiffusion": _resolve_env_url("EXTERNAL_RFDIFFUSION_URL"),
        "proteinmpnn": _resolve_env_url("EXTERNAL_PROTEINMPNN_URL"),
        "alphafold_multimer": _resolve_env_url("EXTERNAL_ALPHAFOLD_MULTIMER_URL"),
    }


class ProviderConfig(BaseModel):
    enabled: bool = True
    # service_urls is used by REST providers (nim/external). embedded ignores it.
    service_urls: Dict[ServiceName, Optional[str]] = Field(default_factory=dict)


class EmbeddedDownloads(BaseModel):
    # ProteinMPNN
    proteinmpnn_source_tarball_url: Optional[str] = None
    proteinmpnn_weights_url: Optional[str] = None

    # RFdiffusion
    rfdiffusion_weights_url: Optional[str] = None

    # AlphaFold2
    # NOTE: AlphaFold databases are very large; this is opt-in and requires an explicit URL.
    # Reduced/initial DB pack (recommended default when doing staged installs)
    alphafold_db_url: Optional[str] = None
    # Optional follow-on pack for staging additional DB assets after the reduced pack is available.
    alphafold_db_url_full: Optional[str] = None
    # Subdirectory under model_dir to place/extract databases.
    alphafold_db_subdir: str = "alphafold_db"


class RunnerCommand(BaseModel):
    """A command template (argv) for running a model inside the MCP container.

    The dashboard can store commands as an array of strings.

    Supported placeholders:
        - {model_dir}
        - {work_dir}
        - {fasta_path}
        - {output_pdb_path}
        - {target_pdb_path}
        - {output_dir}
        - {num_designs}
        - {design_id}

    Example AlphaFold:
        ["python", "/opt/alphafold/run.py", "--fasta", "{fasta_path}", "--out", "{output_pdb_path}"]
    """

    argv: List[str] = Field(default_factory=list)
    timeout_seconds: int = 3600


class EmbeddedRunners(BaseModel):
    # If argv is empty, the embedded backend will report not_ready with a clear reason.
    alphafold: RunnerCommand = Field(default_factory=RunnerCommand)
    rfdiffusion: RunnerCommand = Field(default_factory=RunnerCommand)
    alphafold_multimer: RunnerCommand = Field(default_factory=RunnerCommand)


class EmbeddedConfig(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    enabled: bool = True
    # Directory inside the MCP server container for downloading/storing model assets.
    model_dir: str = "/models"
    # If true, embedded providers may attempt a best-effort bootstrap (pip installs, downloads).
    # Keep false by default; explicit opt-in.
    auto_install: bool = Field(default_factory=lambda: _truthy_env("MCP_EMBEDDED_AUTO_INSTALL"))
    # If true, the server may download configured assets (URLs must be explicitly provided).
    auto_download: bool = Field(default_factory=lambda: _truthy_env("MCP_EMBEDDED_AUTO_DOWNLOAD"))
    downloads: EmbeddedDownloads = Field(default_factory=EmbeddedDownloads)
    runners: EmbeddedRunners = Field(default_factory=EmbeddedRunners)


class RetrievalFeatureFlags(BaseModel):
    enabled: bool = Field(default_factory=lambda: _truthy_env("MCP_RETRIEVAL_ENABLED"))
    expose_rest: bool = Field(default_factory=lambda: _truthy_env("MCP_RETRIEVAL_EXPOSE_REST"))
    expose_mcp: bool = Field(default_factory=lambda: _truthy_env("MCP_RETRIEVAL_EXPOSE_MCP"))
    # Keep BLAST grounding opt-in for design jobs until dashboard UX + evidence rendering land.
    allow_job_grounding: bool = Field(default_factory=lambda: _env_bool("MCP_RETRIEVAL_ENABLE_JOB_GROUNDING", False))
    evidence_enrichment: bool = Field(default_factory=lambda: _truthy_env("MCP_RETRIEVAL_EVIDENCE_ENRICHMENT"))
    export_parquet: bool = Field(default_factory=lambda: _truthy_env("MCP_RETRIEVAL_EXPORT_PARQUET"))
    create_schema_on_startup: bool = Field(default_factory=lambda: _env_bool("MCP_RETRIEVAL_CREATE_SCHEMA_ON_STARTUP", True))


class RetrievalBlastConfig(BaseModel):
    remote_base_url: str = Field(default_factory=lambda: (os.getenv("MCP_RETRIEVAL_REMOTE_BASE_URL") or "").strip() or "https://blast.ncbi.nlm.nih.gov/Blast.cgi")
    default_program: str = Field(default_factory=lambda: (os.getenv("MCP_RETRIEVAL_PROGRAM") or "").strip() or "blastp")
    default_database: str = Field(default_factory=lambda: (os.getenv("MCP_RETRIEVAL_DATABASE") or "").strip() or "swissprot")
    default_hitlist_size: int = Field(default_factory=lambda: max(1, _env_int("MCP_RETRIEVAL_HITLIST_SIZE", 25)))
    max_hitlist_size: int = Field(default_factory=lambda: max(1, _env_int("MCP_RETRIEVAL_MAX_HITLIST_SIZE", 100)))
    poll_interval_seconds: float = Field(default_factory=lambda: max(1.0, _env_float("MCP_RETRIEVAL_POLL_INTERVAL_S", 5.0)))
    max_poll_attempts: int = Field(default_factory=lambda: max(1, _env_int("MCP_RETRIEVAL_MAX_POLL_ATTEMPTS", 60)))
    request_timeout_seconds: float = Field(default_factory=lambda: max(1.0, _env_float("MCP_RETRIEVAL_REQUEST_TIMEOUT_S", 30.0)))


class RetrievalStorageConfig(BaseModel):
    data_dir: str = Field(default_factory=_default_retrieval_data_dir)
    duckdb_path: str = Field(default_factory=_default_retrieval_duckdb_path)
    parquet_export_dir: str = Field(default_factory=lambda: _retrieval_storage_paths(_default_retrieval_data_dir())["parquet_export_dir"])
    raw_payload_dir: str = Field(default_factory=lambda: _retrieval_storage_paths(_default_retrieval_data_dir())["raw_payload_dir"])
    manifest_dir: str = Field(default_factory=lambda: _retrieval_storage_paths(_default_retrieval_data_dir())["manifest_dir"])


class RetrievalConfig(BaseModel):
    provider: RetrievalProviderName = Field(default_factory=_default_retrieval_provider)
    feature_flags: RetrievalFeatureFlags = Field(default_factory=RetrievalFeatureFlags)
    blast: RetrievalBlastConfig = Field(default_factory=RetrievalBlastConfig)
    storage: RetrievalStorageConfig = Field(default_factory=RetrievalStorageConfig)


class RoutingConfig(BaseModel):
    mode: Literal["single", "fallback"] = "fallback"

    # Used when mode == "single"
    primary: ProviderName = "nim"

    # Used when mode == "fallback"; order to try.
    order: List[ProviderName] = Field(default_factory=lambda: ["embedded", "nim", "external"])


class MCPServerConfig(BaseModel):
    version: int = CURRENT_CONFIG_VERSION

    routing: RoutingConfig = Field(default_factory=RoutingConfig)

    nim: ProviderConfig = Field(default_factory=lambda: ProviderConfig(service_urls=default_nim_urls()))
    external: ProviderConfig = Field(default_factory=lambda: ProviderConfig(service_urls=default_external_urls()))
    embedded: EmbeddedConfig = Field(default_factory=EmbeddedConfig)
    retrieval: RetrievalConfig = Field(default_factory=RetrievalConfig)

    # Safety: allow runtime config edits. Defaults on for local stacks.
    allow_runtime_updates: bool = Field(default_factory=lambda: not _truthy_env("MCP_CONFIG_READONLY"))


@dataclass
class MigrationResult:
    data: Dict[str, Any]
    migrated: bool


def _migrate_persisted_config_data(data: Dict[str, Any], config_path: Optional[Path]) -> MigrationResult:
    if not isinstance(data, dict):
        defaults = MCPServerConfig()
        _apply_runtime_default_overrides(defaults, config_path)
        return MigrationResult(data=defaults.model_dump(), migrated=True)

    migrated = False
    version = data.get("version")
    try:
        version_num = int(version)
    except (TypeError, ValueError):
        # Treat missing or non-numeric persisted versions as pre-retrieval configs.
        version_num = 0

    if version_num >= CURRENT_CONFIG_VERSION and "retrieval" in data:
        return MigrationResult(data=data, migrated=False)

    migrated_data = dict(data)
    defaults = MCPServerConfig()
    _apply_retrieval_path_defaults(defaults, config_path)
    _apply_retrieval_env_overrides(defaults)

    if "retrieval" not in migrated_data:
        migrated_data["retrieval"] = defaults.retrieval.model_dump()
        migrated = True

    if version_num < CURRENT_CONFIG_VERSION:
        migrated_data["version"] = CURRENT_CONFIG_VERSION
        migrated = True

    return MigrationResult(data=migrated_data, migrated=migrated)


def _apply_runtime_default_overrides(cfg: MCPServerConfig, config_path: Optional[Path]) -> bool:
    return any(
        (
            _apply_retrieval_path_defaults(cfg, config_path),
            _apply_routing_env_overrides(cfg),
            _apply_embedded_env_overrides(cfg),
            _apply_retrieval_env_overrides(cfg),
        )
    )


def _apply_runtime_env_overrides(cfg: MCPServerConfig) -> bool:
    return any(
        (
            _apply_embedded_env_overrides(cfg),
            _apply_routing_env_overrides(cfg),
            _apply_retrieval_env_overrides(cfg),
        )
    )


class RuntimeConfigManager:
    def __init__(self, path: Optional[str] = None):
        configured_path = (path.strip() if isinstance(path, str) else "") or os.getenv("MCP_CONFIG_PATH", "").strip()
        self.path = Path(configured_path) if configured_path else Path()
        self._has_config_path = bool(configured_path)
        self._config = MCPServerConfig()
        self._revision = 0
        bootstrap_changed = _apply_runtime_default_overrides(
            self._config,
            self.path if self._has_config_path else None,
        )
        if bootstrap_changed:
            self._revision += 1
        self._load_from_disk_if_present()

        # Ensure there's always a persisted config file when MCP_CONFIG_PATH is set.
        # This makes the dashboard settings editable out-of-the-box.
        try:
            if self._has_config_path and not self.path.exists() and self._config.allow_runtime_updates:
                self._persist()
                self._revision += 1
        except Exception:
            pass

    @property
    def revision(self) -> int:
        return self._revision

    def get(self) -> MCPServerConfig:
        return self._config

    def _load_from_disk_if_present(self) -> None:
        if not self._has_config_path:
            return
        try:
            if not self.path.exists():
                return
            data = json.loads(self.path.read_text(encoding="utf-8"))
            migration = _migrate_persisted_config_data(
                data,
                self.path if self._has_config_path else None,
            )
            self._config = MCPServerConfig.model_validate(migration.data)

            config_changed = True

            # Optional startup migration for stale localhost defaults.
            if _migrate_localhost_nim_urls_from_env(self._config):
                config_changed = True
                if self._config.allow_runtime_updates:
                    self._persist()

            # Apply env overrides after loading persisted config.
            if _apply_runtime_env_overrides(self._config):
                config_changed = True

            if migration.migrated and self._config.allow_runtime_updates:
                self._persist()

            if config_changed:
                self._revision += 1
        except Exception:
            # Keep defaults if config file is invalid.
            return

    def _persist(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._config.model_dump(), indent=2), encoding="utf-8")

    def update(self, patch: Dict[str, Any]) -> MCPServerConfig:
        if not self._config.allow_runtime_updates:
            raise PermissionError("Runtime config updates are disabled (MCP_CONFIG_READONLY=1)")
        merged = self._config.model_dump()

        def deep_merge(dst: Dict[str, Any], src: Dict[str, Any]) -> Dict[str, Any]:
            for k, v in src.items():
                if isinstance(v, dict) and isinstance(dst.get(k), dict):
                    dst[k] = deep_merge(dst.get(k, {}), v)
                else:
                    dst[k] = v
            return dst

        merged = deep_merge(merged, patch)
        self._config = MCPServerConfig.model_validate(merged)
        self._revision += 1
        self._persist()
        return self._config

    def reset_to_defaults(self) -> MCPServerConfig:
        if not self._config.allow_runtime_updates:
            raise PermissionError("Runtime config updates are disabled (MCP_CONFIG_READONLY=1)")
        self._config = MCPServerConfig()
        _apply_runtime_default_overrides(self._config, self.path if self.path else None)
        self._revision += 1
        self._persist()
        return self._config
