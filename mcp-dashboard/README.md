# MCP Dashboard

Web-based dashboard for the Protein Binder Design MCP Server.

## Quick Start

### Using Docker
```bash
docker build -t mcp-dashboard .

# Recommended: run the full stack from repo root:
#   ./scripts/run_dashboard_stack.sh up -d --build

# If you run the dashboard container by itself, you must point it at an MCP server.
# Example: MCP server running on the host (stack port 8011).
# On Linux, include --add-host so host.docker.internal resolves.
docker run -p 3000:3000 \
	--add-host=host.docker.internal:host-gateway \
	-e MCP_SERVER_URL=http://host.docker.internal:${MCP_SERVER_HOST_PORT:-8011} \
	-e NEXT_PUBLIC_MCP_SERVER_URL=http://localhost:${MCP_SERVER_HOST_PORT:-8011} \
	mcp-dashboard
```

### Local Development
```bash
npm install
npm run dev
```

The dashboard will be available at http://localhost:3000

## Features

- Submit new protein design jobs
- Monitor job progress in real-time
- View and download results
- Check service health status
- Launch Jupyter notebooks
- Configure BLAST retrieval feature flags/defaults from Settings
- Submit jobs with per-job BLAST grounding controls
- Inspect BLAST grounding evidence in results (top hits, evidence docs, manifest refs)

## Environment Variables

- `NEXT_PUBLIC_MCP_SERVER_URL` - MCP Server endpoint
	- Local dev server (running `python server.py`): `http://localhost:8000`
	- Standalone MCP server container: `http://localhost:8010`
	- Full stack (via `./scripts/run_dashboard_stack.sh`): `http://localhost:${MCP_SERVER_HOST_PORT:-8011}`

- `MCP_SERVER_URL` - MCP Server URL used by the dashboard's server-side `/api/mcp/*` proxy routes
	- In compose stacks this is typically set to `http://mcp-server:8000`

- `MCP_DASHBOARD_MOCK` - Enable dashboard-local mock backend (`1`/`true`)
	- When enabled, `/api/mcp/*` routes return deterministic mock tool results (jobs, services, settings, and PDB data)
	- Useful for UI/visualization testing without any running AI/ML services

## Technology Stack

- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- Axios

## Building for Production

```bash
npm run build
npm start
```

## E2E Tests (Playwright)

```bash
npm run test:e2e
```

By default the test runner starts the dashboard dev server on port `3100` to avoid collisions with any Docker container already using `3000`.

- Override port: `E2E_PORT=3005 npm run test:e2e`
- Reuse an existing server instead of starting one: `E2E_REUSE_SERVER=1 npm run test:e2e`

To open the HTML report:

```bash
npx playwright show-report
```

## E2E Tests: Real-Model Integration (AlphaFold)

The default E2E suite runs in dashboard mock mode (`MCP_DASHBOARD_MOCK=1`) and does **not** require any ML services.

If you have a running MCP server/stack with real ML backends (AlphaFold in particular), you can run a gated Playwright test that exercises real inference through the dashboard MCP proxy endpoints (and therefore the shared JS SDK invocation path).

Prerequisites:
- A running MCP server/stack with AlphaFold available (typically requires GPU + model weights).
- Dashboard mock mode disabled.

Run (from `mcp-dashboard/`):

```bash
export MCP_INTEGRATION_REAL=1
export MCP_DASHBOARD_MOCK=0
export MCP_SERVER_URL=http://127.0.0.1:${MCP_SERVER_HOST_PORT:-8011}

npx playwright test tests/e2e/integration.real.spec.ts --reporter=line
```

Notes:
- This test can take many minutes depending on hardware and model settings.
- The test will fail fast if the AlphaFold backend reports `backend=mock` or a `mock://` URL.

See [DOCKER_MCP_README.md](../docs/DOCKER_MCP_README.md) for more information.
