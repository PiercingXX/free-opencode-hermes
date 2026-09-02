# Free OpenCode

## What it is

A local add-on for [OpenCode](https://opencode.ai). You run OpenCode as usual.
This project sits in front of it as a proxy on your machine, so one OpenCode
session can use cloud APIs you have keys for, or models on boxes you own.

You pick providers in a local Admin page. Keys stay in
`~/.free-opencode/config.json`, not in OpenCode's config. OpenCode's picker
shows one entry (**Free OpenCode**); the proxy sends the request to whichever
model you set as default, then to fallbacks if that one is busy or down.

Optional: Hermes Agent can use the same catalog, or a separate GPU/Ollama
path for machines in `inventory.json`.

Independent project by [PiercingXX](https://github.com/PiercingXX). Not
affiliated with OpenCode or Nous Research. MIT licensed — see [LICENSE](LICENSE).

You need **Node.js 20+** and **npm**. Linux, macOS, and Windows.

## Install

```bash
git clone https://github.com/PiercingXX/free-opencode-hermes
cd free-opencode-hermes
```

Linux / macOS:

```bash
./install-opencode.sh
```

Windows PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-opencode.ps1
```

Already have the OpenCode CLI? `./install-opencode.sh --skip-opencode`
(PowerShell: `.\install-opencode.ps1 -SkipOpenCode`).

Then:

1. Open a **new** terminal so `opencode` and `free-opencode` are on your PATH
   (`~/.local/bin`, plus `~\.opencode\bin` on Windows).
2. Open [http://127.0.0.1:8082/admin](http://127.0.0.1:8082/admin). Paste a
   provider key, **Check**, **Apply**. Click **Use** on a model you want as
   the default.
3. Start OpenCode:
   ```bash
   opencode
   ```

If Admin is down: `free-opencode start`, then reload the page.

Local Ollama (or similar) is optional. In Admin, use **Autofind** at the
bottom, or `free-opencode autofind`.

### Hermes (optional)

Same catalog as OpenCode:

```bash
foc-hermes
```

Your own GPUs / Ollama boxes (separate installer):

```bash
./install-hermes.sh          # Linux / macOS
.\install-hermes.ps1         # Windows
xx-hermes
```

### If it does not start

- Command not found → new terminal; confirm `~/.local/bin` is on PATH.
- OpenCode stuck on a built-in Zen model → `foc-opencode` for that session.
- Empty tool calls looping → quit, `free-opencode stop`, `free-opencode start`,
  then a **new** `opencode` session.

More detail: [MANUAL.md](MANUAL.md) (how the stack works),
[CONTRIBUTING.md](CONTRIBUTING.md) (dev), [xx-stack/README.md](xx-stack/README.md)
(core), [hermes-orchestration/README.md](hermes-orchestration/README.md) (GPU plane).
