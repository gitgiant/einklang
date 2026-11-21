#!/usr/bin/env bash
# Files tickets as GitHub issues in order (numbering matches on a fresh repo). Usage: tickets/file-issues.sh owner/repo
set -euo pipefail; R=$1
for f in "$(dirname "$0")"/[0-9][0-9].md; do
  t=$(head -1 "$f" | sed 's/^# //'); gh issue create -R "$R" -t "$t" -F <(tail -n +3 "$f")
done
