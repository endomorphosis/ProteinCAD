# ProteinCAD — Protein Binder Design Platform

An end-to-end **protein binder design** platform combining AI model orchestration, a web dashboard, GPU-accelerated MSA generation, and zero-touch installation — running on AMD64 and ARM64 (DGX Spark / aarch64).

## Overview

The platform packages a complete protein design workflow behind a simple control plane:

- **MCP Server** (FastAPI) — orchestrates protein design jobs, stores results, exposes REST and MCP JSON-RPC endpoints
- **MCP Dashboard** (Next.js) — web UI to submit jobs, configure backend routing, and visualize results
- **Model backends** — pluggable execution layer supporting:
  - **NVIDIA NIM services** (AMD64 Docker, requires NGC API key)
  - **ARM64 host-native services** (recommended on DGX Spark / aarch64)
  - **Embedded runners** (ProteinMPNN in-process; others configurable)
  - **Hybrid fallback routing** — try providers in priority order

### Current repository state (as of 2026-05)

- BLAST retrieval is integrated end-to-end (MCP server REST + MCP tools/resources + dashboard controls/evidence views).
- Grounding for design jobs is available but remains **opt-in by default** (`MCP_RETRIEVAL_ENABLE_JOB_GROUNDING=true` to enable by default).
- Dashboard E2E coverage includes retrieval settings, grounded-job badges, and evidence/resource rendering paths.
- Recent merged history includes:
  - PR #4: MCP server + dashboard UX improvements.
  - PR #5: BLAST retrieval integration and grounding/evidence UI wiring.

### Protein design pipeline

| Step | Tool | What it does |
|------|------|--------------|
| 1. Structure prediction | AlphaFold2 | Predict 3-D structure of target protein |
| 2. Binder diffusion | RFDiffusion | Diffuse candidate binder backbones |
| 3. Sequence design | ProteinMPNN | Design amino-acid sequences for backbones |
| 4. Validation | AlphaFold2-Multimer | Predict complex structure to validate binding |

### Key improvements

| Feature | Result |
|---------|--------|
| MMseqs2 GPU acceleration | **10× faster** MSA generation (580 s → 58 s) |
| AlphaFold speed presets | **29% faster** inference (balanced preset default) |
| MSA caching | **21% additional speedup** on repeat runs |
| XLA JIT warm-up | First-model compilation time reduced ~50% |
| Zero-touch installer | One command installs all tools + databases + GPU config |
| ARM64 native stack | Full pipeline runs natively on DGX Spark (aarch64) |
| ARM64 CUDA fallback | Automatic bfloat16 / XLA workarounds for ARM64 JAX |

---

## Quick Start (recommended)

Start the Dashboard + MCP Server stack. The script auto-selects the correct compose file for your platform (AMD64 or ARM64):

```bash
./scripts/run_dashboard_stack.sh up -d --build
```

Open:
- Dashboard: `http://localhost:${MCP_DASHBOARD_HOST_PORT:-3000}`
- MCP Server health: `http://localhost:${MCP_SERVER_HOST_PORT:-8011}/health`
- MCP Server API docs: `http://localhost:${MCP_SERVER_HOST_PORT:-8011}/docs`

Submit a demo job to confirm end-to-end wiring:

```bash
./scripts/submit_demo_job.sh
```

Monitor a job from the CLI (detects hangs, prints progress + cache/memory metrics):

```bash
./scripts/monitor_job.sh <job_id> --metrics
```

If anything feels stuck, run the diagnostics script:

```bash
./scripts/doctor_stack.sh
```

> **Stack auto-selection logic**
> - **AMD64**: host-native wrappers healthy on `18081/18082/18084` → host-native stack; `NGC_CLI_API_KEY` set → NIM stack; else → control-plane only.
> - **ARM64**: always uses the ARM64 host-native dashboard stack.
>
> Force a specific mode: `./scripts/run_dashboard_stack.sh --control-plane|--amd64|--arm64|--arm64-host-native|--host-native up -d --build`

### Alternate start (batteries-included, ARM64 / DGX Spark)

```bash
# Also starts host-native model wrappers and a memory watchdog
./scripts/start_everything.sh --arm64-host-native --provision --db-tier minimal

# Stop everything
./scripts/stop_everything.sh
```

---

## Zero-Touch Native Installer

One command installs all tools (AlphaFold2, RFDiffusion, ProteinMPNN, MMseqs2) and databases, then auto-configures GPU acceleration if an NVIDIA GPU is detected.

| Profile | Command | Download size | What it installs |
|---------|---------|--------------|-----------------|
| **Minimal** | `bash scripts/install_all_native.sh --minimal` | ~5 GB | Tools + UniRef90 → MMseqs2 DB |
| **Recommended** (dev) | `bash scripts/install_all_native.sh --recommended` | ~50 GB | Tools + UniRef90 + small BFD → MMseqs2 + GPU auto-config |
| **Full** (production) | `bash scripts/install_all_native.sh --full` | ~2.3 TB | Tools + complete AlphaFold DBs (UniRef90, BFD, PDB SeqRes, UniProt) → MMseqs2 + GPU auto-config |

What the installer does:
1. Detects GPU/CPU/memory
2. Installs AlphaFold2, RFDiffusion, ProteinMPNN into `~/miniforge3/envs/alphafold2`
3. Installs MMseqs2 and builds databases to `~/.cache/alphafold/mmseqs2`
4. If GPU detected: configures GPU server scripts for 5–10× MSA speedup
5. Configures conda with JAX GPU support and Docker GPU access
6. Generates `.env.gpu` with optimized environment variables
7. Runs a full verification check (34 checks)

Notes:
- GPU detection is automatic — no manual setup needed. Falls back to CPU if no GPU.
- Existing MMseqs2 DBs are skipped automatically. Force rebuild: `rm -rf ~/.cache/alphafold/mmseqs2`
- See [MMseqs2 GPU Quickstart](docs/MMSEQS2_GPU_QUICKSTART.md) for GPU server details.
- See [MMSEQS2_INSTALLER_INTEGRATION.md](docs/MMSEQS2_INSTALLER_INTEGRATION.md) for integration details.

### GPU-only installer (already have databases)

```bash
./scripts/install_mmseqs2_gpu_zero_touch.sh
```

This compiles a CUDA-enabled MMseqs2 binary, creates padded databases, and configures the GPU server without re-downloading data.

---

## GPU Acceleration Details

### MMseqs2 GPU server mode

The platform uses MMseqs2's GPU server mode for maximum throughput. The database is loaded into GPU memory once and reused across all queries:

```bash
# Start GPU server (auto-configured by installer)
nohup ~/.local/bin/mmseqs2-gpu-server &

# Use GPU-accelerated search
mmseqs search query.db target.db result.db tmp/ --gpu-server 1
```

Performance (NVIDIA GB10, 1.5 TB UniRef90 database, 70-aa query):

| Mode | Time | Speedup |
|------|------|---------|
| CPU-only | 580 s (9.7 min) | 1× |
| GPU server | 58–120 s (1–2 min) | **5–10×** |

Install as a systemd service for always-on acceleration:

```bash
sudo cp ~/.local/share/mmseqs2-gpu-server.service /etc/systemd/system/
sudo systemctl enable --now mmseqs2-gpu-server
```

### AlphaFold speed presets

Set via `--speed_preset` flag or `ALPHAFOLD_SPEED_PRESET` environment variable:

| Preset | Speedup | Notes |
|--------|---------|-------|
| `balanced` **(default)** | ~20% | Templates on, `num_recycles=3`, `mmseqs2_max_seqs=512` |
| `fast` | ~29% | Templates off, `num_recycles=3`, `mmseqs2_max_seqs=512` |
| `quality` | baseline | Templates on, model-default recycles, `mmseqs2_max_seqs=10000` |

To restore original behaviour: `python run_alphafold.py --speed_preset quality`

---

## Ports & Services

| Service | Default host port | Notes |
|---------|-----------------|-------|
| Dashboard | `3000` | Override via `MCP_DASHBOARD_HOST_PORT` |
| MCP Server (stack) | `8011` | Override via `MCP_SERVER_HOST_PORT`; container listens on `8000` |
| MCP Server (standalone) | `8010` | Optional single-container mode for demos/tools |
| AlphaFold2 | `18081` | NIM container or host-native wrapper |
| RFDiffusion | `18082` | NIM container or host-native wrapper |
| ProteinMPNN | `18083` | NIM container or host-native wrapper |
| AlphaFold2-Multimer | `18084` | NIM container or host-native wrapper |

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SERVER_HOST_PORT` | `8011` | Host port for stack MCP server |
| `MCP_DASHBOARD_HOST_PORT` | `3000` | Host port for dashboard |
| `MCP_SERVER_URL` | — | Where dashboard proxies point for MCP server |
| `NGC_CLI_API_KEY` | — | Required for NIM image pulls |
| `HOST_NIM_CACHE` | `~/.cache/nim` | NIM model cache directory |
| `ALPHAFOLD_SPEED_PRESET` | `balanced` | AlphaFold speed/quality tradeoff |
| `ALPHAFOLD_MSA_MODE` | `mmseqs2` | MSA backend (`mmseqs2` or `jackhmmer`) |
| `OMP_NUM_THREADS` | `16` | CPU thread pinning |

Change ports at startup:

```bash
MCP_DASHBOARD_HOST_PORT=3005 MCP_SERVER_HOST_PORT=8012 ./scripts/run_dashboard_stack.sh up -d --build
```

---

## API Reference

Full interactive docs: `http://localhost:${MCP_SERVER_HOST_PORT:-8011}/docs`

### Health & status

```
GET  /health                     Server liveness
GET  /api/services/status        Aggregated backend/provider health
GET  /api/gpu/status             GPU visibility and utilization
```

### Runtime configuration

```
GET  /api/config                 Current routing/provider config
PUT  /api/config                 Update routing/provider config
POST /api/config/reset           Reset to defaults
```

Config is persisted to `MCP_CONFIG_PATH` (mounted under `/config/` in compose stacks). Set `MCP_CONFIG_READONLY=1` to prevent runtime changes.

### BLAST retrieval + grounding (DuckDB-first)

ProteinCAD includes BLAST retrieval integration with `https://blast.ncbi.nlm.nih.gov/Blast.cgi` as the default provider and DuckDB as the default retrieval store/cache.

```
POST /api/retrieval/requests            Submit retrieval query
GET  /api/retrieval/requests/{id}       Read normalized retrieval bundle
GET  /api/retrieval/cache               List cached retrieval entries
```

Dashboard support includes:
- Backend settings for BLAST retrieval feature flags and defaults
- Per-job opt-in toggle to ground design runs with BLAST evidence
- Job-level retrieval status and results evidence panels (top homologs, evidence packet, manifest refs)

`ipfs-datasets-py` remains optional and should only be used for non-BLAST ETL/packaging/publication workflows.

### Jobs

```
POST /api/jobs                   Create a job
GET  /api/jobs                   List jobs
GET  /api/jobs/{job_id}          Job status / details
```

Job diagnostics query parameters:

| Parameter | Effect |
|-----------|--------|
| `include_metrics=1` | Stage timing + host resource snapshots |
| `include_residency=1` | DB page-cache residency sampling (slower) |
| `include_error_detail=1` | Full error details (default responses are UI-safe/truncated) |

### MCP protocol & streaming

```
POST /mcp                        MCP JSON-RPC 2.0 (initialize / tools/list / tools/call / resources/*)
GET  /mcp/v1/tools               List available MCP tools
GET  /mcp/v1/resources           List MCP resources
GET  /sse                        Server-sent events (job lifecycle)
GET  /mcp/sse                    SSE alias
```

---

## Architecture

```
┌─────────────────┐
│  MCP Dashboard  │  Next.js  (port 3000)
│  (Browser UI)   │
└────────┬────────┘
         │  proxy  /api/mcp/*
         ▼
┌──────────────────────────┐
│   MCP Server (FastAPI)   │  port 8011 (host) / 8000 (container)
│  • Job orchestration     │
│  • MCP JSON-RPC          │
│  • SSE streaming         │
│  • Runtime config        │
└──────────┬───────────────┘
           │  provider routing (single | fallback)
           ▼
┌──────────────────────────────────────────────┐
│              Model Backends                  │
├──────────────────────────────────────────────┤
│  NIM (AMD64)        Host-native (ARM64)       │
│  • AlphaFold2       • AlphaFold2 wrapper      │
│  • RFDiffusion      • RFDiffusion wrapper     │
│  • ProteinMPNN      • ProteinMPNN wrapper     │
│  • AF2-Multimer     • AF2-Multimer wrapper    │
└──────────────────────────────────────────────┘
```

Key source locations:

| Component | Location |
|-----------|----------|
| MCP server endpoints | `mcp-server/server.py` |
| Routing config schema | `mcp-server/runtime_config.py` |
| Backend/provider implementations | `mcp-server/model_backends.py` |
| GPU initialisation | `mcp-server/gpu_init.py` |
| Dashboard (Next.js) | `mcp-dashboard/` |
| Dashboard proxy handlers | `mcp-dashboard/app/api/mcp/*` |
| Stack selection logic | `scripts/run_dashboard_stack.sh` |
| Diagnostics script | `scripts/doctor_stack.sh` |
| Native model wrappers | `native_services/` |
| Compose files | `deploy/` |

---

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| AMD64 / x86_64 (Docker NIM) | ✅ Full support | NIM containers require NGC API key |
| AMD64 / x86_64 (host-native) | ✅ Supported | Use `--host-native` flag |
| ARM64 / aarch64 (DGX Spark) | ✅ Full support | Native stack, CUDA 13.1+ |
| ARM64 (Docker NIM emulation) | ⚠️ Works with caveats | Performance impact from AMD64 emulation |

### ARM64 / DGX Spark notes

- AlphaFold2-Multimer uses conservative defaults on ARM64 to avoid known JAX/XLA bfloat16 conversion crashes.
- Override bfloat16 behaviour via environment variables — see [docs/ARM64_CUDA_FALLBACK_GUIDE.md](docs/ARM64_CUDA_FALLBACK_GUIDE.md).
- Custom CUDA-compiled MMseqs2 binary (architecture `121`) delivers 10× speedup on ARM64.
- ARM64 CI/CD workflows run on self-hosted runners with labels `[self-hosted, ARM64, gpu]`.

---

## Security Notes

The stack is designed for local/trusted-network use by default:
- No authentication on most endpoints.
- If exposing beyond localhost, add a reverse proxy with auth/TLS and restrict origins.
- See [SECURITY.md](SECURITY.md) for details.

---

## Where to Go Next

| Goal | Document |
|------|----------|
| First-time setup (non-ML-friendly) | [START_HERE.md](START_HERE.md) |
| Full docs index | [docs/INDEX.md](docs/INDEX.md) |
| Architecture deep-dive | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| AlphaFold performance tuning | [docs/ALPHAFOLD_OPTIMIZATION_GUIDE.md](docs/ALPHAFOLD_OPTIMIZATION_GUIDE.md) |
| MMseqs2 GPU acceleration | [docs/MMSEQS2_GPU_QUICKSTART.md](docs/MMSEQS2_GPU_QUICKSTART.md) |
| ARM64 deployment | [docs/ARM64_DEPLOYMENT.md](docs/ARM64_DEPLOYMENT.md) |
| ARM64 CUDA fallback | [docs/ARM64_CUDA_FALLBACK_GUIDE.md](docs/ARM64_CUDA_FALLBACK_GUIDE.md) |
| Docker + MCP stack details | [docs/DOCKER_MCP_README.md](docs/DOCKER_MCP_README.md) |
| Profiling & benchmarking | [docs/PROFILING.md](docs/PROFILING.md) |
| CI/CD workflows | [docs/CI_CD_GUIDE.md](docs/CI_CD_GUIDE.md) |
| Agent / contributor guide | [docs/AGENTS.md](docs/AGENTS.md) |
| GPU/MMseqs2 institutional knowledge | [INSTITUTIONAL_KNOWLEDGE.md](INSTITUTIONAL_KNOWLEDGE.md) |
