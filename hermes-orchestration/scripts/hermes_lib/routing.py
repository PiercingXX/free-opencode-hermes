"""Primary-task and subagent lane selection."""

from __future__ import annotations

import argparse
from typing import Any, Dict, List, Tuple

from .inventory import (
    build_inventory_report,
    cache_has_required_tool_probe_data,
    capability_cache_path,
    candidate_healthy_from_cache,
    load_json,
    maybe_refresh_capability_cache,
    save_json,
)
from .lanes import (
    Lane,
    OrchestratorError,
    check_lane_health,
    cloud_lane_keys,
    is_cloud_lane,
    lane_from_config,
    ordered_lane_keys,
    primary_lane_order,
    self_hosted_lane_keys,
)


def resolve_named_preset(cfg: Dict[str, Any], preset_name: str) -> Dict[str, Any]:
    presets = cfg.get("execution", {}).get("routing_presets", {})
    if not isinstance(presets, dict):
        return {}
    if not preset_name:
        return {}

    preset = presets.get(preset_name)
    if not isinstance(preset, dict):
        raise OrchestratorError(f"Unknown routing preset: {preset_name}")
    return preset


def resolve_subagent_request(cfg: Dict[str, Any], args: argparse.Namespace) -> Dict[str, str]:
    default_preset = str(cfg.get("execution", {}).get("default_subagent_preset", "general"))
    preset_name = args.preset or default_preset
    preset = resolve_named_preset(cfg, preset_name)

    task_profile = args.task_profile or str(preset.get("task_profile", "default"))
    required_model = args.required_model or str(preset.get("required_model", ""))
    reason_code = args.reason_code or str(preset.get("reason_code", "SUBAGENT_MANUAL"))

    return {
        "preset": preset_name,
        "task_profile": task_profile,
        "required_model": required_model,
        "reason_code": reason_code,
    }


def cloud_allowed_for_subagents(cfg: Dict[str, Any], allow_cloud: bool, task_profile: str) -> bool:
    if not allow_cloud:
        return False
    enabled_cloud = [
        key
        for key in cloud_lane_keys(cfg)
        if bool(cfg["lanes"][key].get("enabled", False))
    ]
    if not enabled_cloud:
        return False
    # Both keys are cloud opt-ins and both fail closed: a dropped key must never
    # widen cloud eligibility (HERMES-2).
    if not bool(cfg["execution"].get("allow_cloud_subagent_delegation", False)):
        return False
    allowed_profiles = cfg["execution"].get("cloud_subagent_profiles", [])
    if not isinstance(allowed_profiles, list):
        return False
    return task_profile in allowed_profiles


def subagent_candidate_order(cfg: Dict[str, Any], allow_cloud_for_profile: bool, task_profile: str) -> List[str]:
    configured_orders = cfg["execution"].get("subagent_profile_orders", {})

    if isinstance(configured_orders, dict) and isinstance(configured_orders.get(task_profile), list):
        order = [str(item) for item in configured_orders[task_profile]]
    elif isinstance(configured_orders, dict) and isinstance(configured_orders.get("default"), list):
        order = [str(item) for item in configured_orders["default"]]
    else:
        order = ordered_lane_keys(cfg)

    if not allow_cloud_for_profile:
        order = [key for key in order if not is_cloud_lane(cfg, key)]

    return [key for key in order if key in cfg.get("lanes", {})]


def model_matches_requirement(required_model: str, model_names: List[str], configured_model: str) -> bool:
    if not required_model:
        return True

    needle = required_model.strip().lower()
    if not needle:
        return True

    haystack = list(model_names)
    if configured_model:
        haystack.append(configured_model)

    return any(needle in model_name.lower() for model_name in haystack if isinstance(model_name, str))


def choose_primary_lane(cfg: Dict[str, Any], allow_cloud: bool, reason_code: str) -> Tuple[str, Lane]:
    for lane_key in primary_lane_order(cfg):
        lane = lane_from_config(cfg, lane_key)
        if is_cloud_lane(cfg, lane_key):
            if lane.enabled and allow_cloud:
                return lane_key, lane
            continue
        ok, _ = check_lane_health(cfg, lane)
        if ok:
            return lane_key, lane

    raise OrchestratorError(
        "No healthy lane is available. Self-hosted lanes are unhealthy; cloud is blocked by policy. "
        f"reason_code={reason_code}"
    )


def _meta_matches_model(required_model: str, meta: Any) -> bool:
    """model_matches_requirement against a capability-cache lane record."""
    models = meta.get("models") if isinstance(meta.get("models"), list) else []
    return model_matches_requirement(required_model, list(models), str(meta.get("configured_model", "")))


def _lane_usable(cfg: Dict[str, Any], lane: Lane, meta: Any) -> bool:
    """Trust a healthy cache record for an enabled lane; otherwise probe live."""
    if lane.enabled and candidate_healthy_from_cache(meta):
        return True
    ok, _ = check_lane_health(cfg, lane)
    return ok


def _subagent_capability_cache(
    cfg: Dict[str, Any],
    strict_tools: bool,
    cloud_for_profile: bool,
    require_live_inventory: bool,
) -> Dict[str, Any]:
    """Capability data the subagent selection reads, refreshed as policy demands."""
    cache_path = capability_cache_path(cfg)
    use_cache = bool(cfg["execution"].get("use_capability_cache_for_subagents", True))

    if not use_cache:
        if not (strict_tools or require_live_inventory):
            return {}
        return build_inventory_report(
            cfg,
            include_cloud=cloud_for_profile,
            probe_tool_calls=strict_tools,
            previous=load_json(cache_path),
        )

    if require_live_inventory:
        cached = build_inventory_report(
            cfg,
            include_cloud=cloud_for_profile,
            probe_tool_calls=strict_tools,
            previous=load_json(cache_path),
        )
        save_json(cache_path, cached)
    else:
        cached = maybe_refresh_capability_cache(cfg)
    if strict_tools and not cache_has_required_tool_probe_data(cached, self_hosted_lane_keys(cfg)):
        cached = maybe_refresh_capability_cache(cfg, force=True)
    return cached


def _strict_tool_lane(
    cfg: Dict[str, Any],
    lane_map: Dict[str, Lane],
    lanes_meta: Dict[str, Any],
    candidate_order: List[str],
    required_model: str,
) -> Tuple[str, Lane]:
    """Highest-scoring healthy lane that passed the tool-call probe (cloud exempt)."""
    strict_candidates: List[Tuple[int, str]] = []
    for lane_key in candidate_order:
        meta = lanes_meta.get(lane_key)
        if not isinstance(meta, dict) or not bool(meta.get("healthy", False)):
            continue
        if not is_cloud_lane(cfg, lane_key) and meta.get("tool_call_supported") is not True:
            continue
        if not _meta_matches_model(required_model, meta):
            continue
        strict_candidates.append((int(meta.get("subagent_score", 0)), lane_key))

    for _, lane_key in sorted(strict_candidates, reverse=True):
        if _lane_usable(cfg, lane_map[lane_key], lanes_meta.get(lane_key)):
            return lane_key, lane_map[lane_key]

    raise OrchestratorError(
        "Strict subagent tool-call mode is enabled but no healthy lane passed tool-call probe. "
        "Run 'inventory --probe-tool-calls' and verify model tool support."
    )


def _recommended_lane_key(
    cfg: Dict[str, Any],
    cached: Dict[str, Any],
    lane_map: Dict[str, Lane],
    lanes_meta: Dict[str, Any],
    cloud_for_profile: bool,
    required_model: str,
) -> str:
    """The cache's recommended_subagent lane if policy and model allow it, else ""."""
    recommendation = cached.get("recommended_subagent")
    if not isinstance(recommendation, dict):
        return ""
    lane_key = recommendation.get("lane")
    if not isinstance(lane_key, str) or lane_key not in lane_map:
        return ""
    if is_cloud_lane(cfg, lane_key) and not cloud_for_profile:
        return ""
    meta = lanes_meta.get(lane_key)
    if isinstance(meta, dict) and not _meta_matches_model(required_model, meta):
        return ""
    return lane_key


def resolve_subagent_lane(
    cfg: Dict[str, Any],
    allow_cloud: bool,
    task_profile: str,
    required_model: str,
) -> Tuple[str, Lane]:
    lane_map = {key: lane_from_config(cfg, key) for key in ordered_lane_keys(cfg)}
    # Strict mode is profile-independent. It used to also require
    # task_profile == "default", which no shipped preset uses, so the whole strict
    # branch was dead in production while the docs promised it was on (HERMES-8).
    strict_tools = bool(cfg["execution"].get("require_tool_call_for_subagents", False))
    cloud_for_profile = cloud_allowed_for_subagents(cfg, allow_cloud=allow_cloud, task_profile=task_profile)
    require_live_inventory = bool(required_model.strip()) or task_profile != "default"

    cached = _subagent_capability_cache(cfg, strict_tools, cloud_for_profile, require_live_inventory)
    if not isinstance(cached, dict):
        cached = {}
    lanes_meta = cached.get("lanes", {})
    if not isinstance(lanes_meta, dict):
        lanes_meta = {}
    candidate_order = subagent_candidate_order(cfg, allow_cloud_for_profile=cloud_for_profile, task_profile=task_profile)

    if strict_tools:
        return _strict_tool_lane(cfg, lane_map, lanes_meta, candidate_order, required_model)

    if bool(cfg["execution"].get("use_capability_cache_for_subagents", True)):
        recommended = _recommended_lane_key(cfg, cached, lane_map, lanes_meta, cloud_for_profile, required_model)
        if recommended and _lane_usable(cfg, lane_map[recommended], lanes_meta.get(recommended)):
            return recommended, lane_map[recommended]

    for lane_key in candidate_order:
        meta = lanes_meta.get(lane_key)
        if isinstance(meta, dict) and not _meta_matches_model(required_model, meta):
            continue
        if _lane_usable(cfg, lane_map[lane_key], meta):
            return lane_key, lane_map[lane_key]

    raise OrchestratorError("No healthy lane for subagent execution")
