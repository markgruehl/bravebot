#!/usr/bin/env bash
# PreToolUse hook: block `git commit` / `git push` that would land on main.
# All work happens on a feature branch in a worktree and reaches main via PR.
set -euo pipefail

command -v jq >/dev/null || exit 0

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")

# Only inspect git commit/push invocations.
grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(commit|push)([[:space:]]|$)' <<<"$cmd" || exit 0

# Explicit pushes to main, from any branch (only look within the push command itself).
push_segments=$(grep -Eo 'git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push([[:space:]][^;&|]*)?' <<<"$cmd" || true)
if grep -Eq '([[:space:]:+])(main|refs/heads/main)([[:space:]]|$)' <<<"$push_segments"; then
  echo "Blocked: never push to main directly. Push your feature branch and open a PR (gh pr create --base main)." >&2
  exit 2
fi

# Resolve the directory git will run in: `git -C <dir>` > leading `cd <dir> &&` > hook cwd.
dir=$(grep -Eo 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+' <<<"$cmd" | head -1 | awk '{print $3}' || true)
[[ -z "$dir" ]] && dir=$(grep -Eo '^[[:space:]]*cd[[:space:]]+[^[:space:];&]+' <<<"$cmd" | awk '{print $2}' || true)
dir=${dir:-$cwd}
dir=${dir/#\~/$HOME}
[[ "$dir" != /* && -n "$cwd" ]] && dir="$cwd/$dir"

branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
if [[ "$branch" == "main" ]]; then
  echo "Blocked: '$dir' is on main. Create a worktree on a feature branch first:" >&2
  echo "  git worktree add -b <type>/<name> .claude/worktrees/<name> origin/main" >&2
  exit 2
fi

exit 0
