#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [--force] <flutter-app-root>" >&2
  exit 2
}

force=0
if [ "${1:-}" = "--force" ]; then
  force=1
  shift
fi
[ "$#" -eq 1 ] || usage

app_root="$(cd "$1" && pwd)"
[ -f "$app_root/pubspec.yaml" ] || {
  echo "not a Flutter app root: $app_root (pubspec.yaml missing)" >&2
  exit 1
}

script_dir="$(cd "$(dirname "$0")" && pwd)"
source_file="$script_dir/../assets/screen_preview.dart"
destination="$app_root/test/support/showcase_preview.dart"

mkdir -p "$(dirname "$destination")"

if [ -f "$destination" ]; then
  if cmp -s "$source_file" "$destination"; then
    echo "already current: $destination"
    exit 0
  fi
  [ "$force" -eq 1 ] || {
    echo "refusing to overwrite changed harness: $destination" >&2
    echo "review the diff, then rerun with --force if replacement is intended" >&2
    exit 1
  }
fi

cp "$source_file" "$destination"
echo "installed: $destination"
