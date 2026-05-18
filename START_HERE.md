# Start Here (non-ML-friendly)

This project runs on **AMD64 (x86_64)** and **ARM64 (aarch64)**.

If you only want the web UI (Dashboard) and a working end-to-end demo, follow the steps on this page.

---

## 1) One-click start (VS Code)

1. Open this folder in VS Code.
2. Press `Ctrl+Shift+P` → **Tasks: Run Task**.
3. Select **Stack: Start + Open Dashboard**.

It will:
- auto-detect your platform (ARM64 vs AMD64)
- build containers on first run
- open the Dashboard in your browser

---

## 2) One-command start (Terminal)

From the repo root:

```bash
./scripts/run_dashboard_stack.sh up -d --build
```

Open the Dashboard at `http://localhost:3000`.

---

## 3) Quick health check

If anything feels stuck, run the diagnostics script:

```bash
./scripts/doctor_stack.sh
```

It prints a checklist (Docker OK, services OK, URLs OK) and the current service status.

---

## 4) Submit a demo job

Confirms the MCP server + dashboard pipeline wiring is working:

```bash
./scripts/submit_demo_job.sh
```

Then open the Dashboard and look for the new job.

---

## 5) (Optional) Zero-touch native installer

To install the full native toolchain (AlphaFold, RFDiffusion, ProteinMPNN) plus MMseqs2 databases — including automatic GPU acceleration:

```bash
# Minimal DBs — fastest download (~5 GB, ~15 min)
bash scripts/install_all_native.sh --minimal

# Recommended DBs — dev use (~50 GB, ~1 hour)
bash scripts/install_all_native.sh --recommended

# Full DBs — production (~2.3 TB, ~6 hours)
bash scripts/install_all_native.sh --full
```

What it does:
- Installs tools into `~/miniforge3/envs/alphafold2`
- Downloads AlphaFold databases for the chosen tier
- Builds MMseqs2 databases to `~/.cache/alphafold/mmseqs2`
- Auto-configures GPU acceleration (5–10× MSA speedup) when an NVIDIA GPU is detected

---

## 6) Choose backend + fallback order

In the Dashboard header, click **Settings** to choose how model calls are routed:
- **NIM** — NVIDIA NIM services (AMD64, requires NGC API key)
- **External** — any compatible REST services you run elsewhere
- **Embedded** — runs inside the MCP server container (ProteinMPNN supported when weights are present)
- **BLAST Retrieval** — configure DuckDB-backed BLAST defaults, API exposure, and opt-in job grounding controls

Use **fallback** mode to try providers in priority order. Settings persist across restarts when using the provided Docker compose stacks.

---

## 7) (Optional) Validate BLAST retrieval grounding from the UI

1. Open **Settings** and enable retrieval flags you want to test (`retrieval enabled`, and optionally `allow job grounding (opt-in)`).
2. Create a new job and enable **Ground with BLAST evidence (opt-in)** in the job form.
3. Confirm:
   - the job card shows a **BLAST** retrieval status badge
   - completed job results include **BLAST Grounding Evidence** with top hits/evidence/manifest references

If retrieval grounding is disabled in backend config, grounded jobs will show retrieval as disabled or not requested.

---

## Common questions

### "Some services show not_ready or disabled"

That's normal depending on platform and configuration:
- On **AMD64**, NIM model services run natively (best supported).
- On **ARM64**, the repo includes an ARM64-native stack, but some models may require additional download/configuration.

Run `./scripts/doctor_stack.sh` and share the output if you're unsure.

### "Port 3000 is already in use"

```bash
MCP_DASHBOARD_HOST_PORT=3005 ./scripts/run_dashboard_stack.sh up -d --build
```

### "Two MCP server ports?"

- Stack server: `http://localhost:${MCP_SERVER_HOST_PORT:-8011}` — used by dashboard stacks
- Standalone local MCP server: `http://localhost:8010` — used by some demos/tools

---

## Where to go next

| Goal | Document |
|------|----------|
| Full docs index | [docs/INDEX.md](docs/INDEX.md) |
| Architecture overview | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Agent / contributor guide | [docs/AGENTS.md](docs/AGENTS.md) |
| AlphaFold performance tuning | [docs/ALPHAFOLD_OPTIMIZATION_GUIDE.md](docs/ALPHAFOLD_OPTIMIZATION_GUIDE.md) |
| MMseqs2 GPU acceleration | [docs/MMSEQS2_GPU_QUICKSTART.md](docs/MMSEQS2_GPU_QUICKSTART.md) |
| Docker + MCP stack details | [docs/DOCKER_MCP_README.md](docs/DOCKER_MCP_README.md) |
| GPU/MMseqs2 institutional knowledge | [INSTITUTIONAL_KNOWLEDGE.md](INSTITUTIONAL_KNOWLEDGE.md) |
