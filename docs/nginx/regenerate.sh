#!/usr/bin/env bash
#
# regenerate.sh — Verify nginx documentation freshness
#
# This script:
# 1. Checks that _freshness.json matches the current staging commit
# 2. Verifies all source files listed in _freshness.json exist
# 3. Validates Mermaid syntax in all docs (basic check)
# 4. Updates _freshness.json if run with --update flag
#
# Usage:
#   bash docs/nginx/regenerate.sh           # Check freshness
#   bash docs/nginx/regenerate.sh --update  # Update freshness manifest
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FRESHNESS_FILE="$SCRIPT_DIR/_freshness.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }

errors=0

# ─── Check git repo ──────────────────────────────────────────────────────────
if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "Not inside a git repository"
    exit 1
fi

CURRENT_COMMIT=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
CURRENT_BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
echo "Current commit: $CURRENT_COMMIT ($CURRENT_BRANCH)"

# ─── Check _freshness.json exists ────────────────────────────────────────────
if [[ ! -f "$FRESHNESS_FILE" ]]; then
    fail "_freshness.json not found at $FRESHNESS_FILE"
    exit 1
fi

# Parse freshness manifest
# Pick a working interpreter. The Microsoft Store python3/python stub lives on
# PATH on Windows and looks like a real command, but never actually runs; probe
# each candidate and keep the first one that can execute Python.
PYTHON=""
for cand in python python3 py; do
    if command -v "$cand" >/dev/null 2>&1; then
        if "$cand" -c "raise SystemExit(0)" >/dev/null 2>&1; then
            PYTHON="$cand"
            break
        fi
    fi
done
PYTHON="${PYTHON:-python}"

# Windows Python does not understand Git-bash POSIX paths (/c/...); convert to
# a native forward-slash path when cygpath exists (Linux/macOS fall through).
if command -v cygpath >/dev/null 2>&1; then
    PY_FRESHNESS_FILE="$(cygpath -m "$FRESHNESS_FILE")"
else
    PY_FRESHNESS_FILE="$FRESHNESS_FILE"
fi
LAST_VERIFIED=$($PYTHON -c "import json; print(json.load(open('$PY_FRESHNESS_FILE'))['last_verified_commit'])" 2>/dev/null || echo "unknown")
LAST_DATE=$($PYTHON -c "import json; print(json.load(open('$PY_FRESHNESS_FILE'))['last_verified_date'])" 2>/dev/null || echo "unknown")

echo "Last verified commit: $LAST_VERIFIED ($LAST_DATE)"

if [[ "$LAST_VERIFIED" == "$CURRENT_COMMIT" ]]; then
    ok "Documentation is fresh (matches current commit)"
else
    warn "Documentation may be stale: verified at $LAST_VERIFIED, current is $CURRENT_COMMIT"
    warn "Run with --update to refresh the manifest"
    errors=$((errors + 1))
fi

# ─── Verify source files exist ───────────────────────────────────────────────
echo ""
echo "Checking source files..."

SOURCE_FILES=$($PYTHON -c "
import json
data = json.load(open('$PY_FRESHNESS_FILE'))
for f in data.get('source_files_verified', []):
    print(f)
" 2>/dev/null | tr -d '\r')

missing=0
while IFS= read -r file; do
    if [[ -f "$REPO_ROOT/$file" ]]; then
        ok "$file"
    else
        fail "$file — NOT FOUND"
        missing=$((missing + 1))
    fi
done <<< "$SOURCE_FILES"

if [[ $missing -gt 0 ]]; then
    ((errors += missing))
    echo ""
    fail "$missing source file(s) missing"
else
    ok "All source files present"
fi

# ─── Validate Mermaid syntax (basic) ────────────────────────────────────────
echo ""
echo "Checking Mermaid blocks in docs..."

MD_FILES=$(find "$SCRIPT_DIR" -name "*.md" -type f)
mermaid_count=0
mermaid_errors=0

while IFS= read -r md_file; do
    if [ -z "$md_file" ]; then
        continue
    fi
    basename_file=$(basename "$md_file")

    # Count mermaid blocks. `|| true` keeps pipefail from aborting on files
    # without a match; quoting "$md_file" preserves paths with spaces.
    opens=$(grep -E '```mermaid' "$md_file" 2>/dev/null | wc -l | tr -d ' ' || true)
    if [[ "$opens" -gt 0 ]] 2>/dev/null; then
        mermaid_count=$((mermaid_count + opens))
        ok "$basename_file: $opens Mermaid block(s)"
    fi
done <<< "$MD_FILES"

echo ""
ok "Total Mermaid blocks found: $mermaid_count"

# ─── Update freshness manifest if --update flag ──────────────────────────────
if [[ "${1:-}" == "--update" ]]; then
    echo ""
    echo "Updating _freshness.json..."

    TODAY=$(date +%Y-%m-%d)

    $PYTHON -c "
import json
data = json.load(open('$PY_FRESHNESS_FILE'))
data['last_verified_commit'] = '$CURRENT_COMMIT'
data['last_verified_date'] = '$TODAY'
with open('$PY_FRESHNESS_FILE', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
print(f'Updated: commit={data[\"last_verified_commit\"]}, date={data[\"last_verified_date\"]}')
"

    ok "Freshness manifest updated"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $errors -eq 0 ]]; then
    ok "All checks passed — documentation is fresh"
    exit 0
else
    fail "$errors issue(s) found"
    exit 1
fi
