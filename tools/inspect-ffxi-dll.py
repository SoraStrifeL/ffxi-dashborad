#!/usr/bin/env python3
"""Standalone research script: check FFXi.dll for a per-zone map-registration
table (world coord -> map pixel transform), the data get_map_data() would
need. Static analysis only (stdlib, no pefile/capstone) — pairs with
`objdump -p` / `objdump -d -M intel` for export listing and disassembly.

Usage: python3 tools/inspect-ffxi-dll.py "FINAL FANTASY XI/FFXi.dll"

Result (2026-07-08): FFXi.dll is a small ATL/COM registration shim (4
boilerplate exports: DllCanUnloadNow/DllGetClassObject/DllRegisterServer/
DllUnregisterServer; reads SOFTWARE\\PlayOnline*\\InstallFolder registry keys;
own separate PDB build path FFXi_Win\\FFXi___Win32_Retail — distinct from the
main game engine FFXiMain.dll). No zone/map/coordinate strings anywhere in
its ~880 printable strings, and this scan finds zero plausible-magnitude
float32 clusters in .rdata/.data. Not a viable source for map-registration
data — see memory `ffxi-dat-zone-format` for the fuller negative-result note.
"""
import struct
import subprocess
import sys


def section_table(path: str) -> list[tuple[str, int, int]]:
    """(name, file_offset, size) for every section, via `objdump -h`."""
    out = subprocess.run(["objdump", "-h", path], capture_output=True, text=True, check=True).stdout
    sections = []
    for line in out.splitlines():
        parts = line.split()
        # "  0 .text  00010998  10001000  10001000  00000400  2**2"
        if len(parts) >= 6 and parts[0].isdigit():
            name, size_hex, _vma, _lma, fileoff_hex = parts[1], parts[2], parts[3], parts[4], parts[5]
            sections.append((name, int(fileoff_hex, 16), int(size_hex, 16)))
    return sections


def plausible(v: float) -> bool:
    """FFXI zone coords/scale factors are small nonzero finite numbers."""
    if v != v:  # NaN
        return False
    av = abs(v)
    return 0.01 <= av <= 20000


def scan_float_runs(data: bytes, sections: list[tuple[str, int, int]], min_run: int = 6) -> int:
    hits = 0
    for name, off, size in sections:
        if name in (".text", ".reloc", ".rsrc"):
            continue  # code / relocations / resources — not raw data tables
        blob = data[off:off + size]
        run: list[float] = []
        for i in range(len(blob) // 4):
            v = struct.unpack_from("<f", blob, i * 4)[0]
            if plausible(v):
                run.append(round(v, 3))
                continue
            if len(run) >= min_run:
                start = off + (i - len(run)) * 4
                print(f"{name} run of {len(run)} plausible floats @ {start:#x}: {run[:12]}")
                hits += 1
            run = []
        if len(run) >= min_run:
            print(f"{name} run of {len(run)} plausible floats (tail): {run[:12]}")
            hits += 1
    return hits


def main() -> None:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <path-to-dll>", file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]

    with open(path, "rb") as f:
        data = f.read()

    print("== exports (objdump -p) ==")
    subprocess.run(["objdump", "-p", path])

    print("\n== zone/map-related strings ==")
    strs = subprocess.run(["strings", "-n", "4", path], capture_output=True, text=True, check=True).stdout
    matches = [s for s in strs.splitlines() if any(k in s.lower() for k in ("zone", "map", "region", "coord"))]
    print("\n".join(matches) if matches else "(none found)")

    print("\n== float32 cluster scan (.rdata/.data) ==")
    sections = section_table(path)
    hits = scan_float_runs(data, sections)
    print(f"\ntotal plausible-float runs found: {hits}")


if __name__ == "__main__":
    main()
