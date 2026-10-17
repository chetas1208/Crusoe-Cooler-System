#!/usr/bin/env bash
# Store a long-lived Vercel access token on this server so deploy access never lapses.
# Create one at https://vercel.com/account/tokens (scope: your team, expiration: none), then:
#   scripts/save-vercel-token.sh            # paste the token when prompted (input hidden)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
read -rsp "Vercel token: " TOK; echo
[ -n "$TOK" ] || { echo "empty token" >&2; exit 1; }
umask 077
mkdir -p "$HOME/.config/loopkeeper"
printf 'VERCEL_TOKEN=%s\n' "$TOK" > "$HOME/.config/loopkeeper/vercel.env"
sed -i '/^VERCEL_TOKEN=/d' "$ROOT/.env"; printf 'VERCEL_TOKEN=%s\n' "$TOK" >> "$ROOT/.env"
chmod 600 "$ROOT/.env" "$HOME/.config/loopkeeper/vercel.env"
# available in every SSH session (idempotent)
grep -q 'loopkeeper/vercel.env' "$HOME/.bashrc" 2>/dev/null || \
  printf '\n# loopkeeper: long-lived Vercel token\n[ -f "$HOME/.config/loopkeeper/vercel.env" ] && set -a && . "$HOME/.config/loopkeeper/vercel.env" && set +a\n' >> "$HOME/.bashrc"
VERCEL_TOKEN="$TOK" npx --yes vercel whoami && echo "token saved and verified"
