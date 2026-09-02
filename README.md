# Free OpenCode

A local proxy for [OpenCode](https://opencode.ai). One session can use any provider you have a key for — OpenRouter, Groq, NVIDIA, Ollama, and others — or models on machines you own.

Keys live in `~/.free-opencode/config.json`, not in OpenCode. The model picker shows a single **Free OpenCode** entry; the proxy sends work to the default model, then to fallbacks if that one is busy or down.

Requires Node.js 20+. Independent project, MIT licensed.

## How to

### Linux / macOS

```bash
git clone https://github.com/PiercingXX/free-opencode-hermes
cd free-opencode-hermes
./install-opencode.sh
```

Open a new terminal. Wrappers go in `~/.local/bin`; add that directory to `PATH` if `free-opencode` is not found.

### Windows

Install [Node.js 20+](https://nodejs.org) first. In PowerShell:

```powershell
git clone https://github.com/PiercingXX/free-opencode-hermes
cd free-opencode-hermes
Set-ExecutionPolicy -Scope Process Bypass
.\install-opencode.ps1
```

Open a new terminal so the user PATH update applies (`%USERPROFILE%\.local\bin` and `%USERPROFILE%\.opencode\bin`).

### Configure and run

1. Open [http://127.0.0.1:8082/admin](http://127.0.0.1:8082/admin). Add a provider key and set a default model.
2. Run `opencode`.

If Admin is not listening: `free-opencode start`.

Hermes, skip-flags, launchers, and internals: [MANUAL.md](MANUAL.md).
