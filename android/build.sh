#!/usr/bin/env bash
# ============================================================
# build.sh — Ping-Pong Duel APK build (Linux/CI port of build.cmd)
# Inputs:  res/ java/ assets/ AndroidManifest.xml (+ optional keystore)
# Outputs: PingPongDuel.apk (signed)
# Env:
#   KEYSTORE_PASS / KEY_PASS   signing passwords (required)
#   KEYSTORE_FILE              keystore path (default android/release.keystore)
#   VERSION_CODE / VERSION_NAME  aapt2 link flags (defaults 23 / 3.0.0)
# Requires: JDK 17 (javac/jar/keytool on PATH), Android SDK:
#   $ANDROID_HOME/build-tools/34.0.0 + $ANDROID_HOME/platforms/android-34
#   7z (p7zip-full), matching build.cmd: assets + classes.dex added via 7z
#   (forward-slash entry names; resources.arsc stays STORED), then zipalign + apksigner.
# ============================================================
set -euo pipefail

BT="${ANDROID_HOME:-/usr/local/lib/android/sdk}/build-tools/34.0.0"
PLAT="${ANDROID_HOME:-/usr/local/lib/android/sdk}/platforms/android-34/android.jar"
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/ppd_apk_build"
OUT="$WORK/build"
KEYSTORE_FILE="${KEYSTORE_FILE:-$ROOT/release.keystore}"
VERSION_CODE="${VERSION_CODE:-23}"
VERSION_NAME="${VERSION_NAME:-3.0.0}"

command -v 7z >/dev/null || { echo "[ERR] 7z not found"; exit 1; }
[ -x "$BT/aapt2" ] || { echo "[ERR] build-tools not found: $BT"; exit 1; }
[ -f "$PLAT" ] || { echo "[ERR] platform not found: $PLAT"; exit 1; }
[ -n "${KEYSTORE_PASS:-}" ] && [ -n "${KEY_PASS:-}" ] || { echo "[ERR] KEYSTORE_PASS/KEY_PASS not set"; exit 1; }
[ -f "$KEYSTORE_FILE" ] || { echo "[ERR] keystore not found: $KEYSTORE_FILE"; exit 1; }

rm -rf "$WORK"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"
cp -r "$ROOT/res" "$ROOT/java" "$WORK/"
cp -r "$ROOT/assets" "$WORK/assets"
cp "$ROOT/AndroidManifest.xml" "$WORK/"

echo "[1/7] compile resources..."
"$BT/aapt2" compile --dir "$WORK/res" -o "$OUT/res.zip"

echo "[2/7] link manifest + resources (assets added later via 7z)..."
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$PLAT" \
  --manifest "$WORK/AndroidManifest.xml" -R "$OUT/res.zip" --auto-add-overlay \
  --java "$OUT/gen" --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"

echo "[3/7] compile java..."
javac -encoding UTF-8 -source 1.8 -target 1.8 -classpath "$PLAT" -d "$OUT/classes" \
  "$OUT/gen/com/ppd/duel/R.java" "$ROOT/java/com/ppd/duel/MainActivity.java"

echo "[4/7] dex..."
jar cf "$OUT/classes.jar" -C "$OUT/classes" .
"$BT/d8" --release --lib "$PLAT" --output "$OUT/dex" "$OUT/classes.jar"

echo "[5/7] add assets + classes.dex via 7z (arsc stays STORED)..."
( cd "$WORK" && 7z a -tzip "$OUT/unsigned.apk" assets -mx5 >/dev/null )
( cd "$OUT/dex" && 7z a -tzip "$OUT/unsigned.apk" classes.dex -mx5 >/dev/null )

echo "[6/7] zipalign..."
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "[7/7] sign..."
"$BT/apksigner" sign --ks "$KEYSTORE_FILE" --ks-pass "pass:$KEYSTORE_PASS" \
  --key-pass "pass:$KEY_PASS" --v1-signing-enabled false \
  --out "$OUT/PingPongDuel.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/PingPongDuel.apk"

cp "$OUT/PingPongDuel.apk" "$ROOT/PingPongDuel.apk"
echo "[DONE] $ROOT/PingPongDuel.apk"
