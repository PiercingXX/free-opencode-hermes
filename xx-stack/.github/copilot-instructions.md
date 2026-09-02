# xx-stack Copilot Instructions

This repository contains xx-stack, a production-oriented agent stack for AI-assisted software development.

## Repository Structure

- **Stack Core** (`runtime/`, `mcp-server/`, `scripts/`): Reusable agent contracts, skills, routing policy, and MCP infrastructure
- **Content Packs** (`packs/design/`): Domain-specific content consumed by agents and skills

The VS Code adapter surface (`adapters/`, `vscode/`, `setup-vscode.sh`,
`sync-vscode-agents.mjs`) was removed in xx-stack 1.65. OpenCode is the
install layer, in the parent `free-opencode` repo under
`opencode-orchestration/`.

## Key Files

- `runtime/config.json`: Agent registry defaults
- `runtime/shared_instructions.md`: Shared runtime behavior and delegation rules
- `runtime/SKILLS.md`: Canonical skill inventory
- `runtime/FILE-STRUCTURE.md`: Navigation map
- `REPO-LAYERS.md`: Stack-core vs content-pack boundary

## Primary Agents

- `execution-orchestrator`: Accountable orchestration and completion gates
- `build`: Implementation agent
- `fast-build`: Narrow speed lane for small changes
- `plan`: Planning-only lane
- `deep-thinker`: Architecture, risk, and deep reasoning
- `release-manager`: Release and deployment gating
- `incident-commander`: Incident handling
- `design-engineer`: Design workflow specialist

## Setup Commands

```bash
# Verify repo layout
node scripts/verify-repo-layout.mjs

# From the git root (free-opencode):
npm run verify          # full gate
npm run drift:check     # OpenCode mirrors vs runtime
npm run design:catalog  # regenerate the design system catalog
```

## Git Hooks

Pre-commit at the git root runs `npm run drift:check`. Activate with:

```bash
git config core.hooksPath .githooks
```

## Requirements

- Node.js 20+
- MCP-compatible host
- At least one reachable model provider

## Notes

- Canonical agent contracts live in `runtime/agents/*.md`
- Do not overlay `build.md` / `plan.md` / `general.md` onto OpenCode's native agents
- The repo is host-agnostic
- Generated files should stay out of git
