"""CLI command handlers for health, routing, run, subagents, and inventory."""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .inventory import (
    build_inventory_report,
    capability_cache_path,
    load_json,
    log_escalation,
    log_routing_event,
    routing_event,
    save_json,
)
from .lanes import (
    Lane,
    OrchestratorError,
    call_chat,
    check_lane_health,
    cloud_default_enabled,
    is_cloud_lane,
    lane_from_config,
    ordered_lane_keys,
    primary_lane_order,
    request_timeout,
)
from .routing import choose_primary_lane, resolve_subagent_lane, resolve_subagent_request
from .safety import parse_executable_plan, run_actions


def split_subtasks(task: str) -> List[str]:
    """Explicit '||' separators only; implicit sentence splitting was removed
    because round-robin sentence buckets produce incoherent slices."""
    explicit = [t.strip() for t in task.split("||") if t.strip()]
    if explicit:
        return explicit
    return [task.strip()]


def auto_split_subtasks(cfg: Dict[str, Any], lane: Lane, task: str, parts: int) -> List[str]:
    system_prompt = (
        f"Split the user's task into at most {parts} independent subtasks that can run in parallel "
        "without depending on each other's output. Return a strict JSON array of strings only, "
        "no markdown. If the task cannot be split, return a JSON array with the original task."
    )
    try:
        reply, _, _ = call_chat(lane, request_timeout(cfg), system_prompt, task, temperature=0.0)
        parsed = json.loads(reply)
    except (OrchestratorError, json.JSONDecodeError):
        return [task.strip()]
    if not isinstance(parsed, list):
        return [task.strip()]
    subtasks = [item.strip() for item in parsed if isinstance(item, str) and item.strip()]
    if not subtasks:
        return [task.strip()]
    return subtasks[: max(1, parts)]


def command_health(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    summary = {}
    for key in ordered_lane_keys(cfg):
        lane = lane_from_config(cfg, key)
        ok, reason = check_lane_health(cfg, lane)
        summary[key] = {
            "lane": lane.name,
            "role": lane.role,
            "priority": lane.priority,
            "healthy": ok,
            "reason": reason,
            "model": lane.model,
            "fallback_models": lane.fallback_models or [],
            "base_url": lane.base_url,
        }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def command_route(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    lane_key, lane = choose_primary_lane(cfg, args.allow_cloud, args.reason_code)
    print(
        json.dumps(
            {
                "selected_lane": lane_key,
                "lane": lane.name,
                "model": lane.model,
                "fallback_models": lane.fallback_models or [],
            },
            indent=2,
        )
    )
    return 0


def log_cloud_escalation(
    cfg: Dict[str, Any],
    args: argparse.Namespace,
    task_id: str,
    reason_code: str,
    selected_model: str,
    decomposition_attempted: bool,
) -> None:
    """Append the cloud-escalation-policy.md audit record for a cloud-served task."""
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "task_id": task_id,
        "reason_code": reason_code,
        "selected_model": selected_model,
        "decomposition_attempted": decomposition_attempted,
        "local_capacity_snapshot": args.local_capacity_snapshot,
        "remote_capacity_snapshot": args.remote_capacity_snapshot,
        "escalation_approved_by": args.escalation_approved_by,
    }
    log_escalation(cfg, event, Path(args.escalation_log))


RUN_SYSTEM_PROMPT = (
    "You are a coding execution assistant. Give direct, concrete output. "
    "Do not claim actions that were not completed."
)
RUN_PLAN_SYSTEM_PROMPT = (
    "Return strict JSON only, no markdown. JSON schema: "
    "{\"final_answer\": string, \"actions\": string[]} where actions are optional shell commands. "
    "Only include commands that are safe and idempotent."
)


def run_on_first_available_lane(
    cfg: Dict[str, Any],
    args: argparse.Namespace,
    system_prompt: str,
) -> Tuple[str, Lane, str, str, Dict[str, Any], List[Dict[str, str]]]:
    """Walk the primary lane order until one completes the task.

    Returns (lane_key, lane, response, model, meta, attempts) where attempts
    records every lane skipped or failed before the winner.
    """
    timeout = request_timeout(cfg)
    attempts: List[Dict[str, str]] = []
    for lane_key in primary_lane_order(cfg):
        lane = lane_from_config(cfg, lane_key)
        if not lane.enabled:
            attempts.append({"lane": lane.name, "skipped": "disabled"})
            continue
        if is_cloud_lane(cfg, lane_key):
            if not args.allow_cloud:
                attempts.append({"lane": lane.name, "skipped": "cloud_not_allowed"})
                continue
        else:
            ok, reason = check_lane_health(cfg, lane)
            if not ok:
                attempts.append({"lane": lane.name, "skipped": f"unhealthy:{reason}"})
                continue
        try:
            response, selected_model, meta = call_chat(
                lane, timeout, system_prompt, args.task, temperature=args.temperature
            )
        except OrchestratorError as exc:
            attempts.append({"lane": lane.name, "error": str(exc)})
            log_routing_event(cfg, routing_event("run", lane, lane.model, ok=False, error=str(exc)))
            continue
        return lane_key, lane, response, selected_model, meta, attempts
    raise OrchestratorError(f"No lane completed the task. Attempts: {attempts}")


def command_run(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    system_prompt = RUN_PLAN_SYSTEM_PROMPT if args.require_executable_plan else RUN_SYSTEM_PROMPT
    lane_key, lane, response, selected_model, meta, attempts = run_on_first_available_lane(
        cfg, args, system_prompt
    )
    log_routing_event(
        cfg,
        routing_event(
            "run",
            lane,
            selected_model,
            ok=True,
            latency_ms=meta.get("latency_ms"),
            usage=meta.get("usage"),
            extra={"task_id": args.task_id or ""},
        ),
    )

    fallback_attempts = [a for a in attempts if "error" in a]
    if fallback_attempts:
        print(json.dumps({"fallback_attempts": fallback_attempts}, indent=2))

    if args.require_executable_plan:
        plan = parse_executable_plan(response)
        print(plan["final_answer"])
        if args.execute_approved and bool(cfg["execution"].get("allow_shell_execution", False)):
            allowed = list(cfg["execution"].get("allowed_command_prefixes", []))
            action_results = run_actions(
                plan.get("actions", []),
                allowed,
                allow_repo_code_execution=bool(cfg["execution"].get("allow_repo_code_execution", False)),
            )
            print(json.dumps({"action_results": action_results}, indent=2))
    else:
        print(response)

    if is_cloud_lane(cfg, lane_key):
        log_cloud_escalation(
            cfg,
            args,
            task_id=args.task_id or f"task-{int(time.time())}",
            reason_code=args.reason_code,
            selected_model=selected_model,
            decomposition_attempted=bool(args.decomposition_attempted),
        )

    return 0


def subagent_tasks(cfg: Dict[str, Any], lane: Lane, args: argparse.Namespace, explicit_tasks: List[str]) -> List[str]:
    """Explicit '||' slices win; otherwise optionally ask the lane to split."""
    if len(explicit_tasks) > 1:
        return explicit_tasks
    if args.auto_split and args.parts > 1:
        return auto_split_subtasks(cfg, lane, args.task, args.parts)
    return [args.task.strip()]


def run_subagent_slice(
    cfg: Dict[str, Any],
    lane: Lane,
    preset: str,
    temperature: float,
    index: int,
    subtask: str,
) -> Dict[str, Any]:
    """Run one slice on ``lane``, logging the outcome; re-raises call failures."""
    system_prompt = f"You are subagent {index}. Execute your assigned slice only, output concrete result."
    extra = {"subtask_index": index, "preset": preset}
    try:
        reply, used_model, meta = call_chat(lane, request_timeout(cfg), system_prompt, subtask, temperature=temperature)
    except OrchestratorError as exc:
        log_routing_event(
            cfg, routing_event("subagents", lane, lane.model, ok=False, error=str(exc), extra=extra)
        )
        raise
    log_routing_event(
        cfg,
        routing_event(
            "subagents", lane, used_model, ok=True,
            latency_ms=meta.get("latency_ms"), usage=meta.get("usage"), extra=extra,
        ),
    )
    return {
        "subtask_index": index,
        "lane": lane.name,
        "model": used_model,
        "input": subtask,
        "output": reply,
    }


def command_subagents(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    request = resolve_subagent_request(cfg, args)
    # Fails closed: cloud is off unless policy AND execution both opt in (HERMES-2).
    allow_cloud = bool(args.allow_cloud) or cloud_default_enabled(cfg)
    max_parallel = max(1, int(cfg["execution"].get("max_parallel_subagents", 4)))
    explicit_tasks = split_subtasks(args.task)

    # Failed lanes are disabled in this private copy so the next resolve moves on.
    attempt_cfg = json.loads(json.dumps(cfg))
    outputs: List[Dict[str, Any]] = []
    chosen_lane_key = ""
    chosen_lane: Optional[Lane] = None
    lane_failures: List[Dict[str, str]] = []
    workers = 1
    # Real escalation telemetry (cloud-escalation-policy.md): whether the
    # delegation actually went out as multiple subtasks, not a hardcoded True.
    decomposition_attempted = False

    for _ in range(len(ordered_lane_keys(cfg))):
        lane_key, lane = resolve_subagent_lane(
            attempt_cfg,
            allow_cloud=allow_cloud,
            task_profile=request["task_profile"],
            required_model=request["required_model"],
        )
        tasks = subagent_tasks(cfg, lane, args, explicit_tasks)
        decomposition_attempted = len(tasks) > 1
        workers = min(max_parallel, len(tasks))

        def run_slice(item: Tuple[int, str], lane: Lane = lane) -> Dict[str, Any]:
            return run_subagent_slice(cfg, lane, request["preset"], args.temperature, *item)

        try:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                outputs = list(pool.map(run_slice, list(enumerate(tasks, start=1))))
        except OrchestratorError as exc:
            lane_failures.append({"lane": lane.name, "error": str(exc)})
            if lane_key in attempt_cfg.get("lanes", {}):
                attempt_cfg["lanes"][lane_key]["enabled"] = False
            continue
        chosen_lane_key, chosen_lane = lane_key, lane
        break

    if chosen_lane is None:
        raise OrchestratorError(f"All delegated lanes failed: {lane_failures}")

    chosen_models: List[str] = []
    for record in outputs:
        if record["model"] not in chosen_models:
            chosen_models.append(record["model"])

    if is_cloud_lane(cfg, chosen_lane_key):
        log_cloud_escalation(
            cfg,
            args,
            task_id=args.task_id or f"subagents-{int(time.time())}",
            reason_code=request["reason_code"],
            selected_model=chosen_models[0] if chosen_models else chosen_lane.model,
            decomposition_attempted=decomposition_attempted,
        )

    payload: Dict[str, Any] = {
        "lane": chosen_lane.name,
        "preset": request["preset"],
        "task_profile": request["task_profile"],
        "required_model": request["required_model"],
        "selected_models": chosen_models,
        "parallel_workers": workers,
        "count": len(outputs),
        "results": outputs,
    }
    if lane_failures:
        payload["fallback_failures"] = lane_failures
    print(json.dumps(payload, indent=2))
    return 0


def command_presets(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    presets = cfg.get("execution", {}).get("routing_presets", {})
    default_preset = cfg.get("execution", {}).get("default_subagent_preset", "general")
    print(json.dumps({"default_preset": default_preset, "routing_presets": presets}, indent=2, sort_keys=True))
    return 0


def command_inventory(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    previous = {} if args.force_probe else load_json(Path(args.output))
    inventory = build_inventory_report(
        cfg,
        include_cloud=bool(args.include_cloud),
        probe_tool_calls=bool(args.probe_tool_calls),
        previous=previous,
    )

    cache_path = Path(args.output)
    save_json(cache_path, inventory)
    print(json.dumps(inventory, indent=2, sort_keys=True))
    return 0


def command_refresh_cache(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    output = Path(args.output) if args.output else capability_cache_path(cfg)
    previous = {} if args.force_probe else load_json(output)
    refreshed = build_inventory_report(
        cfg,
        include_cloud=bool(args.include_cloud),
        probe_tool_calls=bool(args.probe_tool_calls),
        previous=previous,
    )
    save_json(output, refreshed)
    print(json.dumps({"refreshed": True, "output": str(output), "timestamp": refreshed.get("timestamp")}, indent=2))
    return 0
