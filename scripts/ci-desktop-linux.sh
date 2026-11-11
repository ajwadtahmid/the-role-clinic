#!/usr/bin/env bash
# The Linux desktop steps of CI, kept in one file so the workflow and a local run cannot drift apart.
# Usage: bash scripts/ci-desktop-linux.sh [image|build|smoke|all]   (default: all). Needs Docker.
# Run it locally before tagging a release: it costs no GitHub Actions minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
image=role-clinic-phase8-build

step_image() {
  docker build -f packaging/Dockerfile.desktop-linux -t "$image" .
}

# Build the AppImage on the oldest supported Linux baseline.
step_build() {
  mkdir -p dist/cargo-cache dist/desktop-cache
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" \
    -e CARGO_HOME=/work/dist/cargo-cache -e XDG_CACHE_HOME=/work/dist/desktop-cache \
    -e CARGO_TARGET_DIR=/work/dist/desktop-target \
    -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" "$image" npm run desktop:build
}

# Check the real AppImage payload and run the native UI test, without outbound networking.
step_smoke() {
  docker run --rm --network none -v "$PWD:/work" \
    -e TAURI_WEBVIEW_AUTOMATION=true -e DESKTOP_EVIDENCE_DIR=/work/dist/appimage-evidence \
    -e WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 -e LIBGL_ALWAYS_SOFTWARE=1 \
    "$image" sh -c \
    'cd /tmp && /work/dist/desktop-target/release/bundle/appimage/*.AppImage --appimage-extract > /dev/null && node /work/scripts/smoke-package.mjs /tmp/squashfs-root/usr/libexec/the-role-clinic/backend && dbus-run-session -- xvfb-run -a node /work/scripts/smoke-desktop.mjs /tmp/squashfs-root/AppRun /tmp/squashfs-root/usr/libexec/the-role-clinic/backend'
}

case "${1:-all}" in
  image) step_image ;;
  build) step_build ;;
  smoke) step_smoke ;;
  all) step_image; step_build; step_smoke ;;
  *) echo "Usage: bash scripts/ci-desktop-linux.sh [image|build|smoke|all]" >&2; exit 2 ;;
esac
