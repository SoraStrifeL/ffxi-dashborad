#!/usr/bin/env python3
"""
FFXI Map DAT Extractor
Converts ROM/115/*.DAT files to PNG images for the dashboard.

Usage:
    python3 extract_maps.py "/path/to/FINAL FANTASY XI/ROM/115" ./public/maps

Output files are named after their zone (e.g. southern_san_doria.png) so
server.js can serve them without any additional renaming step.
Unknown DATs (not in ZONE_TO_NAME) are saved as <number>.png.

Requires: Pillow  (`pip install Pillow`)
"""

import sys
import os
import struct

# ── Zone ID → output filename (must match ZONE_MAPS in server.js) ─────────────
# DAT numbering: zone ID → file number inside ROM/115
# (derived from the retail client's file table; numbers start at 1)
ZONE_TO_DAT = {
    230: 69,  231: 70,  232: 71,  233: 72,
    234: 73,  235: 74,  236: 75,  237: 76,
    238: 77,  239: 78,  240: 79,  241: 80,
    243: 82,  244: 83,  245: 84,  246: 85,
    250: 89,  253: 92,  258: 97,  259: 98,
    263: 102, 312: 151, 316: 155,
    394: 233, 395: 234,
    456: 295, 457: 296,
    185: 24,  186: 25,  187: 26,  188: 27,
}

ZONE_TO_NAME = {
    230: 'southern_san_doria',   231: 'northern_san_doria',
    232: 'port_san_doria',       233: 'chateau_doraguille',
    234: 'bastok_mines',         235: 'bastok_markets',
    236: 'port_bastok',          237: 'metalworks',
    238: 'windurst_waters_1',    239: 'windurst_walls',
    240: 'port_windurst',        241: 'windurst_woods',
    243: 'rulude_gardens',       244: 'upper_jeuno',
    245: 'lower_jeuno',          246: 'port_jeuno',
    250: 'valkurm_dunes',        253: 'rolanberry_fields',
    258: 'konschtat_highlands',  259: 'la_theine_plateau',
    263: 'tahrongi_canyon',      312: 'qufim_island',
    316: 'sauromugue_champaign',
    394: 'aht_urhgan_whitegate', 395: 'al_zahbi',
    456: 'eastern_adoulin',      457: 'western_adoulin',
    185: 'dynamis_san_doria',    186: 'dynamis_bastok',
    187: 'dynamis_windurst',     188: 'dynamis_jeuno',
}

# Reverse: DAT number → zone ID
DAT_TO_ZONE = {v: k for k, v in ZONE_TO_DAT.items()}


def read_dat(filepath):
    with open(filepath, 'rb') as f:
        return f.read()


def is_bmp(data):
    return data[:2] == b'BM'


def is_dds(data):
    return data[:4] == b'DDS '


def bmp_to_png(data, out_path):
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(data))
        img.save(out_path, 'PNG')
        return True
    except Exception as e:
        print(f'    BMP error: {e}')
        return False


def dds_to_png(data, out_path):
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(data))
        img.save(out_path, 'PNG')
        return True
    except Exception:
        pass
    # Fallback: manual DDS parse (uncompressed BGRA)
    try:
        if len(data) < 128:
            return False
        _magic, _size, _flags, height, width = struct.unpack_from('<5I', data, 0)
        print(f'    DDS fallback: {width}x{height}')
        pixel_data = data[128:]
        if len(pixel_data) >= width * height * 4:
            from PIL import Image
            img = Image.frombytes('RGBA', (width, height), pixel_data, 'raw', 'BGRA')
            img.save(out_path, 'PNG')
            return True
    except Exception as e:
        print(f'    DDS parse error: {e}')
    return False


def main():
    if len(sys.argv) < 3:
        print('Usage: python3 extract_maps.py <ROM/115 path> <output dir>')
        sys.exit(1)

    rom_path = sys.argv[1]
    out_path = sys.argv[2]
    os.makedirs(out_path, exist_ok=True)

    try:
        from PIL import Image  # noqa: F401 – early check
    except ImportError:
        print('ERROR: Pillow is required.  Run: pip install Pillow')
        sys.exit(1)

    dat_files = sorted(
        [f for f in os.listdir(rom_path) if f.upper().endswith('.DAT')],
        key=lambda x: int(os.path.splitext(x)[0])
    )
    print(f'Found {len(dat_files)} DAT files in {rom_path}')

    converted = skipped = unknown = 0

    for filename in dat_files:
        num      = int(os.path.splitext(filename)[0])
        filepath = os.path.join(rom_path, filename)
        data     = read_dat(filepath)

        # Determine output name
        zone_id  = DAT_TO_ZONE.get(num)
        if zone_id and zone_id in ZONE_TO_NAME:
            out_name = ZONE_TO_NAME[zone_id] + '.png'
            label    = f'zone {zone_id} ({ZONE_TO_NAME[zone_id]})'
        else:
            out_name = f'{num}.png'
            label    = f'DAT #{num}'

        out_file = os.path.join(out_path, out_name)

        if is_bmp(data):
            print(f'  {filename} → {out_name}  [BMP {len(data)} B]  {label}')
            converted += 1 if bmp_to_png(data, out_file) else 0
        elif is_dds(data):
            print(f'  {filename} → {out_name}  [DDS {len(data)} B]  {label}')
            converted += 1 if dds_to_png(data, out_file) else 0
        else:
            hdr = data[:8].hex() if len(data) >= 8 else data.hex()
            print(f'  {filename} → skipped  [unknown {hdr}]')
            unknown += 1
            continue

    print(f'\nDone: {converted} converted, {unknown} unknown/skipped')
    print(f'Maps saved to: {out_path}')
    print('\nMapped zone files:')
    for zone_id, name in sorted(ZONE_TO_NAME.items()):
        path = os.path.join(out_path, name + '.png')
        status = '✓' if os.path.exists(path) else '✗ missing'
        print(f'  Zone {zone_id:4d}  {name}.png  {status}')


if __name__ == '__main__':
    main()
