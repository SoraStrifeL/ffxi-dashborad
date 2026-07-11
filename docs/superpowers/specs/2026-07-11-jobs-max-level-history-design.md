# Jobs Tab — True Historical Max Level — Design

## Problem

The Database tab's Jobs category shows a "Max Level" column, computed by
`GET /api/db/jobs` (`src/routes/db.ts:484-499`) as
`MAX(char_jobs.<job>)` across every character. This SQL is logically
correct given the schema — but the schema itself doesn't hold what the
column claims to show.

Root-caused via direct investigation of LSB's C++ source
(`/opt/stacks/ffxi/src/map/utils/charutils.cpp`):

- `char_jobs.<job>` is written by `SaveCharJob()` as a **plain overwrite
  of current standing**, not an append or running max, every time a
  character's main job changes level.
- It only updates while that job is the character's **active main job**;
  switching away freezes it.
- It **can decrease**: `DelExperiencePoints()` implements classic
  exp-loss-on-death deleveling, gated by `EXP_LOSS_LEVEL`/`EXP_LOSS_RATE`
  (both stock defaults on this server, active for level 31+), and the
  delevel gets persisted back to `char_jobs.<job>` via the same
  `SaveCharJob()` path.
- No other LSB table tracks a per-character-per-job historical peak
  independent of current standing.

So "Max Level" as currently computed is really "highest *current*
standing across all characters for this job" — which can silently drop
after a death delevel, exactly matching the user's report that it "only
shows player current."

## Decision (confirmed with user)

Build real historical tracking, server-side, via the **simplest
mechanism that doesn't touch LSB's C++ or require a map-server
rebuild**: a new table populated and kept up to date by a MariaDB
`EVENT` (scheduled query), not a new C++ module. This was an explicit
tradeoff decision — a C++ module (matching the existing
`cpp/dashboard_queue.cpp` pattern) was considered and rejected: it
would require a full `ffxi-map` image rebuild/restart (real downtime
risk on the live server) for no benefit over the SQL-only approach,
and would only track currently-online characters at each tick rather
than all characters unconditionally.

## Schema change

### New file: `sql/char_jobs_peak.sql` (dashboard repo, applied manually
against `xidb` — same "apply once" pattern as `sql/dashboard_queue.sql`)

```sql
CREATE TABLE IF NOT EXISTS `char_jobs_peak` (
  `charid` int(10) unsigned NOT NULL,
  `war` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `mnk` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `whm` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `blm` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `rdm` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `thf` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `pld` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `drk` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `bst` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `brd` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `rng` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `sam` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `nin` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `drg` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `smn` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `blu` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `cor` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `pup` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `dnc` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `sch` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `geo` tinyint(2) unsigned NOT NULL DEFAULT '0',
  `run` tinyint(2) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`charid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DELIMITER $$
CREATE EVENT IF NOT EXISTS `ev_char_jobs_peak_sync`
ON SCHEDULE EVERY 1 MINUTE STARTS CURRENT_TIMESTAMP
ON COMPLETION PRESERVE
DO
BEGIN
  INSERT INTO char_jobs_peak
    (charid, war, mnk, whm, blm, rdm, thf, pld, drk, bst, brd, rng,
     sam, nin, drg, smn, blu, cor, pup, dnc, sch, geo, run)
  SELECT
    charid, war, mnk, whm, blm, rdm, thf, pld, drk, bst, brd, rng,
    sam, nin, drg, smn, blu, cor, pup, dnc, sch, geo, run
  FROM char_jobs
  ON DUPLICATE KEY UPDATE
    war=GREATEST(war,VALUES(war)), mnk=GREATEST(mnk,VALUES(mnk)),
    whm=GREATEST(whm,VALUES(whm)), blm=GREATEST(blm,VALUES(blm)),
    rdm=GREATEST(rdm,VALUES(rdm)), thf=GREATEST(thf,VALUES(thf)),
    pld=GREATEST(pld,VALUES(pld)), drk=GREATEST(drk,VALUES(drk)),
    bst=GREATEST(bst,VALUES(bst)), brd=GREATEST(brd,VALUES(brd)),
    rng=GREATEST(rng,VALUES(rng)), sam=GREATEST(sam,VALUES(sam)),
    nin=GREATEST(nin,VALUES(nin)), drg=GREATEST(drg,VALUES(drg)),
    smn=GREATEST(smn,VALUES(smn)), blu=GREATEST(blu,VALUES(blu)),
    cor=GREATEST(cor,VALUES(cor)), pup=GREATEST(pup,VALUES(pup)),
    dnc=GREATEST(dnc,VALUES(dnc)), sch=GREATEST(sch,VALUES(sch)),
    geo=GREATEST(geo,VALUES(geo)), run=GREATEST(run,VALUES(run));
END$$
DELIMITER ;
```

One statement does double duty: for a `charid` with no existing peak row,
the `INSERT` branch fires (seeding from current `char_jobs` — the best
available starting point; peaks lost to deaths *before* this feature
shipped are unrecoverable, as already established). For existing rows,
`GREATEST()` ensures every column can only ever increase.

**Known limitation, stated explicitly:** peaks only start accumulating
from whenever this event first runs. A character whose WHM peaked at 99
years ago and has since deleveled to 60 will show a starting peak of 60
(the current `char_jobs.whm` value at seed time), not 99 — that history
is genuinely gone; LSB never persisted it. This is a one-time
data-availability gap affecting the *first* recorded peak for every
existing character, not an ongoing bug — the tracking is fully accurate
from this point forward.

## Infra change (outside the dashboard repo)

`/opt/stacks/ffxi/compose.yaml`'s `database` service `command:` gains
`--event-scheduler=ON`:

```yaml
command: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_general_ci', '--event-scheduler=ON']
```

Applying this requires `docker compose up -d database` (recreate, not
rebuild — no image change, `ffxi-db` volume untouched) against the LSB
stack's own compose file. This causes a brief DB reconnect blip for
`connect`/`world`/`map`/`search` and any online players — a normal,
low-risk container recreate, done as its own explicit step, confirmed
with the user immediately before execution (separate from any dashboard
code deploy).

## Backend change (`src/routes/db.ts`)

`GET /api/db/jobs`'s SQL changes from
`FROM chars c JOIN char_jobs cj ON cj.charid = c.charid` to
`FROM chars c JOIN char_jobs_peak cj ON cj.charid = c.charid` — same
column names, same `JOBS_LIST` iteration, same response shape
(`{job, max, count}[]`). No client-side changes needed; the "Max Level"
column now reflects real historical peaks. `count` (characters who have
ever leveled past 1) also becomes historically accurate for the same
reason.

## Error handling

If `char_jobs_peak` doesn't exist yet (SQL not applied) or is empty (event
hasn't run yet), the route's existing `try/catch` already returns a 500
with the DB error message — same behavior as any other missing-table
case in this route today, no new handling needed.

## Testing

No new pure logic to unit test (this is a SQL/schema change plus a
one-table-name swap in an existing query). Verification: apply the SQL,
confirm the event fires (check `information_schema.EVENTS` /
`LAST_EXECUTED`, or just wait >1 minute and diff the table), confirm
`/api/db/jobs` reflects `char_jobs_peak` values, and — the concrete
regression case that started this — verify a job level survives a
simulated delevel: note a character's current peak for a job, force a
delevel (e.g. via GM console `player:delevel()` or the existing death/
exp-loss mechanic if reproducible), confirm `char_jobs.<job>` dropped but
`/api/db/jobs`'s reported max for that job did NOT.
