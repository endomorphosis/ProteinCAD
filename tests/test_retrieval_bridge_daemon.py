#!/usr/bin/env python3

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp-server"))

import retrieval_bridge_daemon as bridge


def _paths(tmp_path) -> bridge.BridgePaths:
    return bridge.resolve_paths(str(tmp_path / "bridge"))


def _request_artifacts(path: Path) -> list[Path]:
    return [item for item in path.glob("*.json") if not item.name.endswith(".result.json")]


def test_enqueue_and_run_cycle_with_inline_command(tmp_path):
    paths = _paths(tmp_path)
    queued = bridge.enqueue_request(
        paths,
        manifest_id="manifest_1",
        manifest_path=str(tmp_path / "manifest.json"),
        parquet_dir=str(tmp_path / "parquet"),
        action="transform",
        command='python3 -c "print(\'bridge_ok\')"',
    )
    assert queued["ok"] is True

    result = bridge.run_one_cycle(paths, command_template=None, timeout_seconds=30.0)
    assert result["status"] == "completed"
    assert "bridge_ok" in result["stdout"]
    assert len(list(paths.queue_pending.glob("*.json"))) == 0
    assert len(_request_artifacts(paths.queue_completed)) == 1


def test_run_cycle_uses_command_template_placeholders(tmp_path):
    paths = _paths(tmp_path)
    bridge.enqueue_request(
        paths,
        manifest_id="manifest_template",
        manifest_path=str(tmp_path / "manifest_template.json"),
        parquet_dir=str(tmp_path / "parquet_template"),
        action="publish",
        command=None,
    )

    template = 'python3 -c "import sys;print(sys.argv[1])" "{manifest_id}"'
    result = bridge.run_one_cycle(paths, command_template=template, timeout_seconds=30.0)
    assert result["status"] == "completed"
    assert "manifest_template" in result["stdout"]


def test_run_cycle_fails_without_command_configuration(tmp_path):
    paths = _paths(tmp_path)
    bridge.enqueue_request(
        paths,
        manifest_id="manifest_missing_cmd",
        manifest_path=str(tmp_path / "manifest_missing_cmd.json"),
        parquet_dir=str(tmp_path / "parquet_missing_cmd"),
        action="transform",
        command=None,
    )

    result = bridge.run_one_cycle(paths, command_template=None, timeout_seconds=5.0)
    assert result["status"] == "failed"
    assert "No bridge command configured" in (result["error"] or "")
    assert len(_request_artifacts(paths.queue_failed)) == 1
