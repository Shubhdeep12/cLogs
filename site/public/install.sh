#!/bin/sh
# Installs the latest cLogs for macOS:  curl -fsSL https://clogs.okshubh.in/install.sh | sh
#
# Files that curl downloads aren't flagged as "downloaded from the internet",
# so macOS opens the app without the "Apple could not verify" prompt.
# The download is checked against the release's SHA256SUMS.txt first.
#
# Options (environment variables):
#   CLOGS_DIR=~/Applications   where to put cLogs.app (default /Applications,
#                              or ~/Applications if that isn't writable)
#   CLOGS_VERSION=0.1.2        a specific version instead of the latest
#   CLOGS_NO_OPEN=1            don't launch the app afterwards
set -eu

REPO="Shubhdeep12/cLogs"
APP="cLogs.app"

say() { printf '%s\n' "$*"; }
fail() { printf 'cLogs install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this script is for macOS. Other systems: https://github.com/$REPO/releases/latest"

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64)
    # An Intel shell under Rosetta on Apple Silicon still wants the arm64 build.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; else arch=x64; fi ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac

if [ -n "${CLOGS_VERSION:-}" ]; then
  version="${CLOGS_VERSION#v}"
else
  # /releases/latest redirects to /releases/tag/vX.Y.Z (no API rate limit).
  tag_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
    || fail "couldn't reach GitHub"
  version="${tag_url##*/v}"
fi
case "$version" in
  *[!0-9.]* | "") fail "couldn't work out the latest version" ;;
esac

if [ -n "${CLOGS_DIR:-}" ]; then
  dest="$CLOGS_DIR"
elif [ -w /Applications ]; then
  dest=/Applications
else
  dest="$HOME/Applications"
fi
mkdir -p "$dest"

zip="clogs-$version-mac-$arch.zip"
base="https://github.com/$REPO/releases/download/v$version"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/clogs-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading cLogs $version ($arch)…"
curl -fL --progress-bar -o "$tmp/$zip" "$base/$zip" || fail "download failed: $base/$zip"
curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || fail "couldn't download SHA256SUMS.txt"

expected=$(awk -v f="$zip" '{ n = $2; sub(/^\*/, "", n) } n == f { print tolower($1) }' "$tmp/SHA256SUMS.txt")
actual=$(shasum -a 256 "$tmp/$zip" | awk '{ print $1 }')
[ -n "$expected" ] || fail "$zip is missing from SHA256SUMS.txt"
[ "$expected" = "$actual" ] || fail "checksum mismatch, nothing was installed"

ditto -x -k "$tmp/$zip" "$tmp/unpacked"
[ -d "$tmp/unpacked/$APP" ] || fail "the archive has no $APP inside"
codesign --verify --deep --strict "$tmp/unpacked/$APP" 2>/dev/null || fail "the app's signature doesn't verify"
xattr -dr com.apple.quarantine "$tmp/unpacked/$APP" 2>/dev/null || true

target="$dest/$APP"

# Quit the copy being replaced, if it's running.
running() { pgrep -f "^$target/Contents/MacOS/cLogs" >/dev/null 2>&1; }
if running; then
  say "Quitting the running cLogs…"
  pkill -TERM -f "^$target/Contents/MacOS/cLogs" 2>/dev/null || true
  i=0; while running && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
fi

if [ -e "$target" ]; then
  rm -rf "$target.previous"
  mv "$target" "$target.previous"
fi
if mv "$tmp/unpacked/$APP" "$target"; then
  rm -rf "$target.previous"
else
  [ -e "$target.previous" ] && mv "$target.previous" "$target"
  fail "couldn't write to $dest"
fi

say "Installed cLogs $version in $dest"
[ -n "${CLOGS_NO_OPEN:-}" ] || open "$target"
