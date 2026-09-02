# xx-stack Copilot Instructions

This repository is local-first orchestration for AI coding agents: a routing MCP
server, agent contracts and skills, and a self-hosted inference control plane.

## Repository Structure

Three components at the top level:

- **`xx-stack/`** — the core and the source of truth. Agent contracts
  (`runtime/agents/`), skills (`runtime/skills/`), the routing MCP server
  (`mcp-server/`), shared tooling (`scripts/`), and the design content pack
  (`packs/design/`). Host-agnostic.
- **`opencode-orchestration/`** — the OpenCode install layer. Its
  `mcp-server/`, `scripts/`, and `packs/` are **symlinks into `../xx-stack/`**,
  not copies. Edit at the real path. Agent and skill bodies under
  `opencode/agents` and `opencode/skills` are copies, gated by `drift:check`.
- **`hermes-orchestration/`** — standalone Python control plane for routing
  inference across self-hosted lanes over Tailscale. No dependency on the
  TypeScript stack.

The VS Code / Copilot adapter surface (`adapters/`, `vscode/`, `agents:sync`)
was removed in xx-stack 1.65.

## Key Files

- `xx-stack/runtime/config.json` — agent registry defaults
- `xx-stack/runtime/platforms.json` — example platform registry (hosts, tiers)
- `xx-stack/runtime/shared_instructions.md` — shared runtime behavior
- `xx-stack/runtime/SKILLS.md` — canonical skill inventory
- `xx-stack/REPO-LAYERS.md` — stack-core vs content-pack boundary
- `hermes-orchestration/config/orchestration.json` — lane and escalation policy

## Routing Policy — do not weaken

Local first, self-hosted over Tailscale second, cloud **only** when explicitly
opted in via `selectionPolicy.cloudEscalation.optIn` or `XX_STACK_ALLOW_CLOUD=1`.
The gate lives in `xx-stack/mcp-server/src/routing_selection_runtime.ts`
(`cloudRoutingAllowed`) and is fail-safe by design: absent config means cloud is
off. Never add a cloud code path that bypasses it.

## Commands

```bash
npm run verify          # full gate: layout, drift, lint, design, all tests
npm test                # workspaces: MCP server + plugin
npm run plugin:test     # Free OpenCode plugin
npm run hermes:test     # Hermes control plane
npm run layout:verify   # component layout and compatibility symlinks
npm run drift:check     # OpenCode agent/skill mirrors vs xx-stack/runtime
npm run lint            # ESLint over TypeScript sources
npm run design:catalog  # regenerate the design system catalog
```

The MCP suite isolates `$HOME` to a temp directory. GitHub Actions is
workflow_dispatch-only; `verify` is the local gate.

## Conventions

- Canonical agent contracts live in `xx-stack/runtime/agents/`; mirror copies
  live in `opencode-orchestration/opencode/agents/` — edit runtime, then the
  mirror, then `npm run drift:check`
- Do not copy `build.md` / `plan.md` / `general.md` into
  `~/.config/opencode/agents/` — those names replace OpenCode's native tools
- Prettier is not applied to `xx-stack/packs/` (vendored upstream content)
- Keep hostnames, IPs, and absolute paths out of committed files; use
  placeholders and document the substitution
- Generated files stay out of git
- Respect `.xxignore` for repo-local context exclusions

## Requirements

- Node.js 20+
- Python 3.11+ (hermes only)
- An MCP-compatible host and at least one reachable model provider
