# MCP Server

Model Context Protocol server for managing protein binder design workflows.

## Quick Start

### Using Docker
```bash
docker build -t mcp-server .
docker run -p 8000:8000 \
  -e ALPHAFOLD_URL=http://alphafold:8000 \
  -e RFDIFFUSION_URL=http://rfdiffusion:8000 \
  -e PROTEINMPNN_URL=http://proteinmpnn:8000 \
  -e ALPHAFOLD_MULTIMER_URL=http://alphafold-multimer:8000 \
  mcp-server
```

### Local Development
```bash
pip install -r requirements.txt
python server.py
```

Local dev server:

- API: http://localhost:8000
- Docs: http://localhost:8000/docs

If you’re running the full stack via `./scripts/run_dashboard_stack.sh`, the MCP Server is typically exposed on the host at:

- API: http://localhost:${MCP_SERVER_HOST_PORT:-8011}
- Docs: http://localhost:${MCP_SERVER_HOST_PORT:-8011}/docs

## Environment Variables

- `ALPHAFOLD_URL` - AlphaFold service endpoint (default: http://localhost:8081 when running locally)
- `RFDIFFUSION_URL` - RFDiffusion service endpoint (default: http://localhost:8082 when running locally)
- `PROTEINMPNN_URL` - ProteinMPNN service endpoint (default: http://localhost:8083 when running locally)
- `ALPHAFOLD_MULTIMER_URL` - AlphaFold-Multimer service endpoint (default: http://localhost:8084 when running locally)
- `MCP_RETRIEVAL_ENABLED` - Enable BLAST retrieval subsystem
- `MCP_RETRIEVAL_EXPOSE_REST` - Expose `/api/retrieval/*` REST endpoints
- `MCP_RETRIEVAL_EXPOSE_MCP` - Expose MCP retrieval tools/resources
- `MCP_RETRIEVAL_ENABLE_JOB_GROUNDING` - Allow design-job grounding by default (default is disabled/opt-in)
- `MCP_RETRIEVAL_EXPORT_PARQUET` - Enable optional Parquet bundle export
- `MCP_RETRIEVAL_DATA_DIR` / `MCP_RETRIEVAL_DUCKDB_PATH` - Retrieval storage location overrides

Note: in this repo’s dashboard compose stacks, model services are typically published on host ports `18081–18084` and the stack sets these URLs accordingly.

## API Endpoints

See [DOCKER_MCP_README.md](../docs/DOCKER_MCP_README.md) for detailed API documentation.

### Job diagnostics query params

`GET /api/jobs/{job_id}` supports:

- `include_metrics=1`: include stage timing + best-effort metrics snapshots
- `include_residency=1`: include page-cache residency sampling (slower)
- `include_error_detail=1`: include full error detail (default responses keep errors UI-safe via summarization/truncation)

### BLAST retrieval endpoints

When retrieval REST exposure is enabled:

- `POST /api/retrieval/requests`: submit a retrieval request
- `GET /api/retrieval/requests/{request_id}`: read normalized retrieval bundle/status
- `GET /api/retrieval/cache`: list cached retrieval entries

MCP exposure includes tools:

- `start_blast_retrieval`
- `get_blast_retrieval`

And resources:

- `retrieval://{request_id}`
- `retrieval-manifest://{manifest_id}`

### Handy scripts

From repo root:

- Submit a demo job: `./scripts/submit_demo_job.sh`
- Monitor progress/liveness: `./scripts/monitor_job.sh <job_id> --metrics`
