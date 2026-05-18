#!/usr/bin/env python3
"""Optional ipfs_datasets_py bridge daemon + supervisor for retrieval exports."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

MAX_LOG_CAPTURE_CHARS = 20000


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _json_read(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


def _terminate_pid(pid: int, grace_seconds: float = 8.0) -> bool:
    if not _pid_alive(pid):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        return False
    deadline = time.monotonic() + max(0.0, float(grace_seconds))
    while _pid_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.2)
    if _pid_alive(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    return True


@dataclass(frozen=True)
class BridgePaths:
    base_dir: Path
    queue_pending: Path
    queue_running: Path
    queue_completed: Path
    queue_failed: Path
    status_file: Path
    supervisor_status_file: Path
    daemon_pid_file: Path
    supervisor_pid_file: Path
    latest_log_symlink: Path
    logs_dir: Path


def _default_bridge_dir() -> Path:
    explicit = (os.getenv("MCP_RETRIEVAL_IPFS_BRIDGE_DIR") or "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    manifest_dir = (os.getenv("MCP_RETRIEVAL_MANIFEST_DIR") or "").strip()
    if manifest_dir:
        return (Path(manifest_dir).expanduser().resolve() / "ipfs_bridge")
    return (Path.cwd() / "retrieval" / "ipfs_bridge").resolve()


def resolve_paths(base_dir: Optional[str]) -> BridgePaths:
    base = Path(base_dir).expanduser().resolve() if base_dir else _default_bridge_dir()
    return BridgePaths(
        base_dir=base,
        queue_pending=base / "queue" / "pending",
        queue_running=base / "queue" / "running",
        queue_completed=base / "queue" / "completed",
        queue_failed=base / "queue" / "failed",
        status_file=base / "status.json",
        supervisor_status_file=base / "supervisor_status.json",
        daemon_pid_file=base / "daemon.pid",
        supervisor_pid_file=base / "supervisor.pid",
        latest_log_symlink=base / "logs" / "bridge_daemon_latest.log",
        logs_dir=base / "logs",
    )


def ensure_paths(paths: BridgePaths) -> None:
    for path in (
        paths.queue_pending,
        paths.queue_running,
        paths.queue_completed,
        paths.queue_failed,
        paths.logs_dir,
    ):
        path.mkdir(parents=True, exist_ok=True)
    paths.base_dir.mkdir(parents=True, exist_ok=True)


def write_daemon_status(paths: BridgePaths, state: str, **extra: Any) -> dict[str, Any]:
    payload = {
        "schema": "proteincad.retrieval_ipfs_bridge.status.v1",
        "state": state,
        "updated_at": _utcnow(),
        "pid": os.getpid(),
    }
    payload.update(extra)
    _json_write(paths.status_file, payload)
    return payload


def write_supervisor_status(paths: BridgePaths, state: str, **extra: Any) -> dict[str, Any]:
    payload = {
        "schema": "proteincad.retrieval_ipfs_bridge.supervisor.v1",
        "state": state,
        "updated_at": _utcnow(),
        "supervisor_pid": os.getpid(),
    }
    payload.update(extra)
    _json_write(paths.supervisor_status_file, payload)
    return payload


def _queued_requests(paths: BridgePaths) -> list[Path]:
    return sorted(paths.queue_pending.glob("*.json"))


def enqueue_request(
    paths: BridgePaths,
    *,
    manifest_id: str,
    manifest_path: str,
    parquet_dir: str,
    action: str,
    command: Optional[str],
) -> dict[str, Any]:
    ensure_paths(paths)
    request_id = f"bridge_{_run_id()}_{manifest_id or 'unknown_manifest'}"
    payload = {
        "request_id": request_id,
        "manifest_id": manifest_id,
        "manifest_path": manifest_path,
        "parquet_dir": parquet_dir,
        "action": action,
        "command": command,
        "created_at": _utcnow(),
    }
    queue_file = paths.queue_pending / f"{request_id}.json"
    _json_write(queue_file, payload)
    return {"ok": True, "request": payload, "queue_file": str(queue_file)}


def _build_command(request: dict[str, Any], command_template: Optional[str]) -> tuple[list[str], Optional[str]]:
    template = (request.get("command") or "").strip() or (command_template or "").strip()
    if not template:
        return [], "No bridge command configured; set --command-template or include request.command"
    mapping = {
        "request_id": str(request.get("request_id") or ""),
        "manifest_id": str(request.get("manifest_id") or ""),
        "manifest_path": str(request.get("manifest_path") or ""),
        "parquet_dir": str(request.get("parquet_dir") or ""),
        "action": str(request.get("action") or ""),
    }
    try:
        rendered = template.format(**mapping)
    except Exception as exc:
        return [], f"Failed to render command template: {exc}"
    return shlex.split(rendered), None


def run_one_cycle(paths: BridgePaths, *, command_template: Optional[str], timeout_seconds: float) -> dict[str, Any]:
    ensure_paths(paths)
    pending = _queued_requests(paths)
    if not pending:
        status = write_daemon_status(paths, "no_work", queue_depth=0, heartbeat_at=_utcnow())
        return {"status": "no_work", "status_payload": status}

    pending_file = pending[0]
    running_file = paths.queue_running / pending_file.name
    pending_file.replace(running_file)
    request = _json_read(running_file)
    request_id = str(request.get("request_id") or running_file.stem)
    write_daemon_status(
        paths,
        "running",
        queue_depth=len(pending),
        request_id=request_id,
        manifest_id=request.get("manifest_id"),
        heartbeat_at=_utcnow(),
    )

    command, command_error = _build_command(request, command_template)
    started_at = _utcnow()
    stdout = ""
    stderr = ""
    return_code: Optional[int] = None
    status = "failed"
    error_text = command_error

    if command_error is None:
        try:
            proc = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=max(1.0, float(timeout_seconds)),
                check=False,
            )
            return_code = proc.returncode
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            if proc.returncode == 0:
                status = "completed"
                error_text = None
            else:
                error_text = f"Bridge command failed with exit code {proc.returncode}"
        except subprocess.TimeoutExpired as exc:
            stdout = str(exc.stdout or "")
            stderr = str(exc.stderr or "")
            return_code = None
            error_text = f"Bridge command timed out after {timeout_seconds}s"
        except Exception as exc:
            error_text = f"Bridge command execution failed: {exc}"

    completed_at = _utcnow()
    result_payload = {
        "schema": "proteincad.retrieval_ipfs_bridge.result.v1",
        "request": request,
        "status": status,
        "command": command,
        "command_template": command_template,
        "return_code": return_code,
        "started_at": started_at,
        "completed_at": completed_at,
        "stdout": stdout[-MAX_LOG_CAPTURE_CHARS:],
        "stderr": stderr[-MAX_LOG_CAPTURE_CHARS:],
        "error": error_text,
    }

    destination_dir = paths.queue_completed if status == "completed" else paths.queue_failed
    destination_file = destination_dir / running_file.name
    running_file.replace(destination_file)
    _json_write(destination_file.with_suffix(".result.json"), result_payload)
    write_daemon_status(
        paths,
        "cycle_completed",
        request_id=request_id,
        queue_depth=len(_queued_requests(paths)),
        result_status=status,
        error=error_text,
        heartbeat_at=_utcnow(),
    )
    return result_payload


def run_daemon(args: argparse.Namespace) -> int:
    paths = resolve_paths(args.base_dir)
    ensure_paths(paths)
    paths.daemon_pid_file.write_text(f"{os.getpid()}\n", encoding="utf-8")
    write_daemon_status(paths, "started", watch=bool(args.watch), interval_seconds=float(args.interval_seconds))
    try:
        while True:
            result = run_one_cycle(
                paths,
                command_template=args.command_template,
                timeout_seconds=float(args.command_timeout_seconds),
            )
            if not args.watch:
                return 0 if result.get("status") != "failed" else 1
            if float(args.interval_seconds) > 0:
                write_daemon_status(paths, "sleeping", seconds=float(args.interval_seconds), heartbeat_at=_utcnow())
                time.sleep(float(args.interval_seconds))
    finally:
        paths.daemon_pid_file.unlink(missing_ok=True)
        write_daemon_status(paths, "stopped", heartbeat_at=_utcnow())


def supervise_daemon(args: argparse.Namespace) -> int:
    paths = resolve_paths(args.base_dir)
    ensure_paths(paths)
    paths.supervisor_pid_file.write_text(f"{os.getpid()}\n", encoding="utf-8")
    restart_count = 0
    try:
        while True:
            run_id = _run_id()
            log_file = paths.logs_dir / f"bridge_daemon_{run_id}.log"
            try:
                paths.latest_log_symlink.unlink()
            except FileNotFoundError:
                pass
            try:
                paths.latest_log_symlink.symlink_to(log_file.name)
            except Exception:
                pass

            cmd = [
                sys.executable,
                str(Path(__file__).resolve()),
                "run",
                "--watch",
                "--base-dir",
                str(paths.base_dir),
                "--interval-seconds",
                str(float(args.interval_seconds)),
                "--command-timeout-seconds",
                str(float(args.command_timeout_seconds)),
            ]
            if args.command_template:
                cmd.extend(["--command-template", str(args.command_template)])

            write_supervisor_status(
                paths,
                "launching_child",
                run_id=run_id,
                restart_count=restart_count,
                command=cmd,
                log_path=str(log_file),
            )

            # Binary append keeps raw subprocess stream bytes intact across restarts.
            with log_file.open("ab") as handle:
                child = subprocess.Popen(
                    cmd,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    cwd=str(Path(__file__).resolve().parent),
                    start_new_session=True,
                )
            paths.daemon_pid_file.write_text(f"{child.pid}\n", encoding="utf-8")
            write_supervisor_status(
                paths,
                "running",
                run_id=run_id,
                restart_count=restart_count,
                daemon_pid=child.pid,
                log_path=str(log_file),
            )

            try:
                exit_code = child.wait()
            except KeyboardInterrupt:
                _terminate_pid(child.pid, grace_seconds=6.0)
                write_supervisor_status(paths, "stopped", restart_count=restart_count)
                return 0

            paths.daemon_pid_file.unlink(missing_ok=True)
            daemon_status = _json_read(paths.status_file)
            restart_count += 1
            write_supervisor_status(
                paths,
                "child_exited",
                run_id=run_id,
                restart_count=restart_count,
                last_exit_code=exit_code,
                daemon_state=daemon_status.get("state"),
            )

            if not args.watch:
                return int(exit_code or 0)

            daemon_state = str(daemon_status.get("state") or "")
            fast_states = {"no_work", "sleeping"}
            delay = float(args.fast_restart_backoff_seconds if daemon_state in fast_states else args.restart_backoff_seconds)
            if delay > 0:
                write_supervisor_status(
                    paths,
                    "sleeping_before_restart",
                    seconds=delay,
                    restart_count=restart_count,
                    last_exit_code=exit_code,
                    daemon_state=daemon_state,
                )
                time.sleep(delay)
    finally:
        paths.supervisor_pid_file.unlink(missing_ok=True)
        write_supervisor_status(paths, "stopped", restart_count=restart_count)


def check_status(args: argparse.Namespace) -> int:
    paths = resolve_paths(args.base_dir)
    ensure_paths(paths)
    daemon_status = _json_read(paths.status_file)
    supervisor_status = _json_read(paths.supervisor_status_file)
    daemon_pid = (paths.daemon_pid_file.read_text(encoding="utf-8").strip() if paths.daemon_pid_file.exists() else "")
    supervisor_pid = (
        paths.supervisor_pid_file.read_text(encoding="utf-8").strip() if paths.supervisor_pid_file.exists() else ""
    )
    payload = {
        "checked_at": _utcnow(),
        "base_dir": str(paths.base_dir),
        "daemon_pid": daemon_pid or None,
        "daemon_alive": _pid_alive(daemon_pid) if daemon_pid else False,
        "supervisor_pid": supervisor_pid or None,
        "supervisor_alive": _pid_alive(supervisor_pid) if supervisor_pid else False,
        "queue_depth": len(_queued_requests(paths)),
        "daemon_status": daemon_status,
        "supervisor_status": supervisor_status,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def stop_processes(args: argparse.Namespace) -> int:
    paths = resolve_paths(args.base_dir)
    stopped: list[int] = []
    for pid_path in (paths.daemon_pid_file, paths.supervisor_pid_file):
        if not pid_path.exists():
            continue
        try:
            pid = int(pid_path.read_text(encoding="utf-8").strip())
        except Exception:
            pid_path.unlink(missing_ok=True)
            continue
        if _terminate_pid(pid, grace_seconds=6.0):
            stopped.append(pid)
        pid_path.unlink(missing_ok=True)
    write_daemon_status(paths, "stopped", stopped_pids=stopped, heartbeat_at=_utcnow())
    write_supervisor_status(paths, "stopped", stopped_pids=stopped)
    print(json.dumps({"ok": True, "stopped_pids": stopped}, indent=2))
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ProteinCAD retrieval ipfs bridge daemon/supervisor")
    subparsers = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-dir", default="", help="Bridge working directory")

    enqueue = subparsers.add_parser("enqueue", parents=[common], help="Queue one ipfs bridge request")
    enqueue.add_argument("--manifest-id", required=True)
    enqueue.add_argument("--manifest-path", required=True)
    enqueue.add_argument("--parquet-dir", required=True)
    enqueue.add_argument("--action", default="transform")
    enqueue.add_argument("--command", default="", help="Optional command template for this request")

    run = subparsers.add_parser("run", parents=[common], help="Run daemon worker loop")
    run.add_argument("--watch", action="store_true", help="Loop continuously")
    run.add_argument("--interval-seconds", type=float, default=15.0)
    run.add_argument("--command-timeout-seconds", type=float, default=1800.0)
    run.add_argument(
        "--command-template",
        default=(os.getenv("MCP_RETRIEVAL_IPFS_BRIDGE_COMMAND") or "").strip(),
        help="Default command template with placeholders: {manifest_path} {parquet_dir} {manifest_id} {request_id}",
    )

    supervise = subparsers.add_parser("supervise", parents=[common], help="Run daemon under supervisor")
    supervise.add_argument("--watch", action="store_true", help="Restart child on exit")
    supervise.add_argument("--interval-seconds", type=float, default=15.0)
    supervise.add_argument("--command-timeout-seconds", type=float, default=1800.0)
    supervise.add_argument("--restart-backoff-seconds", type=float, default=30.0)
    supervise.add_argument("--fast-restart-backoff-seconds", type=float, default=2.0)
    supervise.add_argument(
        "--command-template",
        default=(os.getenv("MCP_RETRIEVAL_IPFS_BRIDGE_COMMAND") or "").strip(),
    )

    subparsers.add_parser("check", parents=[common], help="Print status JSON")
    subparsers.add_parser("stop", parents=[common], help="Stop daemon/supervisor pids")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "enqueue":
        paths = resolve_paths(args.base_dir)
        payload = enqueue_request(
            paths,
            manifest_id=args.manifest_id,
            manifest_path=args.manifest_path,
            parquet_dir=args.parquet_dir,
            action=args.action,
            command=(args.command or "").strip() or None,
        )
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    if args.command == "run":
        return run_daemon(args)
    if args.command == "supervise":
        return supervise_daemon(args)
    if args.command == "check":
        return check_status(args)
    if args.command == "stop":
        return stop_processes(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
