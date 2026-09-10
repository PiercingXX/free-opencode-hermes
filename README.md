# Free OpenCode

A local proxy for [OpenCode](https://opencode.ai). One session can use any
provider you have a key for — OpenRouter, Groq, NVIDIA, Ollama, and others —
or models on machines you own.

Keys live in `~/.free-opencode/config.json`, not in OpenCode. The OpenCode
model picker shows a single **Free OpenCode** entry. Cloud keys are on Admin,
not in that picker. The proxy tries free cloud first, then paid cloud, then
self-hosted boxes; a 429 puts that model in cooldown until it should be back.
`free-opencode status` shows the last route and cooldowns.

Requires Node.js 20+. Independent project, MIT licensed.

## How to

### Linux / macOS

```bash
git clone https://github.com/PiercingXX/free-opencode-hermes
cd free-opencode-hermes
./install-opencode.sh
```

Open a new terminal. Wrappers go in `~/.local/bin`; add that directory to
`PATH` if `free-opencode` is not found. In bash or zsh, do not run the
PowerShell commands below.

### Windows

Install [Node.js 20+](https://nodejs.org) first. In **PowerShell** (not Git
Bash or bash):

```powershell
git clone https://github.com/PiercingXX/free-opencode-hermes
cd free-opencode-hermes
Set-ExecutionPolicy -Scope Process Bypass
.\install-opencode.ps1
```

Open a new terminal so the user PATH update applies
(`%USERPROFILE%\.local\bin` and `%USERPROFILE%\.opencode\bin`).

### Configure and run

1. Open [http://127.0.0.1:8082/admin](http://127.0.0.1:8082/admin). Filter
   by name or id. Paste a key on the card and click **Connect**. Set a
   default model, then **Apply**.
2. Run `opencode` in a terminal, or from the OpenCode IDE extension
   (`Ctrl+Esc` / `Cmd+Esc`). `opencode serve` loads the same plugin.

If Admin is not listening: `free-opencode start`. Native `build` / `plan` /
`general` have no step cap so a session can keep using tools until the model
stops; write progress on disk if you need to survive a reboot.

A second key for the same provider: account name on the card (e.g. `work`)
then **Add account**, or `free-opencode connect open_router@work`.

Already cloned: `git pull` and re-run the installer for your OS so the proxy
restarts with the current catalog (or run `free-opencode update`).

Admin sorts configured providers first and collapses unused cards; it shows
the last route and active cooldowns under **Routing**. Keep `:8082` alive
across logins with `free-opencode service install`, and tail what routed
where with `free-opencode log --lines 50`.

Hermes, skip-flags, launchers, and internals: [MANUAL.md](MANUAL.md).
