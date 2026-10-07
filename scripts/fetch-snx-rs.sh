#!/usr/bin/env bash
# Качает upstream snx-rs в vendor/snx-rs для упаковки в Resources.
# AGPL-3.0: см. vendor/snx-rs/NOTICE.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/snx-rs"
TAG="${SNX_TAG:-v6.4.1}"
BASE="https://github.com/ancwrd1/snx-rs/releases/download/${TAG}"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

arch="$(uname -m)"
os="$(uname -s)"

copy_one() {
  local src="$1" name="$2"
  if [[ -f "$src" ]]; then
    cp -f "$src" "$OUT/$name"
    chmod +x "$OUT/$name"
    echo "→ $OUT/$name"
  fi
}

if [[ "$os" == "Darwin" ]]; then
  if [[ "$arch" != "arm64" ]]; then
    echo "На Intel macOS: brew install snx-rs или поставьте бинари вручную" >&2
    exit 1
  fi
  dmg="snx-rs-${TAG}-aarch64-apple-darwin.dmg"
  echo "Downloading $dmg …"
  curl -fsSL -o "$TMP/snx.dmg" "$BASE/$dmg"
  MNT="$TMP/mnt"
  mkdir -p "$MNT"
  hdiutil attach "$TMP/snx.dmg" -mountpoint "$MNT" -nobrowse -quiet
  pkgutil --expand-full "$MNT/SNX-RS.pkg" "$TMP/pkg"
  hdiutil detach "$MNT" -quiet || true
  PAYLOAD="$(find "$TMP/pkg" -type d -path '*/Payload' | head -1)"
  copy_one "$PAYLOAD/usr/local/bin/snxctl" snxctl
  copy_one "$PAYLOAD/Library/Application Support/snx-rs/snx-rs" snx-rs
elif [[ "$os" == "Linux" ]]; then
  if [[ "$arch" == "aarch64" || "$arch" == "arm64" ]]; then
    txz="snx-rs-${TAG}-linux-arm64.tar.xz"
  else
    txz="snx-rs-${TAG}-linux-x86_64.tar.xz"
  fi
  echo "Downloading $txz …"
  curl -fsSL -o "$TMP/snx.tar.xz" "$BASE/$txz"
  tar -xJf "$TMP/snx.tar.xz" -C "$TMP"
  while IFS= read -r f; do
    copy_one "$f" "$(basename "$f")"
  done < <(find "$TMP" -type f \( -name snx-rs -o -name snxctl \))
else
  echo "Unsupported OS: $os" >&2
  exit 1
fi

cat >"$OUT/NOTICE" <<EOF
snx-rs ${TAG}
https://github.com/ancwrd1/snx-rs
License: GNU Affero General Public License v3.0
https://www.gnu.org/licenses/agpl-3.0.html

Kontur ships the unmodified upstream binary and invokes it as a subprocess.
Release assets: ${BASE}
EOF

if [[ ! -x "$OUT/snx-rs" && ! -x "$OUT/snxctl" ]]; then
  echo "Не удалось извлечь snx-rs/snxctl" >&2
  exit 1
fi
echo "OK: vendor/snx-rs готов (${TAG})"
ls -la "$OUT"
