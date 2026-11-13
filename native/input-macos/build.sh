#!/bin/sh
# Builds the Zeyvola pointer helper as a universal binary (arm64 + x86_64): mouse buttons and
# scroll only, AppKit and Foundation only (no capture or media frameworks, no codecs).
# Only the Command Line Tools are needed. Output: bin/zeyvola-input (ad-hoc signed).
set -eu
cd "$(dirname "$0")"
MIN=13.0
OUT=bin
WORK=.build/swiftc
mkdir -p "$OUT" "$WORK"
SDK=$(xcrun --show-sdk-path)

for ARCH in arm64 x86_64; do
  swiftc -O -whole-module-optimization -swift-version 5 \
    -sdk "$SDK" -target "$ARCH-apple-macos$MIN" \
    -module-name ZeyvolaInput \
    -framework AppKit \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
    Sources/main.swift -o "$WORK/zeyvola-input-$ARCH"
done

lipo -create "$WORK/zeyvola-input-arm64" "$WORK/zeyvola-input-x86_64" -output "$OUT/zeyvola-input"
codesign --force --sign - --identifier com.zeyvola.input --options runtime "$OUT/zeyvola-input"
lipo -info "$OUT/zeyvola-input"
