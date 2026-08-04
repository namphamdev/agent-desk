#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <version>" >&2
  exit 2
fi

VERSION=$1
case "$VERSION" in
  ''|*[!0-9.]*|.*|*.|*..*)
    echo "Invalid version: $VERSION (expected MAJOR.MINOR.PATCH)" >&2
    exit 2
    ;;
esac

if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Invalid version: $VERSION (expected MAJOR.MINOR.PATCH)" >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TAG="v$VERSION"
COMMIT_MESSAGE="chore: bump version to $VERSION"

if ! git -C "$ROOT_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Not inside a git repository: $ROOT_DIR" >&2
  exit 1
fi

if git -C "$ROOT_DIR" rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  echo "Tag already exists: $TAG" >&2
  exit 1
fi

VERSION="$VERSION" ROOT_DIR="$ROOT_DIR" python3 <<'PY'
import os
from pathlib import Path
import re
import tempfile

version = os.environ["VERSION"]
root = Path(os.environ["ROOT_DIR"])

replacements = [
    (root / "apps/rn/Comet/package.json",
        r'(^\s*"version":\s*)"[^"]+"(,?$)',
        rf'\1"{version}"\2',
        1,
    ),
    (root / "apps/rn/Comet/app.config.ts",
        r"(^\s*version:\s*)'[^']+'(,?$)",
        rf"\1'{version}'\2",
        1,
    ),
    (root / "apps/rn/Comet/package-lock.json",
        r'(\A\{\n  "name":\s*"[^"]+",\n  "version":\s*)"[^"]+"',
        rf'\1"{version}"',
        1,
    ),
    (root / "apps/rn/Comet/package-lock.json",
        r'(^    "": \{\n      "name":\s*"[^"]+",\n      "version":\s*)"[^"]+"',
        rf'\1"{version}"',
        1,
    ),
    (root / "edge/package.json",
        r'(^\s*"version":\s*)"[^"]+"(,?$)',
        rf'\1"{version}"\2',
        1,
    ),
    (root / "Cargo.toml",
        r'(^version\s*=\s*)"[^"]+"(\s*$)',
        rf'\1"{version}"\2',
        1,
    ),
]

def replace_checked(path: Path, pattern: str, replacement: str, expected: int) -> None:
    if not path.is_file():
        raise SystemExit(f"Missing version file: {path}")
    text = path.read_text()
    updated, count = re.subn(pattern, replacement, text, flags=re.MULTILINE)
    if count != expected:
        raise SystemExit(
            f"Expected {expected} version declaration(s) in {path}, found {count}"
        )
    if updated != text:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, delete=False
        ) as temporary:
            temporary.write(updated)
            temporary_path = Path(temporary.name)
        temporary_path.replace(path)

for path, pattern, replacement, expected in replacements:
    replace_checked(path, pattern, replacement, expected)
    print(f"Updated {path.relative_to(root)} to {version}")
PY

git -C "$ROOT_DIR" add \
  Cargo.toml \
  apps/rn/Comet/package.json \
  apps/rn/Comet/app.config.ts \
  apps/rn/Comet/package-lock.json \
  edge/package.json \
  scripts/bump-version.sh

if git -C "$ROOT_DIR" diff --cached --quiet; then
  echo "No version changes to commit." >&2
  exit 1
fi

git -C "$ROOT_DIR" commit -m "$COMMIT_MESSAGE"
git -C "$ROOT_DIR" tag "$TAG"

echo "Created commit and tag $TAG"
