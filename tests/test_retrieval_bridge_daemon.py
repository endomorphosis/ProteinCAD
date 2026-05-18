#!/usr/bin/env python3

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp-server"))

import retrieval_bridge_daemon as bridge


def _paths(tmp_path) -> bridge.BridgePaths:
    return bridge.resolve_paths(str(tmp_path / "bridge"))


def _list_request_files(path: Path) -> list[Path]:
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
    assert len(_list_request_files(paths.queue_completed)) == 1


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
    assert len(_list_request_files(paths.queue_failed)) == 1


def test_extract_publication_fields_parses_cid_from_stdout():
    # Plain JSON stdout containing CID/CAR/status fields.
    stdout = '{"ipfs_cid": "bafybeiabc", "ipfs_car_path": "/tmp/bundle.car", "publication_status": "published"}'
    fields = bridge._extract_publication_fields(stdout)
    assert fields["ipfs_cid"] == "bafybeiabc"
    assert fields["ipfs_car_path"] == "/tmp/bundle.car"
    assert fields["publication_status"] == "published"

    # Stdout with mixed log lines and a trailing JSON object.
    mixed = 'Publishing to IPFS...\nUploaded 3 blocks\n{"ipfs_cid":"bafymixed","publication_status":"published"}'
    fields2 = bridge._extract_publication_fields(mixed)
    assert fields2["ipfs_cid"] == "bafymixed"
    assert fields2["publication_status"] == "published"

    # Empty stdout returns empty dict.
    assert bridge._extract_publication_fields("") == {}
    assert bridge._extract_publication_fields("   ") == {}

    # Non-JSON stdout without recognised keys returns empty dict.
    assert bridge._extract_publication_fields("bridge_ok") == {}


def test_run_cycle_back_annotates_manifest_with_cid(tmp_path):
    """Bridge daemon writes CID/CAR back to the manifest JSON file on success."""
    import json

    paths = _paths(tmp_path)
    manifest_path = tmp_path / "manifest_pub.json"
    manifest_path.write_text(
        json.dumps({"manifest_id": "manifest_pub", "request_id": "req1"}),
        encoding="utf-8",
    )

    # Write a small helper script that prints the CID JSON to stdout.
    helper_script = tmp_path / "emit_cid.py"
    helper_script.write_text(
        'import json, sys\nprint(json.dumps({"ipfs_cid": "bafypubtest", "publication_status": "published"}))\n',
        encoding="utf-8",
    )
    command = f'python3 {str(helper_script)}'
    bridge.enqueue_request(
        paths,
        manifest_id="manifest_pub",
        manifest_path=str(manifest_path),
        parquet_dir=str(tmp_path / "parquet"),
        action="publish",
        command=command,
    )
    result = bridge.run_one_cycle(paths, command_template=None, timeout_seconds=30.0)
    assert result["status"] == "completed"
    assert result["publication_fields"]["ipfs_cid"] == "bafypubtest"
    assert result["publication_fields"]["publication_status"] == "published"

    # The manifest file should now have the CID field written in.
    updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert updated_manifest["ipfs_cid"] == "bafypubtest"
    assert updated_manifest["publication_status"] == "published"

