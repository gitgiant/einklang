#!/usr/bin/env bash
# Files tickets as GitHub issues in order (numbers match on a fresh repo). Usage: tickets/file-issues.sh owner/repo
set -euo pipefail; R=$1
for f in "$(dirname "$0")"/[0-9][0-9].md; do
  t=$(head -1 "$f" | sed 's/^# //')
  gh api "repos/$R/issues" -f title="$t" -f body="$(tail -n +3 "$f")" -q '"#\(.number) \(.title)"'
done
