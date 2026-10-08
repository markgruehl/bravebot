#!/usr/bin/env bash
# Fails if any package in package-lock.json would be fetched from somewhere other than the
# npm registry, or lacks an integrity hash. Guards against lockfile edits that point a package
# at an attacker's tarball (reviewers rarely read package-lock.json diffs). Skips links,
# workspace sources (in the repo) and bundled deps (covered by their parent's integrity).
set -euo pipefail
lockfile="${1:-package-lock.json}"
bad=$(jq -r '
  .packages | to_entries[]
  | select(.key | startswith("node_modules/"))
  | select((.value.link | not) and (.value.inBundle | not))
  | select((.value.resolved // "" | startswith("https://registry.npmjs.org/") | not)
           or (.value.integrity // "" | startswith("sha512-") | not))
  | "\(.key)\t\(.value.resolved // "<no resolved>")\t\(.value.integrity // "<no integrity>")"
' "$lockfile")
if [ -n "$bad" ]; then
  echo "Lockfile entries not from https://registry.npmjs.org/ with a sha512 integrity hash:" >&2
  echo "$bad" >&2
  exit 1
fi
echo "All $(jq '[.packages | to_entries[] | select((.key | startswith("node_modules/")) and (.value.link | not) and (.value.inBundle | not))] | length' "$lockfile") lockfile packages come from registry.npmjs.org with sha512 integrity."
