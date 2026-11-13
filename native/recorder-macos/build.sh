#!/bin/sh
# Builds the Zeyvola macOS recording helper as a universal binary (arm64 + x86_64).
# Apple system frameworks only. Calls swiftc directly, so only the Command Line Tools
# are needed (no Xcode, no SwiftPM). Output: bin/zeyvola-recorder (ad-hoc signed).
set -eu
cd "$(dirname "$0")"
MIN=13.0
OUT=bin
WORK=.build/swiftc
mkdir -p "$OUT" "$WORK"
SOURCES=$(ls Sources/ZeyvolaRecorder/*.swift)
SDK=$(xcrun --show-sdk-path)

for ARCH in arm64 x86_64; do
  # shellcheck disable=SC2086
  swiftc -O -whole-module-optimization -swift-version 5 \
    -sdk "$SDK" -target "$ARCH-apple-macos$MIN" \
    -module-name ZeyvolaRecorder \
    -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia \
    -framework CoreVideo -framework AppKit \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
    $SOURCES -o "$WORK/zeyvola-recorder-$ARCH"
done

lipo -create "$WORK/zeyvola-recorder-arm64" "$WORK/zeyvola-recorder-x86_64" -output "$OUT/zeyvola-recorder"
codesign --force --sign - --identifier com.zeyvola.recorder --options runtime --entitlements entitlements.plist "$OUT/zeyvola-recorder"
lipo -info "$OUT/zeyvola-recorder"
