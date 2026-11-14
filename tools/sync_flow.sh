#!/usr/bin/env bash
# Re-copy the vendored flow engine and shared module from the flow_build workspace.
# Usage: tools/sync_flow.sh [path/to/flow_build]   (or set FLOW_BUILD)
set -euo pipefail
SRC="${1:-${FLOW_BUILD:-}}"
if [[ -z "$SRC" ]]; then echo "usage: tools/sync_flow.sh <flow_build dir> (or set FLOW_BUILD)" >&2; exit 1; fi
DEST="$(cd "$(dirname "$0")/.." && pwd)"
for f in "engine/flow-engine.js" "shared/flow-shared.js"; do
  [[ -f "$SRC/$f" ]] || { echo "missing $SRC/$f" >&2; exit 1; }
done
cp "$SRC/engine/flow-engine.js" "$DEST/flow-engine.js"
cp "$SRC/shared/flow-shared.js" "$DEST/flow-shared.js"
if [[ "${2:-}" == "--fixture" ]]; then cp "$SRC/fixture.json" "$DEST/fixture.json"; fi
echo "synced engine + shared from $SRC"
( cd "$DEST" && git diff --stat -- flow-engine.js flow-shared.js fixture.json || true )
