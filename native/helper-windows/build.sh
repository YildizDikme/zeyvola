#!/bin/sh
# Builds the Zeyvola Windows helper (x64) on macOS or Linux with Zig's C compiler (MIT).
# Nothing third-party goes into the program: no C runtime (no mingw-w64 CRT), no third-party
# headers (win-api.h holds our own declarations; -nostdinc keeps every other header out) and no
# prebuilt import libraries (they are generated here from imports/*.def, which list only the
# system DLL functions the helper calls). Output: bin/zeyvola-win.exe (unsigned).
set -eu
cd "$(dirname "$0")"
ZIG=${ZIG:-../../tools/.cache/zig/zig}
mkdir -p bin .build
LIBS=""
for def in imports/*.def; do
  lib=".build/$(basename "$def" .def).lib"
  "$ZIG" dlltool -m i386:x86-64 -d "$def" -l "$lib"
  LIBS="$LIBS $lib"
done
# shellcheck disable=SC2086
"$ZIG" cc -target x86_64-windows-gnu -O2 -Wall -Wextra -Wno-unused-parameter \
  -nostdinc -nostdlib -fno-stack-protector -mno-stack-arg-probe -fno-builtin \
  -s -Wl,--entry=mainCRTStartup -Wl,--subsystem,console \
  zeyvola-win.c zeyvola-win.rc -o bin/zeyvola-win.exe $LIBS
rm -f bin/zeyvola-win.lib bin/zeyvola-win.pdb  # the linker's import library and debug file; not shipped
ls -l bin/zeyvola-win.exe
