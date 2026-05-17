#!/usr/bin/env python3
"""
MCP Server for Protein Binder Design
Implements Model Context Protocol endpoints for managing protein design workflows

Supports multiple backends:
- NIM Backend: NVIDIA NIM containers (default)
- Native Backend: Direct model execution on DGX Spark
- Hybrid Backend: Native with NIM fallback
"""

import os
import json
import asyncio
import contextlib
from dataclasses import asdict
from datetime import datetime
from typing import Dict, List, Optional, Any
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx
import logging

# Import model backend abstraction
from model_backends import BackendManager, EmbeddedBackend, allow_mock_outputs
from runtime_config import RuntimeConfigManager
from gpu_init import setup_gpu_for_server
from retrieval_store import RetrievalStore
from retrieval_service import BlastRetrievalService
from retrieval_provider import RetrievalConfigError, RetrievalError

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Runtime config + backend manager (supports NIM/external/embedded + fallback)
config_manager = RuntimeConfigManager()
backend_manager = BackendManager(config_manager)
runtime_config_lock = asyncio.Lock()

# Initialize GPU optimizations on startup
logger.info("Initializing GPU optimizations...")
gpu_optimizer = setup_gpu_for_server(profile_inference=os.getenv('PROFILE_INFERENCE', '').lower() == 'true')
logger.info(f"GPU optimization status: {gpu_optimizer.get_diagnostics()}")

app = FastAPI(
    title="Protein Binder Design MCP Server",
    description=f"Model Context Protocol server for managing protein design workflows\nBackend: {os.getenv('MODEL_BACKEND', 'nim')}",
    version="1.0.0"
)
app.state.retrieval_store = RetrievalStore(config_manager.get().retrieval)
app.state.retrieval_service = BlastRetrievalService(
    config=config_manager.get().retrieval,
    store=app.state.retrieval_store,
)


# GPU Status Endpoint
@app.get("/api/gpu/status")
async def get_gpu_status():
    """Get GPU optimization status and diagnostics"""
    return gpu_optimizer.get_diagnostics()


def _truthy_env(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _running_in_docker() -> bool:
    try:
        return os.path.exists("/.dockerenv") or _truthy_env("DOCKER_CONTAINER")
    except Exception:
        return False


async def _maybe_autobootstrap_embedded_assets() -> None:
    """Start a best-effort embedded bootstrap in the background.

    This is intentionally non-blocking: the dashboard and server come up
    immediately, while assets stream in.
    """
    try:
        cfg = config_manager.get().embedded
        if not getattr(cfg, "enabled", True):
            return
        if not (getattr(cfg, "auto_download", False) or getattr(cfg, "auto_install", False)):
            return

        # Default behavior:
        # - in Docker: auto bootstrap unless explicitly disabled
        # - outside Docker: require explicit opt-in
        if _running_in_docker():
            if _truthy_env("MCP_BOOTSTRAP_ON_STARTUP") is False and ("MCP_BOOTSTRAP_ON_STARTUP" in os.environ):
                return
        else:
            if not _truthy_env("MCP_BOOTSTRAP_ON_STARTUP"):
                return

        # Only bootstrap models that have explicit URLs configured (except ProteinMPNN which may bootstrap source).
        models: List[str] = []
        try:
            dl = getattr(cfg, "downloads", None)
            if (
                getattr(dl, "proteinmpnn_source_tarball_url", None)
                or getattr(dl, "proteinmpnn_weights_url", None)
                or os.getenv("PROTEINMPNN_WEIGHTS_URL")
                or os.getenv("PROTEINMPNN_SOURCE_TARBALL_URL")
                or _truthy_env("MCP_PROTEINMPNN_DEFAULT_WEIGHTS")
            ):
                models.append("proteinmpnn")
            if (getattr(dl, "rfdiffusion_weights_url", None) or os.getenv("RFDIFFUSION_WEIGHTS_URL") or _truthy_env("MCP_RFDIFFUSION_DEFAULT_WEIGHTS")):
                models.append("rfdiffusion")
            preset = (os.getenv("MCP_ALPHAFOLD_DB_PRESET") or "").strip().lower()
            if (getattr(dl, "alphafold_db_url", None) or os.getenv("ALPHAFOLD_DB_URL") or preset in {"reduced", "reduced_dbs"}):
                models.append("alphafold")
        except Exception:
            pass

        # If nothing is configured, do nothing (no surprises).
        if not models:
            return

        logger.info("Starting background embedded bootstrap: %s", models)
        backend = EmbeddedBackend(cfg)
        await asyncio.to_thread(backend.bootstrap_assets, models)
        logger.info("Background embedded bootstrap finished")
    except Exception as exc:
        logger.warning("Background embedded bootstrap failed: %s", exc)


@app.on_event("startup")
async def _startup_tasks() -> None:
    # Do not block startup; run bootstrap in background.
    try:
        asyncio.create_task(_maybe_autobootstrap_embedded_assets())
    except Exception:
        pass
    try:
        retrieval_error = await asyncio.to_thread(app.state.retrieval_store.initialize_if_enabled)
        if retrieval_error:
            logger.warning("BLAST retrieval startup initialization failed: %s", retrieval_error)
    except Exception:
        pass


async def _refresh_retrieval_store() -> None:
    app.state.retrieval_store.update_config(config_manager.get().retrieval)
    app.state.retrieval_service = BlastRetrievalService(
        config=config_manager.get().retrieval,
        store=app.state.retrieval_store,
    )
    retrieval_error = await asyncio.to_thread(app.state.retrieval_store.initialize_if_enabled)
    if retrieval_error:
        logger.warning("BLAST retrieval initialization failed after config refresh: %s", retrieval_error)


def _retrieval_runtime_config():
    return config_manager.get().retrieval


def _ensure_retrieval_rest_enabled():
    cfg = _retrieval_runtime_config()
    if not cfg.feature_flags.enabled or not cfg.feature_flags.expose_rest:
        raise HTTPException(status_code=404, detail="BLAST retrieval REST endpoints are disabled")
    return cfg


def _ensure_retrieval_mcp_enabled() -> None:
    cfg = _retrieval_runtime_config()
    if not cfg.feature_flags.enabled or not cfg.feature_flags.expose_mcp:
        raise RuntimeError("BLAST retrieval MCP tools are disabled")


def _serialize_retrieval_result(result: Any) -> Dict[str, Any]:
    if hasattr(result, "__dataclass_fields__"):
        return asdict(result)
    return dict(result)


@app.get("/api/config")
async def get_runtime_config() -> Dict[str, Any]:
    """Get MCP server runtime config (used by the dashboard settings UI)."""
    return config_manager.get().model_dump()


@app.put("/api/config")
async def update_runtime_config(request: Request) -> Dict[str, Any]:
    """Update MCP server runtime config.

    Accepts a partial config object; merges into current config and persists
    to MCP_CONFIG_PATH if set.
    """
    patch = await request.json()
    try:
        async with runtime_config_lock:
            updated = config_manager.update(patch)
            # Force backend rebuild on next use.
            _ = backend_manager.get()
            await _refresh_retrieval_store()
            return updated.model_dump()
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/config/reset")
async def reset_runtime_config() -> Dict[str, Any]:
    """Reset runtime config to defaults."""
    try:
        async with runtime_config_lock:
            updated = config_manager.reset_to_defaults()
            _ = backend_manager.get()
            await _refresh_retrieval_store()
            return updated.model_dump()
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))


# AlphaFold optimization settings endpoints
@app.get("/api/alphafold/settings")
async def get_alphafold_settings() -> Dict[str, Any]:
    """Get current AlphaFold optimization settings."""
    return alphafold_settings


@app.post("/api/alphafold/settings")
async def update_alphafold_settings(request: Request) -> Dict[str, Any]:
    """Update AlphaFold optimization settings.
    
    Body:
      {
        "speed_preset": "balanced",
        "disable_templates": false,
        "num_recycles": 3,
        "num_ensemble": 1,
        "mmseqs2_max_seqs": 512,
        "msa_mode": "mmseqs2"
      }
    """
    global alphafold_settings
    
    try:
        payload = await request.json()
        # Validate and merge settings
        settings = AlphaFoldOptimizationSettings(**payload)
        
        # Update global settings (keep existing values if not provided)
        for key, value in settings.model_dump(exclude_unset=True).items():
            if value is not None:
                alphafold_settings[key] = value
        
        return {
            "success": True,
            "settings": alphafold_settings,
            "message": "AlphaFold settings updated successfully"
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid settings: {str(exc)}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/alphafold/settings/reset")
async def reset_alphafold_settings() -> Dict[str, Any]:
    """Reset AlphaFold settings to defaults."""
    global alphafold_settings
    
    alphafold_settings = {
        "speed_preset": "balanced",
        "disable_templates": False,
        "num_recycles": 3,
        "num_ensemble": 1,
        "mmseqs2_max_seqs": 512,
        "msa_mode": "mmseqs2",
    }
    
    return {
        "success": True,
        "settings": alphafold_settings,
        "message": "AlphaFold settings reset to defaults"
    }


@app.post("/api/embedded/bootstrap")
async def embedded_bootstrap(request: Request) -> Dict[str, Any]:
    """Trigger a best-effort embedded download/bootstrap.

    Body:
      {"models": ["proteinmpnn", "rfdiffusion", "alphafold"]}

    This is intended for convenience (downloads to /models). It only downloads
    assets when explicit URLs are configured in runtime config.
    """

    payload = {}
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, list) or not models:
        models = ["proteinmpnn"]

    cfg = config_manager.get().embedded
    if not cfg.enabled:
        raise HTTPException(status_code=400, detail="Embedded provider is disabled")
    if not getattr(cfg, "auto_download", False) and not getattr(cfg, "auto_install", False):
        raise HTTPException(
            status_code=400,
            detail="Embedded bootstrap is disabled (enable embedded.auto_download or embedded.auto_install)",
        )

    backend = EmbeddedBackend(cfg)
    try:
        result = await asyncio.to_thread(backend.bootstrap_assets, models)
        return {"ok": True, "results": result}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

# Enable CORS for dashboard
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify dashboard URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job storage (in production, use a database)
jobs_db: Dict[str, Dict[str, Any]] = {}

# Simple in-memory SSE broadcaster
subscribers: List[asyncio.Queue] = []

async def broadcast_event(event: Dict[str, Any]):
    data = event
    for q in list(subscribers):
        try:
            await q.put(data)
        except Exception:
            # ignore subscriber errors
            pass

# Pydantic models for request/response
class ProteinSequenceInput(BaseModel):
    sequence: str = Field(..., description="Target protein amino acid sequence")
    job_name: Optional[str] = Field(None, description="Optional name for the job")
    num_designs: int = Field(5, description="Number of binder designs to generate")


class RetrievalRequestInput(BaseModel):
    sequence: str = Field(..., description="Protein amino acid sequence or FASTA query")
    program: Optional[str] = Field(None, description="Optional BLAST program override")
    database: Optional[str] = Field(None, description="Optional BLAST database override")
    hitlist_size: Optional[int] = Field(None, description="Optional BLAST hitlist size override")

# AlphaFold optimization settings
class AlphaFoldOptimizationSettings(BaseModel):
    speed_preset: Optional[str] = Field(
        "balanced",
        description="Speed preset: fast (29% faster), balanced (20% faster, default), quality (slowest)"
    )
    disable_templates: Optional[bool] = Field(
        None,
        description="Disable template search for speed"
    )
    num_recycles: Optional[int] = Field(
        None,
        description="Number of recycling iterations (3 for speed, -1 for model default ~20)"
    )
    num_ensemble: Optional[int] = Field(
        None,
        description="Number of ensemble evaluations (1 for speed, 8 for quality)"
    )
    mmseqs2_max_seqs: Optional[int] = Field(
        None,
        description="Maximum sequences for MMseqs2 MSA (512 for speed, 10000 for quality)"
    )
    msa_mode: Optional[str] = Field(
        None,
        description="MSA generation mode: jackhmmer or mmseqs2"
    )

# Global AlphaFold settings (in-memory, can be expanded to persistence)
alphafold_settings: Dict[str, Any] = {
    "speed_preset": "balanced",
    "disable_templates": False,
    "num_recycles": 3,
    "num_ensemble": 1,
    "mmseqs2_max_seqs": 512,
    "msa_mode": "mmseqs2",
}
    
class JobStatus(BaseModel):
    job_id: str
    status: str
    created_at: str
    updated_at: str
    job_name: Optional[str] = None
    current_stage: Optional[str] = None
    progress_pct: Optional[float] = None
    progress_message: Optional[str] = None
    progress: Dict[str, Any]
    results: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    error_detail: Optional[str] = None
    metrics: Optional[Dict[str, Any]] = None


def _public_job_dict(job: Dict[str, Any], *, include_error_detail: bool = False) -> Dict[str, Any]:
    """Return a client-safe job dict.

    By default, hides verbose error output (error_detail) which can be huge and
    noisy for dashboards/CLI.
    """
    data = dict(job)
    if not include_error_detail:
        data.pop("error_detail", None)
    return data

class ToolInfo(BaseModel):
    name: str
    description: str
    inputSchema: Dict[str, Any]

class ResourceInfo(BaseModel):
    uri: str
    name: str
    description: str
    mimeType: str

# MCP Protocol endpoints
@app.get("/mcp/v1/tools")
async def list_tools() -> Dict[str, List[ToolInfo]]:
    """List available MCP tools"""
    tools = [
        ToolInfo(
            name="get_runtime_config",
            description="Get the MCP server runtime routing/provider config",
            inputSchema={"type": "object", "properties": {}},
        ),
        ToolInfo(
            name="update_runtime_config",
            description="Update the MCP server runtime config (deep-merged and persisted when enabled)",
            inputSchema={
                "type": "object",
                "properties": {
                    "patch": {
                        "type": "object",
                        "description": "Partial config patch to merge into current config",
                    }
                },
            },
        ),
        ToolInfo(
            name="reset_runtime_config",
            description="Reset the MCP server runtime config to defaults",
            inputSchema={"type": "object", "properties": {}},
        ),
        ToolInfo(
            name="embedded_bootstrap",
            description="Trigger best-effort embedded asset bootstrap/download into /models",
            inputSchema={
                "type": "object",
                "properties": {
                    "models": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Subset of models to bootstrap: proteinmpnn, rfdiffusion, alphafold",
                    }
                },
            },
        ),
        ToolInfo(
            name="design_protein_binder",
            description="Design protein binders for a target sequence",
            inputSchema={
                "type": "object",
                "properties": {
                    "sequence": {
                        "type": "string",
                        "description": "Target protein amino acid sequence"
                    },
                    "job_name": {
                        "type": "string",
                        "description": "Optional name for the job"
                    },
                    "num_designs": {
                        "type": "integer",
                        "description": "Number of binder designs to generate",
                        "default": 5
                    }
                },
                "required": ["sequence"]
            }
        ),
        ToolInfo(
            name="get_job_status",
            description="Get the status of a protein design job",
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "Job ID to query"
                    }
                },
                "required": ["job_id"]
            }
        ),
        ToolInfo(
            name="list_jobs",
            description="List all protein design jobs",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        ToolInfo(
            name="delete_job",
            description="Delete a protein design job",
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "Job ID to delete"
                    }
                },
                "required": ["job_id"]
            }
        ),
        ToolInfo(
            name="check_services",
            description="Check status of all backend services (NIM/native/hybrid)",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        ToolInfo(
            name="predict_structure",
            description="Predict structure from sequence (AlphaFold2 backend)",
            inputSchema={
                "type": "object",
                "properties": {
                    "sequence": {
                        "type": "string",
                        "description": "Protein amino acid sequence"
                    }
                },
                "required": ["sequence"]
            }
        ),
        ToolInfo(
            name="design_binder_backbone",
            description="Generate binder backbones from a target PDB (RFDiffusion backend)",
            inputSchema={
                "type": "object",
                "properties": {
                    "target_pdb": {
                        "type": "string",
                        "description": "Target protein PDB content (string)"
                    },
                    "num_designs": {
                        "type": "integer",
                        "description": "Number of backbones to generate",
                        "default": 5
                    }
                },
                "required": ["target_pdb"]
            }
        ),
        ToolInfo(
            name="generate_sequence",
            description="Generate binder sequence from a backbone PDB (ProteinMPNN backend)",
            inputSchema={
                "type": "object",
                "properties": {
                    "backbone_pdb": {
                        "type": "string",
                        "description": "Backbone PDB content (string)"
                    }
                },
                "required": ["backbone_pdb"]
            }
        ),
        ToolInfo(
            name="predict_complex",
            description="Predict complex structure from sequences (AlphaFold2-Multimer backend)",
            inputSchema={
                "type": "object",
                "properties": {
                    "sequences": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of chain sequences"
                    }
                },
                "required": ["sequences"]
            }
        ),
        ToolInfo(
            name="get_alphafold_settings",
            description="Get current AlphaFold optimization settings",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        ToolInfo(
            name="update_alphafold_settings",
            description="Update AlphaFold optimization settings (speed_preset, disable_templates, num_recycles, etc.)",
            inputSchema={
                "type": "object",
                "properties": {
                    "speed_preset": {
                        "type": "string",
                        "description": "Speed preset: fast (29% faster), balanced (20% faster, default), quality (slowest)"
                    },
                    "disable_templates": {
                        "type": "boolean",
                        "description": "Disable template search for speed"
                    },
                    "num_recycles": {
                        "type": "integer",
                        "description": "Number of recycling iterations (3 for speed, -1 for model default ~20)"
                    },
                    "num_ensemble": {
                        "type": "integer",
                        "description": "Number of ensemble evaluations"
                    },
                    "mmseqs2_max_seqs": {
                        "type": "integer",
                        "description": "Maximum sequences for MMseqs2 MSA"
                    },
                    "msa_mode": {
                        "type": "string",
                        "description": "MSA mode: jackhmmer or mmseqs2"
                    }
                }
            }
        ),
        ToolInfo(
            name="reset_alphafold_settings",
            description="Reset AlphaFold optimization settings to defaults",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
    ]
    retrieval_cfg = _retrieval_runtime_config()
    if retrieval_cfg.feature_flags.enabled and retrieval_cfg.feature_flags.expose_mcp:
        tools.extend(
            [
                ToolInfo(
                    name="start_blast_retrieval",
                    description="Run BLAST retrieval for a sequence and return normalized evidence results",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "sequence": {"type": "string", "description": "Protein amino acid sequence or FASTA query"},
                            "program": {"type": "string", "description": "Optional BLAST program override"},
                            "database": {"type": "string", "description": "Optional BLAST database override"},
                            "hitlist_size": {"type": "integer", "description": "Optional BLAST hitlist size override"},
                        },
                        "required": ["sequence"],
                    },
                ),
                ToolInfo(
                    name="get_blast_retrieval",
                    description="Fetch a normalized BLAST retrieval result by request id",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "request_id": {"type": "string", "description": "Retrieval request id to read"},
                        },
                        "required": ["request_id"],
                    },
                ),
            ]
        )
    return {"tools": tools}


def _jsonrpc_error(_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": _id, "error": {"code": code, "message": message}}


def _jsonrpc_result(_id: Any, result: Any) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": _id, "result": result}


def _mcp_initialize_result() -> Dict[str, Any]:
    # Keep in sync with tools/mcp_stdio_adapter.py
    return {
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {},
            "resources": {},
            "logging": {},
        },
        "serverInfo": {"name": "protein-binder-mcp-server", "version": "1.0.0"},
    }


@app.post("/mcp")
async def mcp_jsonrpc(request: Request) -> Dict[str, Any]:
    """JSON-RPC 2.0 endpoint for MCP clients that use HTTP transport.

    This is in addition to the REST-style MCP endpoints under /mcp/v1/*.
    """
    global alphafold_settings
    
    try:
        message = await request.json()
    except Exception:
        return _jsonrpc_error(None, -32700, "Parse error")

    if not isinstance(message, dict):
        return _jsonrpc_error(None, -32600, "Invalid Request")

    msg_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}

    try:
        model_backend = backend_manager.get()
        if method == "initialize":
            return _jsonrpc_result(msg_id, _mcp_initialize_result())

        if method == "tools/list":
            tools = (await list_tools()).get("tools", [])
            return _jsonrpc_result(msg_id, {"tools": tools})

        if method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments") or {}

            if name == "get_runtime_config":
                cfg = config_manager.get().model_dump()
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(cfg, indent=2)}], "isError": False},
                )

            if name == "update_runtime_config":
                patch = arguments
                if isinstance(arguments, dict) and isinstance(arguments.get("patch"), dict):
                    patch = arguments.get("patch")
                if not isinstance(patch, dict):
                    return _jsonrpc_error(msg_id, -32602, "Invalid patch")
                async with runtime_config_lock:
                    updated = config_manager.update(patch)
                    _ = backend_manager.get()
                    await _refresh_retrieval_store()
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(updated.model_dump(), indent=2)}], "isError": False},
                )

            if name == "reset_runtime_config":
                async with runtime_config_lock:
                    updated = config_manager.reset_to_defaults()
                    _ = backend_manager.get()
                    await _refresh_retrieval_store()
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(updated.model_dump(), indent=2)}], "isError": False},
                )

            if name == "embedded_bootstrap":
                models = []
                if isinstance(arguments, dict) and isinstance(arguments.get("models"), list):
                    models = [str(x) for x in arguments.get("models") if str(x).strip()]
                if not models:
                    models = ["proteinmpnn"]

                cfg = config_manager.get().embedded
                if not cfg.enabled:
                    return _jsonrpc_error(msg_id, -32000, "Embedded provider is disabled")
                if not getattr(cfg, "auto_download", False) and not getattr(cfg, "auto_install", False):
                    return _jsonrpc_error(
                        msg_id,
                        -32000,
                        "Embedded bootstrap is disabled (enable embedded.auto_download or embedded.auto_install)",
                    )

                backend = EmbeddedBackend(cfg)
                result = await asyncio.to_thread(backend.bootstrap_assets, models)
                payload = {"ok": True, "results": result}
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}], "isError": False},
                )

            if name == "start_blast_retrieval":
                try:
                    _ensure_retrieval_mcp_enabled()
                except RuntimeError:
                    return _jsonrpc_error(msg_id, -32000, "BLAST retrieval MCP tools are disabled")
                sequence = arguments.get("sequence")
                if not sequence:
                    return _jsonrpc_error(msg_id, -32602, "Missing sequence")
                result = await app.state.retrieval_service.retrieve(
                    sequence,
                    program=arguments.get("program"),
                    database=arguments.get("database"),
                    hitlist_size=arguments.get("hitlist_size"),
                )
                return _jsonrpc_result(
                    msg_id,
                    {
                        "content": [{"type": "text", "text": json.dumps(_serialize_retrieval_result(result), indent=2, default=str)}],
                        "isError": False,
                    },
                )

            if name == "get_blast_retrieval":
                try:
                    _ensure_retrieval_mcp_enabled()
                except RuntimeError:
                    return _jsonrpc_error(msg_id, -32000, "BLAST retrieval MCP tools are disabled")
                request_id = arguments.get("request_id")
                if not request_id:
                    return _jsonrpc_error(msg_id, -32602, "Missing request_id")
                result = await asyncio.to_thread(app.state.retrieval_service.get_request_result, request_id)
                if not result:
                    return _jsonrpc_error(msg_id, -32000, "BLAST retrieval request not found")
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(result, indent=2, default=str)}], "isError": False},
                )

            if name == "design_protein_binder":
                input_data = ProteinSequenceInput(**arguments)
                job_id = f"job_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{len(jobs_db)}"
                job = {
                    "job_id": job_id,
                    "status": "created",
                    "created_at": datetime.now().isoformat(),
                    "updated_at": datetime.now().isoformat(),
                    "job_name": input_data.job_name,
                    "input": {"sequence": input_data.sequence, "num_designs": input_data.num_designs},
                    "progress": {
                        "alphafold": "pending",
                        "rfdiffusion": "pending",
                        "proteinmpnn": "pending",
                        "alphafold_multimer": "pending",
                    },
                    "results": None,
                    "error": None,
                    "metrics": None,
                }
                jobs_db[job_id] = job
                try:
                    asyncio.create_task(broadcast_event({"type": "job.created", "job": _public_job_dict(job)}))
                except Exception:
                    pass
                asyncio.create_task(process_job(job_id))
                return _jsonrpc_result(
                    msg_id,
                    {
                        "content": [{"type": "text", "text": json.dumps(JobStatus(**job).model_dump(exclude_unset=True), indent=2)}],
                        "isError": False,
                    },
                )

            if name == "get_job_status":
                job_id = arguments.get("job_id")
                if not job_id or job_id not in jobs_db:
                    return _jsonrpc_error(msg_id, -32004, "Job not found")
                include_error_detail = bool(arguments.get("include_error_detail")) if isinstance(arguments, dict) else False
                job = JobStatus(**_public_job_dict(jobs_db[job_id], include_error_detail=include_error_detail)).model_dump(exclude_unset=True)
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(job, indent=2)}], "isError": False},
                )

            if name == "list_jobs":
                jobs = [JobStatus(**_public_job_dict(j)).model_dump(exclude_unset=True) for j in jobs_db.values()]
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(jobs, indent=2)}], "isError": False},
                )

            if name == "delete_job":
                job_id = arguments.get("job_id")
                if not job_id or job_id not in jobs_db:
                    return _jsonrpc_error(msg_id, -32004, "Job not found")
                deleted = jobs_db.pop(job_id)
                try:
                    asyncio.create_task(broadcast_event({"type": "job.deleted", "job": _public_job_dict(deleted)}))
                except Exception:
                    pass
                return _jsonrpc_result(
                    msg_id,
                    {
                        "content": [{"type": "text", "text": json.dumps({"deleted": job_id}, indent=2)}],
                        "isError": False,
                    },
                )

            if name == "check_services":
                status = await model_backend.check_health()
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(status, indent=2)}], "isError": False},
                )

            if name == "predict_structure":
                sequence = arguments.get("sequence")
                if not sequence:
                    return _jsonrpc_error(msg_id, -32602, "Missing sequence")
                result = await model_backend.predict_structure(sequence)
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(result, indent=2)}], "isError": False},
                )

            if name == "design_binder_backbone":
                target_pdb = arguments.get("target_pdb")
                if not target_pdb:
                    return _jsonrpc_error(msg_id, -32602, "Missing target_pdb")
                num_designs = int(arguments.get("num_designs") or 5)
                result = await model_backend.design_binder_backbone(target_pdb, num_designs)
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(result, indent=2)}], "isError": False},
                )

            if name == "generate_sequence":
                backbone_pdb = arguments.get("backbone_pdb")
                if not backbone_pdb:
                    return _jsonrpc_error(msg_id, -32602, "Missing backbone_pdb")
                result = await model_backend.generate_sequence(backbone_pdb)
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(result, indent=2)}], "isError": False},
                )

            if name == "predict_complex":
                sequences = arguments.get("sequences")
                if not sequences or not isinstance(sequences, list):
                    return _jsonrpc_error(msg_id, -32602, "Missing sequences")
                result = await model_backend.predict_complex(sequences)
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(result, indent=2)}], "isError": False},
                )

            if name == "get_alphafold_settings":
                return _jsonrpc_result(
                    msg_id,
                    {"content": [{"type": "text", "text": json.dumps(alphafold_settings, indent=2)}], "isError": False},
                )

            if name == "update_alphafold_settings":
                try:
                    settings_input = AlphaFoldOptimizationSettings(**arguments)
                    # Update global settings
                    for key, value in settings_input.model_dump(exclude_unset=True).items():
                        if value is not None:
                            alphafold_settings[key] = value
                    return _jsonrpc_result(
                        msg_id,
                        {
                            "content": [{
                                "type": "text",
                                "text": json.dumps({
                                    "success": True,
                                    "settings": alphafold_settings,
                                    "message": "AlphaFold settings updated successfully"
                                }, indent=2)
                            }],
                            "isError": False,
                        },
                    )
                except Exception as exc:
                    return _jsonrpc_error(msg_id, -32602, f"Invalid settings: {str(exc)}")

            if name == "reset_alphafold_settings":
                alphafold_settings = {
                    "speed_preset": "balanced",
                    "disable_templates": False,
                    "num_recycles": 3,
                    "num_ensemble": 1,
                    "mmseqs2_max_seqs": 512,
                    "msa_mode": "mmseqs2",
                }
                return _jsonrpc_result(
                    msg_id,
                    {
                        "content": [{
                            "type": "text",
                            "text": json.dumps({
                                "success": True,
                                "settings": alphafold_settings,
                                "message": "AlphaFold settings reset to defaults"
                            }, indent=2)
                        }],
                        "isError": False,
                    },
                )

            return _jsonrpc_error(msg_id, -32601, f"Unknown tool: {name}")

        if method == "resources/list":
            resources = (await list_resources()).get("resources", [])
            return _jsonrpc_result(msg_id, {"resources": resources})

        if method == "resources/read":
            uri = params.get("uri") or params.get("path")
            if not uri:
                return _jsonrpc_error(msg_id, -32602, "Missing resource uri")
            if uri.startswith("job://"):
                job_id = uri.replace("job://", "")
            else:
                job_id = uri
            contents = (await get_resource(job_id)).get("contents", [])
            return _jsonrpc_result(msg_id, {"contents": contents})

        if method in {"shutdown", "exit"}:
            return _jsonrpc_result(msg_id, None)

        return _jsonrpc_error(msg_id, -32601, f"Method not found: {method}")
    except RetrievalConfigError as exc:
        return _jsonrpc_error(msg_id, -32602, str(exc))
    except RetrievalError as exc:
        logger.warning("Retrieval MCP tool failed: %s", exc)
        return _jsonrpc_error(msg_id, -32000, str(exc))
    except Exception:
        logger.exception("Unhandled MCP JSON-RPC error")
        return _jsonrpc_error(msg_id, -32603, "Internal server error")

@app.get("/mcp/v1/resources")
async def list_resources() -> Dict[str, List[ResourceInfo]]:
    """List available MCP resources"""
    resources = []
    for job_id, job in jobs_db.items():
        if job.get("results"):
            resources.append(ResourceInfo(
                uri=f"job://{job_id}",
                name=job.get("job_name", job_id),
                description=f"Results for protein design job {job_id}",
                mimeType="application/json"
            ))
    return {"resources": resources}

@app.get("/mcp/v1/resources/{job_id}")
async def get_resource(job_id: str) -> Dict[str, Any]:
    """Get a specific resource"""
    if job_id not in jobs_db:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = jobs_db[job_id]
    if not job.get("results"):
        raise HTTPException(status_code=404, detail="Job results not available yet")
    
    return {
        "contents": [
            {
                "uri": f"job://{job_id}",
                "mimeType": "application/json",
                "text": json.dumps(job["results"], indent=2)
            }
        ]
    }


@app.post("/api/retrieval/requests")
async def create_retrieval_request(input_data: RetrievalRequestInput) -> Dict[str, Any]:
    """Submit a BLAST retrieval request and return the normalized evidence result."""
    _ensure_retrieval_rest_enabled()
    result = await app.state.retrieval_service.retrieve(
        input_data.sequence,
        program=input_data.program,
        database=input_data.database,
        hitlist_size=input_data.hitlist_size,
    )
    return _serialize_retrieval_result(result)


@app.get("/api/retrieval/requests/{request_id}")
async def get_retrieval_request(request_id: str) -> Dict[str, Any]:
    """Poll a BLAST retrieval request/result by request id."""
    _ensure_retrieval_rest_enabled()
    result = await asyncio.to_thread(app.state.retrieval_service.get_request_result, request_id)
    if not result:
        raise HTTPException(status_code=404, detail="BLAST retrieval request not found")
    return result


@app.get("/api/retrieval/cache")
async def list_retrieval_cache(limit: int = Query(100, ge=1, le=1000)) -> Dict[str, Any]:
    """List cached BLAST retrieval entries."""
    _ensure_retrieval_rest_enabled()
    entries = await asyncio.to_thread(app.state.retrieval_service.list_cached_requests, limit=limit)
    return {"entries": entries}


# Job management endpoints
@app.post("/api/jobs", response_model=JobStatus, response_model_exclude_unset=True)
async def create_job(
    input_data: ProteinSequenceInput,
    background_tasks: BackgroundTasks
) -> JobStatus:
    """Create a new protein binder design job"""
    job_id = f"job_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{len(jobs_db)}"
    
    job = {
        "job_id": job_id,
        "status": "created",
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "job_name": input_data.job_name,
        "current_stage": None,
        "progress_pct": 0.0,
        "progress_message": "Created",
        "input": {
            "sequence": input_data.sequence,
            "num_designs": input_data.num_designs
        },
        "progress": {
            "alphafold": "pending",
            "rfdiffusion": "pending",
            "proteinmpnn": "pending",
            "alphafold_multimer": "pending"
        },
        "results": None,
        "error": None,
        "metrics": None,
    }
    
    jobs_db[job_id] = job
    
    # notify subscribers about new job
    try:
        asyncio.create_task(broadcast_event({"type": "job.created", "job": _public_job_dict(job)}))
    except Exception:
        pass
    # Start job processing in background
    background_tasks.add_task(process_job, job_id)
    
    return JobStatus(**job)

@app.get("/api/jobs", response_model=List[JobStatus], response_model_exclude_unset=True)
async def list_jobs() -> List[JobStatus]:
    """List all jobs"""
    return [JobStatus(**_public_job_dict(job)) for job in jobs_db.values()]

@app.get("/api/jobs/{job_id}", response_model=JobStatus, response_model_exclude_unset=True)
async def get_job(
    job_id: str,
    include_metrics: bool = True,
    include_residency: bool = False,
    include_error_detail: bool = False,
) -> JobStatus:
    """Get job status.

    include_metrics:
      Adds lightweight host metrics when the host-native AlphaFold service is reachable.
    include_residency:
      Also requests a (slower) best-effort page-cache residency estimate for key DB files.
    """
    if job_id not in jobs_db:
        raise HTTPException(status_code=404, detail="Job not found")

    job = dict(jobs_db[job_id])

    if include_metrics:
        try:
            import httpx

            params = {"include_residency": "1" if include_residency else "0"}
            # Keep this fast; dashboard polls frequently.
            async with httpx.AsyncClient(timeout=1.5) as client:
                r = await client.get("http://127.0.0.1:18081/v1/metrics", params=params)
                if r.status_code == 200:
                    existing_metrics = job.get("metrics") or {}
                    alphafold_metrics = existing_metrics.get("alphafold_host")
                    if not isinstance(alphafold_metrics, dict):
                        alphafold_metrics = {}
                    alphafold_metrics["latest"] = r.json()
                    alphafold_metrics["latest_at"] = datetime.now().isoformat()
                    existing_metrics["alphafold_host"] = alphafold_metrics
                    job["metrics"] = existing_metrics
        except Exception:
            # Metrics are best-effort; never break job polling.
            pass

    return JobStatus(**_public_job_dict(job, include_error_detail=include_error_detail))

@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str) -> Dict[str, str]:
    """Delete a job"""
    if job_id not in jobs_db:
        raise HTTPException(status_code=404, detail="Job not found")
    del jobs_db[job_id]
    return {"message": "Job deleted successfully"}

# Health check endpoints
@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """Health check endpoint"""
    return {
        "status": "healthy",
        "retrieval": app.state.retrieval_store.diagnostics(),
    }

@app.get("/api/services/status")
async def check_services() -> Dict[str, Any]:
    """Check status of all backend services"""
    return await backend_manager.get().check_health()


@app.get('/sse')
async def sse_endpoint(request: Request):
    async def event_generator():
        q: asyncio.Queue = asyncio.Queue()
        subscribers.append(q)
        try:
            # immediate handshake
            yield "data: ready\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    # heartbeat to keep connection alive
                    yield "data: ping\n\n"
                except asyncio.CancelledError:
                    break
        finally:
            try:
                subscribers.remove(q)
            except ValueError:
                pass

    return StreamingResponse(event_generator(), media_type='text/event-stream')


@app.get('/mcp/sse')
async def mcp_sse_endpoint(request: Request):
    """Alias of /sse for clients expecting an MCP-namespaced SSE endpoint."""
    return await sse_endpoint(request)

# Background job processing
def _job_touch(job: Dict[str, Any]) -> None:
    job["updated_at"] = datetime.now().isoformat()


def _job_set_progress(job: Dict[str, Any], *, stage: str, pct: float, message: str) -> None:
    job["current_stage"] = stage
    job["progress_pct"] = round(float(pct), 2)
    job["progress_message"] = message
    _job_touch(job)


def _summarize_error(exc: BaseException, *, max_len: int = 500) -> str:
    """Create a short, UI-safe error string for job status fields.

    Full details should remain available in server logs.
    """
    try:
        if isinstance(exc, HTTPException):
            raw = f"HTTP {exc.status_code}: {exc.detail}"
        else:
            raw = str(exc)
    except Exception:
        raw = type(exc).__name__

    raw = (raw or type(exc).__name__).strip()
    # Collapse whitespace/newlines so progress/job JSON stays compact.
    raw = " ".join(raw.split())

    if max_len > 0 and len(raw) > max_len:
        raw = raw[: max(0, max_len - 14)].rstrip() + " …(truncated)"
    return raw


def _error_detail(exc: BaseException, *, max_len: int = 20000) -> str:
    """Best-effort full error text for debugging.

    Intended to be returned only on explicit request (include_error_detail=1).
    """
    try:
        raw = str(exc)
    except Exception:
        raw = repr(exc)
    raw = raw or type(exc).__name__
    if max_len > 0 and len(raw) > max_len:
        raw = raw[: max(0, max_len - 14)].rstrip() + " …(truncated)"
    return raw


async def _cancel_and_await(task: Optional[asyncio.Task]) -> None:
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def _job_metrics(job: Dict[str, Any]) -> Dict[str, Any]:
    metrics = job.get("metrics")
    if not isinstance(metrics, dict):
        metrics = {}
        job["metrics"] = metrics
    return metrics


def _stage_metrics(job: Dict[str, Any]) -> Dict[str, Any]:
    metrics = _job_metrics(job)
    stages = metrics.get("stages")
    if not isinstance(stages, dict):
        stages = {}
        metrics["stages"] = stages
    return stages


async def _job_heartbeat(job: Dict[str, Any], interval_s: float = 10.0) -> None:
    while True:
        await asyncio.sleep(interval_s)
        _job_touch(job)


async def _alphafold_host_snapshot(include_residency: bool = False) -> Optional[Dict[str, Any]]:
    try:
        import httpx

        params = {"include_residency": "1" if include_residency else "0"}
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get("http://127.0.0.1:18081/v1/metrics", params=params)
            if r.status_code == 200:
                return r.json()
    except Exception:
        return None
    return None


async def process_job(job_id: str):
    """Process a protein binder design job using configured backend"""
    try:
        model_backend = backend_manager.get()
        job = jobs_db[job_id]
        job["status"] = "running"
        _job_set_progress(job, stage="starting", pct=0, message="Starting job")
        try:
            asyncio.create_task(broadcast_event({"type": "job.updated", "job": _public_job_dict(job)}))
        except Exception:
            pass
        
        sequence = job["input"]["sequence"]
        num_designs = job["input"]["num_designs"]

        # Optional: store richer (slower) residency sampling in job metrics snapshots.
        include_residency = (os.getenv("MCP_JOB_INCLUDE_RESIDENCY") or "0").strip() in ("1", "true", "yes")
        
        # Step 1: AlphaFold2 - predict structure of target
        logger.info(f"Job {job_id}: Running AlphaFold2")
        job["progress"]["alphafold"] = "running"
        _job_set_progress(job, stage="alphafold", pct=5, message="Running AlphaFold2")
        stages = _stage_metrics(job)
        stage_started = datetime.now().isoformat()
        stages["alphafold"] = {"started_at": stage_started, "status": "running"}

        # Capture a pre-snapshot (useful for cache warmth / MemAvailable) before AlphaFold starts.
        metrics = _job_metrics(job)
        alphafold_host = metrics.get("alphafold_host")
        if not isinstance(alphafold_host, dict):
            alphafold_host = {}
            metrics["alphafold_host"] = alphafold_host
        alphafold_host["pre"] = await _alphafold_host_snapshot(include_residency=include_residency)
        alphafold_host["pre_at"] = datetime.now().isoformat()

        hb_task: Optional[asyncio.Task] = asyncio.create_task(_job_heartbeat(job))
        
        try:
            alphafold_result = await model_backend.predict_structure(sequence)
            job["progress"]["alphafold"] = "completed"
            logger.info(f"Job {job_id}: AlphaFold2 completed")
        except Exception as e:
            logger.exception("AlphaFold2 error")
            short = _summarize_error(e)
            job["error_detail"] = _error_detail(e)
            job["progress"]["alphafold"] = f"error: {short}"
            if allow_mock_outputs():
                # For CI/demo only
                alphafold_result = {"pdb": "mock_structure"}
            else:
                await _cancel_and_await(hb_task)
                job["status"] = "failed"
                job["error"] = f"AlphaFold2 failed: {short}"
                _job_set_progress(job, stage="alphafold", pct=5, message=f"AlphaFold2 failed: {short}")
                stages["alphafold"].update({"ended_at": datetime.now().isoformat(), "status": "failed"})
                try:
                    asyncio.create_task(broadcast_event({"type": "job.failed", "job": _public_job_dict(job)}))
                except Exception:
                    pass
                return
        finally:
            await _cancel_and_await(hb_task)

        # Post snapshot after AlphaFold completes.
        alphafold_host["post"] = await _alphafold_host_snapshot(include_residency=include_residency)
        alphafold_host["post_at"] = datetime.now().isoformat()

        stage_ended = datetime.now().isoformat()
        stages["alphafold"].update({"ended_at": stage_ended, "status": "completed"})
        try:
            start_dt = datetime.fromisoformat(stage_started)
            end_dt = datetime.fromisoformat(stage_ended)
            stages["alphafold"]["duration_s"] = (end_dt - start_dt).total_seconds()
        except Exception:
            pass

        _job_set_progress(job, stage="alphafold", pct=25, message="AlphaFold2 completed")
        try:
            asyncio.create_task(broadcast_event({"type": "job.updated", "job": _public_job_dict(job)}))
        except Exception:
            pass
        
        # Step 2: RFDiffusion - generate binder backbones
        logger.info(f"Job {job_id}: Running RFDiffusion")
        job["progress"]["rfdiffusion"] = "running"
        _job_set_progress(job, stage="rfdiffusion", pct=30, message="Running RFDiffusion")
        stage_started = datetime.now().isoformat()
        stages["rfdiffusion"] = {"started_at": stage_started, "status": "running"}

        hb_task = asyncio.create_task(_job_heartbeat(job))
        
        try:
            rfdiffusion_result = await model_backend.design_binder_backbone(
                alphafold_result.get("pdb", ""),
                num_designs
            )
            job["progress"]["rfdiffusion"] = "completed"
            logger.info(f"Job {job_id}: RFDiffusion completed")
        except Exception as e:
            logger.exception("RFDiffusion error")
            short = _summarize_error(e)
            job["error_detail"] = _error_detail(e)
            job["progress"]["rfdiffusion"] = f"error: {short}"
            if allow_mock_outputs():
                rfdiffusion_result = {"designs": [{"pdb": f"mock_design_{i}"} for i in range(num_designs)]}
            else:
                await _cancel_and_await(hb_task)
                job["status"] = "failed"
                job["error"] = f"RFDiffusion failed: {short}"
                _job_set_progress(job, stage="rfdiffusion", pct=30, message=f"RFDiffusion failed: {short}")
                stages["rfdiffusion"].update({"ended_at": datetime.now().isoformat(), "status": "failed"})
                try:
                    asyncio.create_task(broadcast_event({"type": "job.failed", "job": _public_job_dict(job)}))
                except Exception:
                    pass
                return
        finally:
            await _cancel_and_await(hb_task)

        stage_ended = datetime.now().isoformat()
        stages["rfdiffusion"].update({"ended_at": stage_ended, "status": "completed"})
        try:
            start_dt = datetime.fromisoformat(stage_started)
            end_dt = datetime.fromisoformat(stage_ended)
            stages["rfdiffusion"]["duration_s"] = (end_dt - start_dt).total_seconds()
        except Exception:
            pass

        _job_set_progress(job, stage="rfdiffusion", pct=50, message="RFDiffusion completed")
        try:
            asyncio.create_task(broadcast_event({"type": "job.updated", "job": _public_job_dict(job)}))
        except Exception:
            pass
        
        # Step 3: ProteinMPNN - generate sequences for backbones
        logger.info(f"Job {job_id}: Running ProteinMPNN")
        job["progress"]["proteinmpnn"] = "running"
        _job_set_progress(job, stage="proteinmpnn", pct=55, message="Running ProteinMPNN")
        stage_started = datetime.now().isoformat()
        stages["proteinmpnn"] = {"started_at": stage_started, "status": "running"}

        hb_task = asyncio.create_task(_job_heartbeat(job))
        
        try:
            mpnn_results = []
            designs = rfdiffusion_result.get("designs", [])[:num_designs]
            for i, design in enumerate(designs):
                # Provide a smooth-ish progress bar within the ProteinMPNN stage.
                if num_designs > 0:
                    pct = 55 + (20.0 * ((i) / max(1, num_designs)))
                    _job_set_progress(job, stage="proteinmpnn", pct=pct, message=f"ProteinMPNN {i+1}/{num_designs}")
                mpnn_result = await model_backend.generate_sequence(design.get("pdb", ""))
                mpnn_results.append(mpnn_result)
            job["progress"]["proteinmpnn"] = "completed"
            logger.info(f"Job {job_id}: ProteinMPNN completed")
        except Exception as e:
            logger.exception("ProteinMPNN error")
            short = _summarize_error(e)
            job["error_detail"] = _error_detail(e)
            job["progress"]["proteinmpnn"] = f"error: {short}"
            if allow_mock_outputs():
                mpnn_results = [{"sequence": f"MOCK_SEQ_{i}"} for i in range(num_designs)]
            else:
                await _cancel_and_await(hb_task)
                job["status"] = "failed"
                job["error"] = f"ProteinMPNN failed: {short}"
                _job_set_progress(job, stage="proteinmpnn", pct=55, message=f"ProteinMPNN failed: {short}")
                stages["proteinmpnn"].update({"ended_at": datetime.now().isoformat(), "status": "failed"})
                try:
                    asyncio.create_task(broadcast_event({"type": "job.failed", "job": _public_job_dict(job)}))
                except Exception:
                    pass
                return
        finally:
            await _cancel_and_await(hb_task)

        stage_ended = datetime.now().isoformat()
        stages["proteinmpnn"].update({"ended_at": stage_ended, "status": "completed"})
        try:
            start_dt = datetime.fromisoformat(stage_started)
            end_dt = datetime.fromisoformat(stage_ended)
            stages["proteinmpnn"]["duration_s"] = (end_dt - start_dt).total_seconds()
        except Exception:
            pass

        _job_set_progress(job, stage="proteinmpnn", pct=75, message="ProteinMPNN completed")
        try:
            asyncio.create_task(broadcast_event({"type": "job.updated", "job": _public_job_dict(job)}))
        except Exception:
            pass
        
        # Step 4: AlphaFold2-Multimer - predict complex structures
        logger.info(f"Job {job_id}: Running AlphaFold2-Multimer")
        job["progress"]["alphafold_multimer"] = "running"
        _job_set_progress(job, stage="alphafold_multimer", pct=80, message="Running AlphaFold2-Multimer")
        stage_started = datetime.now().isoformat()
        stages["alphafold_multimer"] = {"started_at": stage_started, "status": "running"}

        hb_task = asyncio.create_task(_job_heartbeat(job))
        
        try:
            multimer_results = []
            for i, mpnn_result in enumerate(mpnn_results[:num_designs]):
                if num_designs > 0:
                    pct = 80 + (20.0 * ((i) / max(1, num_designs)))
                    _job_set_progress(job, stage="alphafold_multimer", pct=pct, message=f"AlphaFold2-Multimer {i+1}/{num_designs}")
                multimer_result = await model_backend.predict_complex([
                    sequence,
                    mpnn_result.get("sequence", "")
                ])
                multimer_results.append(multimer_result)
            job["progress"]["alphafold_multimer"] = "completed"
            logger.info(f"Job {job_id}: AlphaFold2-Multimer completed")
        except Exception as e:
            logger.exception("AlphaFold2-Multimer error")
            short = _summarize_error(e)
            job["error_detail"] = _error_detail(e)
            job["progress"]["alphafold_multimer"] = f"error: {short}"
            if allow_mock_outputs():
                multimer_results = [{"pdb": f"mock_complex_{i}"} for i in range(num_designs)]
            else:
                await _cancel_and_await(hb_task)
                job["status"] = "failed"
                job["error"] = f"AlphaFold2-Multimer failed: {short}"
                _job_set_progress(job, stage="alphafold_multimer", pct=80, message=f"AlphaFold2-Multimer failed: {short}")
                stages["alphafold_multimer"].update({"ended_at": datetime.now().isoformat(), "status": "failed"})
                try:
                    asyncio.create_task(broadcast_event({"type": "job.failed", "job": _public_job_dict(job)}))
                except Exception:
                    pass
                return
        finally:
            await _cancel_and_await(hb_task)

        stage_ended = datetime.now().isoformat()
        stages["alphafold_multimer"].update({"ended_at": stage_ended, "status": "completed"})
        try:
            start_dt = datetime.fromisoformat(stage_started)
            end_dt = datetime.fromisoformat(stage_ended)
            stages["alphafold_multimer"]["duration_s"] = (end_dt - start_dt).total_seconds()
        except Exception:
            pass

        _job_set_progress(job, stage="alphafold_multimer", pct=100, message="AlphaFold2-Multimer completed")
        try:
            asyncio.create_task(broadcast_event({"type": "job.updated", "job": _public_job_dict(job)}))
        except Exception:
            pass
        
        # Compile results
        job["results"] = {
            "target_structure": alphafold_result,
            "designs": [
                {
                    "design_id": i,
                    "backbone": rfdiffusion_result.get("designs", [])[i] if i < len(rfdiffusion_result.get("designs", [])) else {},
                    "sequence": mpnn_results[i] if i < len(mpnn_results) else {},
                    "complex_structure": multimer_results[i] if i < len(multimer_results) else {}
                }
                for i in range(num_designs)
            ]
        }
        
        job["status"] = "completed"
        _job_set_progress(job, stage="completed", pct=100, message="Job completed")
        logger.info(f"Job {job_id}: Completed successfully")
        try:
            asyncio.create_task(broadcast_event({"type": "job.completed", "job": _public_job_dict(job)}))
        except Exception:
            pass
    except asyncio.CancelledError:
        # If the server is shutting down or the task was cancelled, report a terminal state.
        logger.warning(f"Job {job_id} cancelled")
        job = jobs_db.get(job_id, {})
        if isinstance(job, dict):
            job["status"] = "failed"
            job["error"] = "Job cancelled"
            _job_set_progress(job, stage=job.get("current_stage") or "cancelled", pct=float(job.get("progress_pct") or 0), message="Job cancelled")
        raise
    except BaseException as e:
        logger.exception("Job %s failed", job_id)
        job = jobs_db.get(job_id, {})
        if isinstance(job, dict):
            job["status"] = "failed"
            short = _summarize_error(e)
            job["error"] = short
            job["error_detail"] = _error_detail(e)
            _job_set_progress(job, stage=job.get("current_stage") or "failed", pct=float(job.get("progress_pct") or 0), message=f"Job failed: {short}")

if __name__ == "__main__":
    import uvicorn
    port = int((os.getenv("PORT") or os.getenv("MCP_SERVER_PORT") or "8000").strip())
    uvicorn.run(app, host="0.0.0.0", port=port)
