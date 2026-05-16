# Documentation Index

This repo has accumulated documentation across several areas: the MCP control-plane stack, ARM64/DGX Spark native deployment, GPU and MMseqs2 acceleration, AlphaFold performance tuning, and CI/CD.

Use this page as the **canonical entrypoint** to find the right guide.

---

## Getting started

| Document | Description |
|----------|-------------|
| [../START_HERE.md](../START_HERE.md) | Fastest path to a working UI — one-click (VS Code) or one-command start |
| [QUICKSTART.md](QUICKSTART.md) | Terminal-first quick-start with all stack modes explained |
| [DOCKER_MCP_README.md](DOCKER_MCP_README.md) | Full Docker + MCP stack reference (ports, compose files, NIM setup) |
| [LOCAL_SETUP.md](LOCAL_SETUP.md) | Setting up a local development environment |

---

## Architecture & design

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component overview, run modes, request flow, backend routing, API surface |
| [BLAST_RAG_INTEGRATION_PLAN.md](BLAST_RAG_INTEGRATION_PLAN.md) | DuckDB-first plan for integrating NCBI BLAST retrieval, evidence caching, and optional `ipfs_datasets_py` ingestion |
| [AGENTS.md](AGENTS.md) | How AI agents and contributors should interact with the codebase deterministically |

---

## Performance & GPU acceleration

| Document | Description |
|----------|-------------|
| [ALPHAFOLD_OPTIMIZATION_GUIDE.md](ALPHAFOLD_OPTIMIZATION_GUIDE.md) | AlphaFold speed presets (29% faster), MSA caching, JIT warm-up, CPU thread pinning |
| [ALPHAFOLD_OPTIMIZATION_QUICKREF.md](ALPHAFOLD_OPTIMIZATION_QUICKREF.md) | Quick reference card for AlphaFold optimisation flags |
| [ALPHAFOLD_SETTINGS_DASHBOARD_GUIDE.md](ALPHAFOLD_SETTINGS_DASHBOARD_GUIDE.md) | Configuring AlphaFold speed/quality settings from the Dashboard UI |
| [MMSEQS2_GPU_QUICKSTART.md](MMSEQS2_GPU_QUICKSTART.md) | **Start here for GPU acceleration** — zero-touch GPU server setup, 5–10× MSA speedup |
| [MMSEQS2_GPU_IMPLEMENTATION.md](MMSEQS2_GPU_IMPLEMENTATION.md) | Implementation details: CUDA binary, padded databases, benchmark results |
| [MMSEQS2_GPU_SETUP_CORRECT_WAY.md](MMSEQS2_GPU_SETUP_CORRECT_WAY.md) | Step-by-step GPU setup without the zero-touch installer |
| [MMSEQS2_ZERO_TOUCH_QUICKREF.md](MMSEQS2_ZERO_TOUCH_QUICKREF.md) | Quick reference for zero-touch MMseqs2 GPU installer |
| [MMSEQS2_INSTALLER_INTEGRATION.md](MMSEQS2_INSTALLER_INTEGRATION.md) | How MMseqs2 GPU setup integrates with the main native installer |
| [MMSEQS2_OPTIMIZATION_PLAN.md](MMSEQS2_OPTIMIZATION_PLAN.md) | Optimization roadmap and rationale |
| [ADVANCED_JIT_GPU_OPTIMIZATION.md](ADVANCED_JIT_GPU_OPTIMIZATION.md) | Advanced XLA/JIT GPU optimization techniques |
| [GPU_OPTIMIZATION_INTEGRATION.md](GPU_OPTIMIZATION_INTEGRATION.md) | How GPU optimizations are wired into the Docker and native stacks |
| [PROFILING.md](PROFILING.md) | How to profile AlphaFold runs: GPU utilization, CPU/memory, disk I/O |

---

## ARM64 / DGX Spark deployment

| Document | Description |
|----------|-------------|
| [ARM64_DEPLOYMENT.md](ARM64_DEPLOYMENT.md) | Comprehensive ARM64 deployment guide (Docker emulation vs native vs hybrid) |
| [ARM64_COMPLETE_GUIDE.md](ARM64_COMPLETE_GUIDE.md) | Complete end-to-end ARM64 native installation guide |
| [ARM64_QUICK_START.md](ARM64_QUICK_START.md) | Fast path for getting started on ARM64 |
| [ARM64_NATIVE_INSTALLATION.md](ARM64_NATIVE_INSTALLATION.md) | Manual native installation of all components on ARM64 |
| [ARM64_CUDA_FALLBACK_GUIDE.md](ARM64_CUDA_FALLBACK_GUIDE.md) | bfloat16 / XLA fallback workarounds for ARM64 JAX |
| [ARM64_CUDA_FALLBACK_IMPLEMENTATION.md](ARM64_CUDA_FALLBACK_IMPLEMENTATION.md) | Implementation details for the ARM64 CUDA fallback layer |
| [ARM64_CUDA_FALLBACK_QUICK_REFERENCE.md](ARM64_CUDA_FALLBACK_QUICK_REFERENCE.md) | Quick reference for ARM64 CUDA fallback environment variables |
| [ARM64_COMPATIBILITY.md](ARM64_COMPATIBILITY.md) | Compatibility matrix and known issues for ARM64 packages |
| [ARM64_MODEL_SETUP.md](ARM64_MODEL_SETUP.md) | Model download and configuration for ARM64 |
| [DGX_SPARK_NATIVE_DEPLOYMENT.md](DGX_SPARK_NATIVE_DEPLOYMENT.md) | DGX Spark–specific native deployment guide |
| [SELFHOSTED_RUNNER_SETUP.md](SELFHOSTED_RUNNER_SETUP.md) | Setting up GitHub Actions self-hosted ARM64 GPU runners |

---

## CI/CD & workflows

| Document | Description |
|----------|-------------|
| [CI_CD_GUIDE.md](CI_CD_GUIDE.md) | Overview of GitHub Actions workflows and how to trigger them |
| [WORKFLOW_INTEGRATION.md](WORKFLOW_INTEGRATION.md) | How workflows integrate with the native installer and stack |
| [SYSTEM_VERIFICATION.md](SYSTEM_VERIFICATION.md) | System-level verification scripts and expected outputs |
| [VSCODE_TOOLS_VERIFICATION.md](VSCODE_TOOLS_VERIFICATION.md) | VS Code tasks and tool configuration verification |

---

## Installation & setup

| Document | Description |
|----------|-------------|
| [ZERO_TOUCH_QUICKSTART.md](ZERO_TOUCH_QUICKSTART.md) | One-command zero-touch installation quick start |
| [ZERO_TOUCH_IMPLEMENTATION_PLAN.md](ZERO_TOUCH_IMPLEMENTATION_PLAN.md) | Design and implementation plan for the zero-touch installer |
| [ZERO_TOUCH_GPU_OPTIMIZATION_CHECKLIST.md](ZERO_TOUCH_GPU_OPTIMIZATION_CHECKLIST.md) | Checklist for verifying zero-touch GPU setup is correct |
| [MMSEQS2_ZERO_TOUCH_IMPLEMENTATION.md](MMSEQS2_ZERO_TOUCH_IMPLEMENTATION.md) | How zero-touch MMseqs2 GPU setup is implemented |
| [GPU_MMSEQS2_INTEGRATION_VERIFICATION_REPORT.md](GPU_MMSEQS2_INTEGRATION_VERIFICATION_REPORT.md) | Verification report: 34/34 integration checks passing |
| [MCP_TOOLS_TEST_REPORT.md](MCP_TOOLS_TEST_REPORT.md) | MCP tools test results |

---

## Institutional knowledge / "what changed"

These documents preserve decisions and context accumulated during major feature work. They are narratives rather than step-by-step onboarding guides.

| Document | Description |
|----------|-------------|
| [../INSTITUTIONAL_KNOWLEDGE.md](../INSTITUTIONAL_KNOWLEDGE.md) | **Read this first** — complete GPU/CUDA 13.1/MMseqs2 optimization history, lessons learned, and known issues |
| [../INTEGRATION_COMPLETE.md](../INTEGRATION_COMPLETE.md) | GPU/CUDA 13.1/MMseqs2 integration summary (34/34 checks) |
| [../ZERO_TOUCH_GPU_COMPLETE.md](../ZERO_TOUCH_GPU_COMPLETE.md) | Zero-touch GPU configuration — what was built and how to verify |
| [MMSEQS2_GPU_IMPLEMENTATION_COMPLETE.md](MMSEQS2_GPU_IMPLEMENTATION_COMPLETE.md) | MMseqs2 GPU implementation completion notes |
| [MMSEQS2_GPU_FINAL_RESULTS.md](MMSEQS2_GPU_FINAL_RESULTS.md) | Final MMseqs2 GPU benchmark results |
| [MMSEQS2_GPU_SUCCESS_AND_OPTIMIZATION.md](MMSEQS2_GPU_SUCCESS_AND_OPTIMIZATION.md) | Success story and optimization findings |
| [MMSEQS2_GPU_CRITICAL_FINDINGS.md](MMSEQS2_GPU_CRITICAL_FINDINGS.md) | Critical discoveries during MMseqs2 GPU work |
| [MMSEQS2_GPU_PREFILTER_DISCOVERY.md](MMSEQS2_GPU_PREFILTER_DISCOVERY.md) | How GPU prefilter acceleration was discovered |
| [ADVANCED_JIT_GPU_OPTIMIZATION_SUMMARY.md](ADVANCED_JIT_GPU_OPTIMIZATION_SUMMARY.md) | Advanced JIT/GPU optimization summary |
| [ALPHAFOLD_OPTIMIZATION_IMPLEMENTATION.md](ALPHAFOLD_OPTIMIZATION_IMPLEMENTATION.md) | AlphaFold optimization implementation notes |
| [ZERO_TOUCH_IMPLEMENTATION_SUMMARY.md](ZERO_TOUCH_IMPLEMENTATION_SUMMARY.md) | Zero-touch installer implementation summary |
| [ZERO_TOUCH_GPU_INTEGRATION_COMPLETE.md](ZERO_TOUCH_GPU_INTEGRATION_COMPLETE.md) | Zero-touch GPU integration completion notes |
| [ZERO_TOUCH_GPU_OPTIMIZATION_REFACTORING.md](ZERO_TOUCH_GPU_OPTIMIZATION_REFACTORING.md) | Refactoring notes for GPU optimization code |
| [ARM64_IMPLEMENTATION_SUMMARY.md](ARM64_IMPLEMENTATION_SUMMARY.md) | ARM64 porting implementation summary |
| [ARM64_PORTING_SUMMARY.md](ARM64_PORTING_SUMMARY.md) | High-level summary of ARM64 porting work |
| [ARM64_AUTOMATION_SUMMARY.md](ARM64_AUTOMATION_SUMMARY.md) | ARM64 automation improvements summary |
| [ARM64_CICD_SUCCESS.md](ARM64_CICD_SUCCESS.md) | ARM64 CI/CD pipeline success report |
| [IMPLEMENTATION_COMPLETE.md](IMPLEMENTATION_COMPLETE.md) | General implementation completion notes |
| [PRODUCTION_ORGANIZATION_AUDIT.md](PRODUCTION_ORGANIZATION_AUDIT.md) | Production-readiness audit and file organisation notes |
| [FILE_ORGANIZATION.md](FILE_ORGANIZATION.md) | Repository file organisation guide |
