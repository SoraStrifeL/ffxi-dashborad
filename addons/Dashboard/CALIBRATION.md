# Instant exact map calibration from the Windower addon

The dashboard ships DAT-derived map calibrations (tagged `src:"dat"` in
`data/calibrations.json`). They are close but approximate — the in-game map
sheets have margins the zone geometry can't know about. The server upgrades
any `src:"dat"` entry to an **exact** calibration as soon as it receives two
`get_map_data()` samples far enough apart for that zone.

Normally that needs the player to walk ~25+ yalms after zoning. The addon can
skip the walking by probing `windower.ffxi.get_map_data()` with synthetic
coordinates around the player and sending the results in the position POST —
one POST calibrates the whole zone exactly, even standing still at the zone
line.

## Coordinate axes — read this first

In this addon's position data, **`y` is elevation (height)** and the two
horizontal axes are `x` (east/west) and `z` (north/south). The probe points
must vary the two HORIZONTAL axes — offsetting the height axis moves the
probe into the air and the map pixel never changes, so the server rejects the
pair as degenerate and the zone never calibrates.

`windower.ffxi.get_map_data(a, b, c)` takes the coordinates in the same
order the rest of the Windower API uses. If in doubt, test once in-game:

```lua
//lua exec local me = windower.ffxi.get_mob_by_target('me'); local _,ax,ay = windower.ffxi.get_map_data(me.x+100, me.y, me.z); local _,bx,by = windower.ffxi.get_map_data(me.x, me.y+100, me.z); windower.add_to_chat(207, ('dx: %.1f,%.1f  dy: %.1f,%.1f'):format(ax, ay, bx, by))
```

Whichever argument makes the returned pixel move is a horizontal axis; the
one that doesn't is height. Use the two that move below.

## Patch for `Dashboard.lua` (on the gaming PC)

Add this helper near the existing `get_map_data` call. It assumes `pos.y` is
height and `pos.x` / `pos.z` are the horizontal axes — swap the arguments in
the `get_map_data` call if your in-game test above says otherwise:

```lua
-- Probe map pixels at synthetic points around the player. Two samples that
-- differ by >=25 on BOTH horizontal axes let the dashboard solve the zone's
-- exact world->map transform. Points outside the map sheet are skipped.
local function cal_samples(pos)
    local out = {}
    local offsets = { {0, 0}, {150, 0}, {0, 150}, {-150, -150} }
    for _, o in ipairs(offsets) do
        local wx, wz = pos.x + o[1], pos.z + o[2]
        -- args: east/west, north/south, height — adjust order to match your
        -- probe test; only the two horizontal values may vary.
        local map_id, px, py = windower.ffxi.get_map_data(wx, wz, pos.y)
        if map_id == 0 and px and py and px >= 0 and px <= 512 and py >= 0 and py <= 512 then
            out[#out + 1] = { x = wx, z = wz, px = px, py = py }
        end
    end
    return out
end
```

Then, where the position POST body is built (the table that already carries
`map_x` / `map_y`), add:

```lua
body.cal = cal_samples(pos)
```

The `x` and `z` fields of each sample must be the **east/west** and
**north/south** world values respectively — that is what the server solves
against (`z` here is the LandSandBoat `pos_z` axis).

Notes:

- The server (`/api/windower/position`) accepts up to 16 samples per POST and
  only uses them for zones whose calibration is missing or DAT-generated;
  hand-made and previously autocal'd zones are never touched.
- Degenerate pairs (pixel not moving on an axis) are rejected server-side, so
  a wrong axis order can never corrupt a calibration — the zone just stays on
  its DAT value.
- `map_id ~= 0` (upper floors / sub-maps) samples are ignored, matching the
  existing per-zone floor-0 calibration model.
- Success is visible in the dashboard logs as
  `[autocal] zone N calibrated from Windower map data` and the zone's entry
  in `data/calibrations.json` losing its `src:"dat"` tag.
