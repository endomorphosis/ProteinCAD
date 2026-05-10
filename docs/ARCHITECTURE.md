# Architecture

This document describes how the repository fits together today: components, ports, request flows, and backend routing. For "how to run", start with [../START_HERE.md](../START_HERE.md) and [QUICKSTART.md](QUICKSTART.md).

---

## Components (high level)

| Component | Location | Description |
|-----------|----------|-------------|
| **MCP Server** | `mcp-server/` | FastAPI app that exposes MCP endpoints, job orchestration, runtime config, and backend/provider routing |
| **MCP Dashboard** | `mcp-dashboard/` | Next.js/React UI. The browser talks to dashboard routes; the dashboard proxies most backend calls to the MCP server |
| **Model backends** | `native_services/`, NIM containers | One or more services that run the heavy steps (NIM containers, host-native wrappers, or embedded implementations) |
| **Scripts + compose** | `scripts/`, `deploy/` | Source of truth for stack selection, platform detection, native installation, and GPU setup |
| **MCP JS SDK** | `mcp-js-sdk/` | JS SDK used by the dashboard to call MCP tools/resources |

---

## Run modes and ports

### 1) Compose "stack" mode (recommended)

- MCP server is published on host **`8011`** by default (container listens on `8000`).
- Dashboard is published on host **`3000`** by default.
- Model services are commonly published on host ports **`18081`–`18084`** (exact services depend on mode/platform).

### 2) Standalone MCP server container (optional)

- MCP server is published on host **`8010`** by default (container listens on `8000`).
- Useful for local development or when you don't want the full dashboard stack.

### Key environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SERVER_HOST_PORT` | `8011` | Host port for the stack MCP server |
| `MCP_DASHBOARD_HOST_PORT` | `3000` | Host port for the dashboard |
| `MCP_SERVER_URL` | — | Where the dashboard/proxies point for the MCP server |
| `NEXT_PUBLIC_MCP_SERVER_URL` | — | Fallback when `MCP_SERVER_URL` is not set |

---

## Request and data flow

### Dashboard-driven flow (typical)

1. **Browser → Dashboard**: The user interacts with the Next.js app.
2. **Dashboard → MCP server (proxy)**: The dashboard calls server-side API routes under `mcp-dashboard/app/api/mcp/*`, which then forward requests to the MCP server.
3. **MCP server → backends**: The MCP server selects a provider chain (single or fallback) and calls the configured backends.
4. **Results**: The MCP server writes job outputs and serves them via REST/MCP endpoints; the dashboard polls or streams progress.

### Direct API flow (headless / agent)

Agents or scripts can talk directly to the MCP server without going through the dashboard:

- REST-style job APIs under `/api/*`
- MCP protocol endpoints (`/mcp` JSON-RPC, `/mcp/v1/*` REST)
- Server-sent events (SSE) for streaming updates

---

## MCP server API surface

### Health & status

```
GET /health                     Server liveness
GET /api/services/status        Aggregated backend/provider health
GET /api/gpu/status             GPU visibility and utilization
```

### Runtime config

```
GET  /api/config                Current routing/provider config
PUT  /api/config                Update routing/provider config
POST /api/config/reset          Reset to defaults
```

Config persistence:
- Persisted to `MCP_CONFIG_PATH` when set (compose stacks mount this under `/config/`).
- Can be forced read-only via `MCP_CONFIG_READONLY=1`.

### Jobs

```
POST /api/jobs                  Create a job
GET  /api/jobs                  List jobs
GET  /api/jobs/{job_id}         Job status / details
```

Job diagnostics query params:

| Parameter | Effect |
|-----------|--------|
| `include_metrics=1` | Stage timing + host snapshots |
| `include_residency=1` | DB page-cache residency sampling (slower) |
| `include_error_detail=1` | Full error details (default is UI-safe/truncated) |

### MCP protocol + streaming

```
POST /mcp                       MCP JSON-RPC 2.0 endpoint
GET  /mcp/v1/tools              MCP tool listing
GET  /mcp/v1/resources          MCP resource listing
GET  /sse                       SSE streaming endpoint (job lifecycle events)
GET  /mcp/sse                   SSE alias
```

---

## Backend routing model

The MCP server supports multiple provider types and a configurable routing strategy:

### Provider types

| Type | Description |
|------|-------------|
| `nim` | NVIDIA Inference Microservice endpoints (host ports `18081`–`18084` in this repo's stacks) |
| `external` | Arbitrary HTTP endpoints you provide |
| `embedded` | Local/packaged implementations that can be bootstrapped or downloaded |

### Routing modes

| Mode | Behavior |
|------|-----------|
| `single` | Always use one provider |
| `fallback` | Try providers in priority order until one succeeds |

This logic lives primarily in:
- `mcp-server/runtime_config.py` — schema, persistence, env overrides
- `mcp-server/model_backends.py` — provider implementations and fallback behavior
- `mcp-server/gpu_init.py` — GPU detection and initialisation

---

## Dashboard proxy routes

The dashboard runs in the browser, but the MCP server may be on a different origin/port. The dashboard provides server-side proxy routes under `mcp-dashboard/app/api/mcp/*` for:

| Route | Proxies to |
|-------|-----------|
| `/api/mcp/config`, `/api/mcp/config/reset` | MCP server config endpoints |
| `/api/mcp/services/status` | MCP server status |
| `/api/mcp/tools`, `/api/mcp/tools/call` | MCP tool list/call |
| `/api/mcp/resources`, `/api/mcp/resources/read` | MCP resource list/read |
| `/api/mcp/jobs`, `/api/mcp/jobs/status` | Job create/poll |
| `/api/mcp/embedded/bootstrap` | Embedded model bootstrap |

SSE is also proxied via the dashboard's SSE routes.

---

## Deployment and stack selection

The compose files under `deploy/` define multiple deployment variants. The supported entrypoint is:

```bash
./scripts/run_dashboard_stack.sh up -d --build
```

That script auto-selects the appropriate compose file:

| Platform | Condition | Stack used |
|----------|-----------|-----------|
| AMD64 | Host-native wrappers healthy on `18081/18082/18084` | `deploy/docker-compose-dashboard-host-native.yaml` |
| AMD64 | `NGC_CLI_API_KEY` set | `deploy/docker-compose-dashboard.yaml` (NIM services) |
| AMD64 | Default | `deploy/docker-compose-dashboard-default.yaml` (control-plane only) |
| ARM64 | All cases | `deploy/docker-compose-dashboard-arm64-host-native.yaml` |

Force a mode:

```bash
./scripts/run_dashboard_stack.sh --control-plane up -d --build
./scripts/run_dashboard_stack.sh --amd64 up -d
./scripts/run_dashboard_stack.sh --arm64 up -d --build
./scripts/run_dashboard_stack.sh --arm64-host-native up -d --build
./scripts/run_dashboard_stack.sh --host-native up -d --build
```

---

## GPU acceleration

### MMseqs2 GPU server

The platform uses MMseqs2's GPU server mode: the database is loaded into GPU memory once and reused across all queries, yielding 5–10× MSA speedup. The zero-touch installer auto-configures this when a GPU is detected.

```
GPU Server (mmseqs gpuserver)
  ← loads database once into GPU memory
  ← handles all GPU prefilter operations

Search Client (mmseqs search --gpu-server 1)
  ← sends queries to GPU server
  ← no database rebuild needed
```

### AlphaFold inference

Speed presets control the tradeoff between inference speed and prediction quality (see [ALPHAFOLD_OPTIMIZATION_GUIDE.md](ALPHAFOLD_OPTIMIZATION_GUIDE.md)):

```
balanced (default): ~20% faster — templates ON, num_recycles=3, max_seqs=512
fast:               ~29% faster — templates OFF, num_recycles=3, max_seqs=512
quality:            baseline    — templates ON, model-default recycles, max_seqs=10000
```

---

## Where to make changes

| What you want to change | File |
|-------------------------|------|
| MCP server endpoints | `mcp-server/server.py` |
| Routing/config schema + persistence | `mcp-server/runtime_config.py` |
| Backend/provider implementations | `mcp-server/model_backends.py` |
| GPU initialisation | `mcp-server/gpu_init.py` |
| Dashboard settings UI (routing/provider config) | `mcp-dashboard/components/BackendSettings.tsx` |
| Dashboard proxy handlers | `mcp-dashboard/app/api/mcp/*` |
| Stack selection logic | `scripts/run_dashboard_stack.sh` |
| Diagnostics | `scripts/doctor_stack.sh` |

---

## Troubleshooting hooks

```bash
# Basic health
curl http://localhost:${MCP_SERVER_HOST_PORT:-8011}/health
curl http://localhost:${MCP_SERVER_HOST_PORT:-8011}/api/services/status

# Diagnostics script
./scripts/doctor_stack.sh

# Container logs
./scripts/run_dashboard_stack.sh logs -f --tail=200
```

---

## Security notes

The stack is primarily geared toward local/dev and trusted-network use:
- No authentication by default on most endpoints.
- If exposing beyond localhost, put a reverse proxy in front and add auth/TLS, and restrict origins.
- See [../SECURITY.md](../SECURITY.md) for more details.
