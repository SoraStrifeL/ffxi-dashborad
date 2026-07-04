# Instant exact map calibration from the Windower addon

The dashboard ships DAT-derived map calibrations (tagged `src:"dat"` in
`data/calibrations.json`). They are close but approximate — the in-game map
sheets have margins the zone geometry can't know about. The server upgrades
any `src:"dat"` entry to an **exact** calibration as soon as it receives two
`get_map_data()` samples far enough apart for that zone.

Normally that needs the player to walk ~25+ yalms after zoning. The addon can
skip the walking by probing `windower.ffxi.get_map_data(x, y, z)` with
synthetic coordinates around the player and sending the results in the
position POST — one POST calibrates the whole zone exactly, even standing
still at the zone line.

## Patch for `Dashboard.lua` (on the gaming PC)

Add this helper near the existing `get_map_data` call:

```lua
-- Probe map pixels at synthetic points around the player. Two samples that
-- differ by >=25 on both axes let the dashboard solve the zone's exact
-- world->map transform. Points outside the map sheet are skipped safely.
local function cal_samples(pos)
    local out = {}
    local offsets = { {0, 0}, {150, 0}, {0, 150}, {-150, -150} }
    for _, o in ipairs(offsets) do
        local wx, wy = pos.x + o[1], pos.y + o[2]
        local map_id, px, py = windower.ffxi.get_map_data(wx, wy, pos.z)
        if map_id == 0 and px and py and px >= 0 and px <= 512 and py >= 0 and py <= 512 then
            out[#out + 1] = { x = wx, z = wy, px = px, py = py }
        end
    end
    return out
end
```

Then, where the position POST body is built (the table that already carries
`map_x` / `map_y`), add:

```lua
body.cal = cal_samples(pos)   -- pos = windower.ffxi.get_mob_by_target('me') position
```

Notes:

- Windower coordinates: `y` = north/south. The `z` field sent to the server
  is Windower `y` — same convention the addon already uses for `map_x`/`map_y`.
- The server (`/api/windower/position`) accepts up to 16 samples per POST and
  only uses them for zones whose calibration is missing or DAT-generated;
  hand-made and previously autocal'd zones are never touched.
- `map_id ~= 0` (upper floors / sub-maps) samples are ignored, matching the
  existing per-zone floor-0 calibration model.
