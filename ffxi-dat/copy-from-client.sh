#!/bin/sh
# Copy the 22 needed DATs from a FFXI client install into this folder,
# preserving the ROM/<dir>/<file>.DAT structure.
#
# Usage:  sh copy-from-client.sh /path/to/FINAL_FANTASY_XI
# (point it at the folder that contains the ROM/ directory)

SRC="$1"
if [ -z "$SRC" ] || [ ! -d "$SRC/ROM" ]; then
  echo "Usage: sh copy-from-client.sh <FFXI install dir containing ROM/>"; exit 1
fi
DST="$(cd "$(dirname "$0")" && pwd)"

grep -oE 'ROM/[0-9]+/[0-9]+\.DAT' "$DST/NEEDED.txt" | while IFS= read -r f; do
  mkdir -p "$DST/$(dirname "$f")"
  if cp "$SRC/$f" "$DST/$f" 2>/dev/null; then echo "ok   $f"; else echo "MISS $f"; fi
done
echo "done → $DST/ROM"
