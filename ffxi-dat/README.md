# FFXI DAT drop folder

This folder feeds the **optional DAT fetcher**. Drop retail FFXI client
resource files here so the dashboard can read official item/spell/ability
text, zone/key-item/title names, dialog, and icons.

DAT files are **never committed** (large + copyrighted) — see `.gitignore`.
The feature stays disabled when this folder is empty.

## Step 1 — give me the index files first (small)

From your FFXI client install root (the folder containing `FFXI.exe` /
`pol.exe`, or `.../SquareEnix/FINAL FANTASY XI/`), copy these two here:

```
ffxi-dat/FTABLE.DAT
ffxi-dat/VTABLE.DAT
```

They're a few hundred KB. `FTABLE.DAT` maps each resource ID → a numbered
`ROM/<a>/<b>.DAT` path; `VTABLE.DAT` says which ROM volume. With these I can
resolve exactly which data DATs hold items/spells/zones/etc.

## Step 2 — I'll tell you which data DATs to copy

Once I parse FTABLE, I'll list the specific files (e.g. `ROM/165/29.DAT`
for item names, a few for descriptions/spells/abilities/dialog, and the icon
DATs) and where to place them here, preserving the `ROM/<a>/<b>.DAT`
structure. Then I build + verify the parsers against them.

## Notes
- Region/version matters slightly (retail vs. private-server client). If you
  know the client version, mention it.
- If you'd rather just copy whole `ROM`, `ROM2`, `ROM3` folders here, that
  works too — I'll pick out what I need — but it can be large.
