#!/usr/bin/env bash

set -eu

# Example pre-tool policy hook.
#
# Expected input: a JSON payload on stdin from a host runtime that supports
# pre-tool hooks. This script is intentionally conservative and acts as a
# reusable starter, not an enforced repo policy.
#
# WARNING: this is a seatbelt, not a sandbox. Pattern matching over a JSON
# payload is bypassable (shell indirection, variables, encodings, matches
# inside Write-tool file bodies); execution_policy.ts in mcp-server/src/ plus
# runtime/dangerous-patterns.txt is the enforced gate. What this catches is the
# common catastrophic slip, in its usual spellings:
#   - force pushes: git push -f / --force / --force-with-lease /
#     --force-if-includes / combined short flags (-uf) / +refspec
#   - recursive rm (-r, -R, --recursive, or any combined flag such as -rf,
#     -fr, -Rf, -r -f) aimed at /, /*, ~, ~/, $HOME or ${HOME}

payload="$(cat)"

block() {
  echo "Blocked by repo-local pre-tool policy example: $1" >&2
  exit 2
}

# Split on shell command separators so a flag in one command cannot pair with
# a target in the next. JSON-escaped quotes (\") are treated as word breaks.
segments="$(printf '%s' "$payload" | sed -e 's/\\"/ /g' | tr ';&|\n' '\n\n\n\n')"

ws='[[:space:]"'"'"']'

while IFS= read -r segment; do
  case "$segment" in
    *git*push*)
      if printf '%s\n' "$segment" | grep -Eq "git${ws}+push(${ws}|$)" &&
        printf '%s\n' "$segment" | grep -Eq \
          "${ws}(-[[:alnum:]]*f[[:alnum:]]*|--force(-with-lease|-if-includes)?(=[^[:space:]]*)?|\+[^[:space:]]+)(${ws}|$)"; then
        block "force push"
      fi
      ;;
  esac
  case "$segment" in
    *rm*)
      if printf '%s\n' "$segment" | grep -Eq "(^|${ws}|/)rm${ws}" &&
        printf '%s\n' "$segment" | grep -Eq "${ws}(-[[:alnum:]]*[rR][[:alnum:]]*|--recursive)(${ws}|$)" &&
        printf '%s\n' "$segment" | grep -Eq "${ws}(/\*?|~/?|\\\$HOME/?|\\\$\{HOME\}/?)(${ws}|$)"; then
        block "recursive rm of / or home"
      fi
      ;;
  esac
done <<EOF
$segments
EOF

exit 0
