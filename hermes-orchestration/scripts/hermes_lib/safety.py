"""Executable-plan parsing and allowlisted command execution."""

from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from .lanes import OrchestratorError


def parse_executable_plan(raw: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise OrchestratorError(
            "Model output is not JSON. Use a stricter system prompt or disable --require-executable-plan."
        ) from exc

    if "final_answer" not in parsed:
        raise OrchestratorError("Executable plan JSON must contain 'final_answer'")
    actions = parsed.get("actions", [])
    if not isinstance(actions, list):
        raise OrchestratorError("'actions' must be a list")
    return parsed


# "+" is here because it is the terminator of `find -exec cmd {} +`. The cost is
# that no argument may contain a literal "+" (regexes, "g++"); that is deliberate.
UNSAFE_TOKEN_CHARS = ";|&<>`$\n\r+"

# Arguments that turn an otherwise read-only command into an execution or
# escape primitive. Matched exactly, against the option half of "--opt=value",
# and — for single-dash tokens — against every character of the token, so a
# glued value (`-pevilmod`, `-o/tmp/x`) or a cluster (`-xpevil`) cannot hide a
# denied short flag (see `_denied_short_flag`).
#
#   find:   -exec/-execdir/-ok/-okdir spawn processes, -delete/-fprint* write,
#           -o/-or lets a denied branch be reached past an earlier filter
#   rg:     --pre/--pre-glob run a preprocessor binary, -z/--search-zip shells
#           out to decompressors, --hostname-bin runs a binary
#   git:    -c/--config-env inject config (diff.external, core.pager),
#           --ext-diff runs the configured external differ, --exec-path,
#           --upload-pack/--receive-pack name programs to run
#   node/npm: --node-options/--require load arbitrary modules, --prefix escapes
#           the workspace
#   python/pytest: -c executes a literal program, -p/--plugins imports a module
#
# Collateral: `ls -o`, `ls -p`, `ls -r`, `git diff -z` are rejected too, as is any
# single-dash token containing one of those letters (`ls -ltr`, `git log -Sfoo`,
# find-style `-maxdepth`). Accepted — the point of this list is that a denied
# token is never reasoned about again, and a cluster's letters cannot be told
# apart from a glued value without knowing each program's option grammar.
DENIED_ARGUMENTS = frozenset(
    {
        "-exec", "-execdir", "-ok", "-okdir",
        "-delete", "-fprint", "-fprint0", "-fprintf", "-fls",
        "-o", "-or", "--output",
        "--pre", "--pre-glob", "--hostname-bin", "-z", "--search-zip",
        "-c", "--config-env", "--exec-path", "--ext-diff",
        "--upload-pack", "--receive-pack",
        "--prefix", "--node-options", "--require", "-r",
        "-p", "--plugins",
    }
)

# Single-letter denied flags ("-c" -> "c"), used to scan short-option clusters.
_DENIED_SHORT_LETTERS = frozenset(
    arg[1] for arg in DENIED_ARGUMENTS if len(arg) == 2 and arg[0] == "-" and arg[1] != "-"
)

# Allowlist prefixes that run code the *repository* controls (conftest.py,
# package.json scripts, Makefiles). Argument screening is meaningless for these:
# the checkout decides what runs. They are refused even when listed in
# `execution.allowed_command_prefixes` unless the operator also sets
# `execution.allow_repo_code_execution: true`.
REPO_CODE_EXECUTION_PREFIXES = (
    ("python3", "-m", "pytest"),
    ("python", "-m", "pytest"),
    ("pytest",),
    ("npm", "test"),
    ("npm", "run"),
    ("npm", "run-script"),
    ("npx",),
    ("yarn",),
    ("pnpm",),
    ("make",),
)


# Residual limits of the allowlist — stated so nobody mistakes it for a sandbox:
#
#  * Test runners (`npm test`, `python3 -m pytest`, see
#    REPO_CODE_EXECUTION_PREFIXES) execute code the repository controls. They are
#    not shipped and stay refused unless `execution.allow_repo_code_execution`
#    is true — enabling that trusts the checkout, not the model.
#  * `cat`/`ls` can read any file *inside* the workspace, including a stray .env.
#    Containment is a workspace boundary, not a secrets boundary.
#  * The denylist enumerates known-bad flags. A future flag of an allowlisted
#    command that spawns a process is not covered until it is added here — which
#    is why `find` and `rg`, whose escape hatches are numerous and version-
#    dependent, were dropped from the shipped default list entirely.
#  * The real boundary remains the double gate: `execution.allow_shell_execution`
#    (shipped false) AND `--execute-approved`. Both must be on before any of this
#    code path runs at all.
def parse_command_argv(command: str) -> Optional[List[str]]:
    """Parse a command string into argv, rejecting shell metacharacters.

    Commands run without a shell, so metacharacters can never expand — but any
    token containing one is rejected outright to fail closed on injection
    attempts like "git status; rm -rf ~".
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens:
        return None
    for token in tokens:
        if any(ch in token for ch in UNSAFE_TOKEN_CHARS):
            return None
    return tokens


def _argument_escapes_workspace(token: str, workspace: Path) -> bool:
    """True if a non-flag argument can address a file outside the workspace.

    Resolution-based, not string-based, so "a..b" and "HEAD~5" are fine while
    "..", "/etc/passwd" and a symlink pointing outside are not.
    """
    if not token:
        return False
    if token.startswith("~"):
        # shlex does not expand "~", but several commands do it themselves.
        return True
    try:
        candidate = Path(token)
        resolved = (candidate if candidate.is_absolute() else workspace / candidate).resolve()
        resolved.relative_to(workspace.resolve())
    except (ValueError, OSError):
        return True
    return False


def _denied_short_flag(token: str) -> Optional[str]:
    """Return the denied short flag hidden in a single-dash token, if any.

    `-pevilmod` is `-p evilmod` to pytest/argparse and `-xpevil` is `-x -p evil`,
    so exact matching is not enough: every letter of the leading cluster is
    checked. The scan stops at the first non-letter (`/`, `.`, `~`, `=`, digit),
    where a glued path value begins; that value is path-checked separately.
    """
    if not token.startswith("-") or token.startswith("--") or len(token) < 2:
        return None
    for letter in token[1:]:
        if not letter.isalpha():
            break
        if letter in _DENIED_SHORT_LETTERS:
            return f"-{letter}"
    return None


def _token_escapes_workspace(token: str, workspace: Path) -> bool:
    """Path check for one argv token, including values glued to options."""
    if token.startswith("--"):
        _, _, value = token.partition("=")
        return bool(value) and not value.startswith("-") and _argument_escapes_workspace(value, workspace)
    if token.startswith("-"):
        # A short option may carry a glued value at any offset (`-O/etc/x`,
        # `-lO/etc/x`, `-o=../x`); check every suffix after the first letter.
        body = token[2:]
        return any(
            _argument_escapes_workspace(body[i:].lstrip("="), workspace)
            for i in range(len(body))
            if body[i:].lstrip("=")
        )
    return _argument_escapes_workspace(token, workspace)


def _matches_prefix(argv: List[str], prefix_argv: Any) -> bool:
    return bool(prefix_argv) and tuple(argv[: len(prefix_argv)]) == tuple(prefix_argv)


def command_rejection_reason(
    command: str,
    allowed_prefixes: List[str],
    workspace: Optional[Path] = None,
    allow_repo_code_execution: bool = False,
) -> Optional[str]:
    """Return why a command is rejected, or None if it is permitted.

    Four layers, all of which must pass:

    1. argv parse with no shell metacharacter in any token (`parse_command_argv`)
    2. whole-token prefix match against the configured allowlist
    3. repo-code runners (REPO_CODE_EXECUTION_PREFIXES) only when
       `allow_repo_code_execution` is set
    4. per-argument screening of *every* remaining argument: no token from
       DENIED_ARGUMENTS (including short flags glued or clustered), and no path
       argument — standalone or glued to an option — that leaves the workspace

    Layer 4 is the HERMES-1 fix. Previously a prefix match permitted every
    remaining argument unchecked, so an allowlisted `find` or `rg` was a general
    execution primitive and an allowlisted `cat` read any file on the host.
    """
    workspace = Path.cwd() if workspace is None else Path(workspace)
    argv = parse_command_argv(command)
    if argv is None:
        return "unparseable_or_unsafe"

    matched = False
    for prefix in allowed_prefixes:
        try:
            prefix_argv = shlex.split(prefix)
        except ValueError:
            continue
        if _matches_prefix(argv, prefix_argv):
            matched = True
            break
    if not matched:
        return "not_allowlisted"

    if not allow_repo_code_execution:
        for runner in REPO_CODE_EXECUTION_PREFIXES:
            if _matches_prefix(argv, runner):
                return f"repo_code_execution_disabled:{' '.join(runner)}"

    for token in argv[1:]:
        option, _, value = token.partition("=")
        if token in DENIED_ARGUMENTS or (value and option in DENIED_ARGUMENTS):
            return f"denied_argument:{token}"
        if _denied_short_flag(token):
            return f"denied_argument:{token}"
        if _token_escapes_workspace(token, workspace):
            return f"argument_outside_workspace:{token}"
    return None


def command_allowed(
    command: str,
    allowed_prefixes: List[str],
    workspace: Optional[Path] = None,
    allow_repo_code_execution: bool = False,
) -> bool:
    return (
        command_rejection_reason(command, allowed_prefixes, workspace, allow_repo_code_execution) is None
    )


def run_actions(
    actions: List[str],
    allowed_prefixes: List[str],
    workspace: Optional[Path] = None,
    allow_repo_code_execution: bool = False,
) -> List[Dict[str, Any]]:
    workspace = Path.cwd() if workspace is None else Path(workspace)
    results = []
    for command in actions:
        if not isinstance(command, str):
            results.append({"command": str(command), "status": "rejected", "reason": "not_string"})
            continue
        reason = command_rejection_reason(command, allowed_prefixes, workspace, allow_repo_code_execution)
        if reason is not None:
            entry = {"command": command, "status": "rejected", "reason": reason}
            if reason.startswith("repo_code_execution_disabled"):
                entry["hint"] = (
                    "This command runs repository-controlled code. Set "
                    "execution.allow_repo_code_execution to true to permit it."
                )
            results.append(entry)
            continue
        # Non-None: command_rejection_reason already parsed it successfully.
        argv = parse_command_argv(command) or []
        try:
            completed = subprocess.run(
                argv,
                shell=False,
                text=True,
                capture_output=True,
                timeout=120,
                cwd=str(workspace),
            )
        except subprocess.TimeoutExpired:
            results.append({"command": command, "status": "error", "reason": "timeout"})
            continue
        except FileNotFoundError:
            results.append({"command": command, "status": "error", "reason": "command_not_found"})
            continue
        results.append(
            {
                "command": command,
                "status": "ok" if completed.returncode == 0 else "error",
                "exit_code": completed.returncode,
                "stdout": completed.stdout[-4000:],
                "stderr": completed.stderr[-4000:],
            }
        )
    return results
