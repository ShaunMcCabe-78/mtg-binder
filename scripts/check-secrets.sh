#!/usr/bin/env bash
# Stops sensitive data from being published. Checks for:
#   1. API keys, tokens, passwords and private keys
#   2. Personal email addresses, in files and in commit details (only GitHub/Anthropic noreply addresses are allowed)
#   3. Photos (they can carry the GPS location where they were taken); only the app icons are allowed
# Usage: scripts/check-secrets.sh --staged   (before a commit: the files about to be committed)
#        scripts/check-secrets.sh --all      (the current files and every commit's author/committer)
set -u
MODE="${1:---all}"
fail=0
report() { echo "✗ $1"; fail=1; }

if [ "$MODE" = "--staged" ]; then GREP=(git grep --cached -I -n -E); FILES=$(git diff --cached --name-only --diff-filter=ACMR)
else GREP=(git grep -I -n -E); FILES=$(git ls-files); fi

# 1. Keys, tokens, passwords, private keys
KEYS='sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
# "password = '...'"-style lines; not in the card data files, where card names like "... Secret" are normal.
ASSIGN='(api[_-]?key|secret|passw(or)?d|token)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"'[:space:]]{12,}["'"'"']'
hits=$( { "${GREP[@]}" "$KEYS" -- . ':!scripts/check-secrets.sh'; "${GREP[@]}" -i "$ASSIGN" -- . ':!scripts/check-secrets.sh' ':!cards.json' ':!prints.json'; } 2>/dev/null | cut -c1-160)
[ -n "$hits" ] && report "Possible key or password:"$'\n'"$hits"

# 2. Email addresses in files
ALLOWED_EMAIL='noreply@anthropic\.com|[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com'
hits=$("${GREP[@]}" -o '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- . ':!scripts/check-secrets.sh' ':!cards.json' ':!prints.json' 2>/dev/null | grep -Ev "($ALLOWED_EMAIL)\$" | grep -Ev '@[0-9]+\.[0-9]+' )
[ -n "$hits" ] && report "Email address in a file:"$'\n'"$hits"

# ... and in commit details
if [ "$MODE" = "--staged" ]; then
  for e in "$(git config user.email)"; do echo "$e" | grep -Eq "^($ALLOWED_EMAIL)\$" || report "This commit would publish the email address $e. Use your GitHub noreply address: git config user.email <id>+<user>@users.noreply.github.com"; done
else
  bad=$(git log --all --format='%ae%n%ce' | sort -u | grep -Ev "^($ALLOWED_EMAIL)\$")
  [ -n "$bad" ] && report "Commit history contains the email address(es): $bad"
fi

# 3. Photos (may contain GPS location)
photos=$(echo "$FILES" | grep -Ei '\.(jpe?g|heic|heif|png|webp|tiff?|dng)$' | grep -Ev '^(icon-[0-9]+\.png|apple-touch-icon\.png)$')
[ -n "$photos" ] && report "Photo file(s) — these can contain the location where they were taken:"$'\n'"$photos"

if [ $fail -ne 0 ]; then echo; echo "Blocked: remove the items above (and if a real key was involved, revoke it)."; exit 1; fi
echo "✓ No keys, personal email addresses or photos found."
