#!/usr/bin/env bash
prs=$(gh pr list --repo joeblackwaslike/ctx-tree --state open --json number,title,reviews 2>/dev/null) || exit 0
count=$(echo "$prs" | jq 'length' 2>/dev/null) || exit 0
if [ "${count:-0}" -gt 0 ]; then
  printf '\n\033[33m⚠️  Open PRs with review feedback:\033[0m\n'
  echo "$prs" | jq -r '.[] | "  PR #\(.number): \(.title) (\(.reviews | length) review(s))"'
  printf '  Run: gh pr view <number> to see feedback\n\n'
fi
