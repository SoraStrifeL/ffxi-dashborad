# Jobs Tab True Historical Max Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Database tab's Jobs "Max Level" column show a true historical peak per job (one that survives exp-loss-on-death delevels) instead of current live standing, by adding server-side peak tracking that requires no LSB C++ changes or map-server rebuild.

**Architecture:** A new `char_jobs_peak` table, kept in sync by a MariaDB `EVENT` (GREATEST-merge every 1 minute, applied directly against the live `xidb` database — no LSB C++/rebuild involved). This requires enabling MariaDB's event scheduler via a one-line addition to the LSB stack's own `compose.yaml` (outside this repo), which means recreating the live database container. The dashboard's `GET /api/db/jobs` route then reads from the new table instead of `char_jobs`.

**Tech Stack:** MariaDB SQL (table + event), Docker Compose (infra flag), Express route (`src/routes/db.ts`).

## Global Constraints

- All backend fixes go in `src/routes/*.ts` — never the deprecated root `server.js`.
- Deploy the dashboard only via `npm run docker:build && docker compose up -d --force-recreate` (this project's own compose file, `/home/sora/Downloads/ffxi-dashboard/docker-compose.yml` — NOT the LSB stack's compose file).
- The LSB stack's own infrastructure (`/opt/stacks/ffxi/compose.yaml`, the `database`/`connect`/`world`/`map`/`search` containers) is a **separate, live production system**. Task 1 touches it directly. This must be done deliberately, with an explicit pause and confirmation immediately before recreating the `database` container — do not proceed through that step silently, even if the rest of the task is otherwise mechanical.
- `char_jobs_peak` seeds from `char_jobs`'s *current* values on first run — peaks lost to deaths before this feature ships are unrecoverable. This is a known, accepted limitation (see spec), not a defect to fix.

---

### Task 1: Database schema, MariaDB event, and event-scheduler infra change

**Files:**
- Create: `sql/char_jobs_peak.sql` (dashboard repo — applied manually against `xidb`, same pattern as `sql/dashboard_queue.sql`)
- Modify: `/opt/stacks/ffxi/compose.yaml` (LSB stack repo, NOT this dashboard repo — the `database` service's `command:` list)

**Interfaces:**
- Consumes: nothing from other tasks (this is the first task).
- Produces: the `char_jobs_peak` table (columns: `charid` + 22 job tinyint columns, identical names/order to `char_jobs`), which Task 2's SQL query reads from by name (`char_jobs_peak`).

This task is infrastructure/SQL work, not application code — there is no `npm test`/`build:all` step here. Verification is: confirm the event scheduler is on, confirm the event exists and has run at least once, confirm the table has rows matching `char_jobs`.

- [ ] **Step 1: Create the SQL migration file**

Create `sql/char_jobs_peak.sql`:

```sql
-- Historical per-job level-peak tracking.
-- char_jobs.<job> is LSB's *current standing* for a job (frozen when not
-- mained, and can DECREASE via exp-loss-on-death deleveling — see
-- docs/superpowers/specs/2026-07-11-jobs-max-level-history-design.md for
-- the full root-cause writeup). This table tracks a true historical max
-- that can only ever increase, kept in sync by the EVENT below.
--
-- Apply once against xidb:
--   mariadb -u xiadmin -p xidb < sql/char_jobs_peak.sql
--
-- Requires the MariaDB event scheduler to be ON (see compose.yaml change
-- in the same task — the event silently never runs if the scheduler is
-- off, it will not error).

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

- [ ] **Step 2: STOP — confirm before touching the live database container**

Before proceeding, state plainly to the user: "About to edit `/opt/stacks/ffxi/compose.yaml` to enable the event scheduler, then run `docker compose up -d database` against the live LSB stack, which recreates the `ffxi-database-1` container (brief DB reconnect blip for `connect`/`world`/`map`/`search` and any online players; the `ffxi-db` volume/data is untouched — only a startup flag changes)." Wait for explicit go-ahead before Step 3. This is a live production infrastructure change outside the dashboard's own deploy pipeline — do not proceed on the assumption that plan approval already covers this specific execution moment.

- [ ] **Step 3: Add `--event-scheduler=ON` to the database service and recreate the container**

Open `/opt/stacks/ffxi/compose.yaml`. Find this exact line (in the `database` service):

```yaml
    command: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_general_ci']
```

Replace it with:

```yaml
    command: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_general_ci', '--event-scheduler=ON']
```

Then, from `/opt/stacks/ffxi`:

```bash
docker compose up -d database
```

Expected: `Container ffxi-database-1  Recreated` / `Started`, and the healthcheck passes within ~10s (same healthcheck already defined for this service). Confirm with `docker ps` that `ffxi-database-1` is `Up` and `(healthy)`.

- [ ] **Step 4: Verify the event scheduler is actually on**

```bash
docker exec ffxi-database-1 mariadb -uxiadmin -pchangeme -N -e "SHOW VARIABLES LIKE 'event_scheduler';"
```

Expected output: `event_scheduler	ON` (was `OFF` before Step 3).

- [ ] **Step 5: Apply the SQL migration**

```bash
docker exec -i ffxi-database-1 mariadb -uxiadmin -pchangeme xidb < sql/char_jobs_peak.sql
```

Run from `/home/sora/Downloads/ffxi-dashboard` (or adjust the path to `sql/char_jobs_peak.sql`). Expected: no error output. If it errors with an `EVENT` privilege error (e.g. `Access denied; you need the EVENT privilege`), the `xiadmin` user needs the privilege granted first:

```bash
docker exec ffxi-database-1 mariadb -uroot -e "GRANT EVENT ON xidb.* TO 'xiadmin'@'%'; FLUSH PRIVILEGES;"
```

(If the root password is required and unknown, check `/opt/stacks/ffxi/compose.yaml`'s `dbcreds` anchor for the root credential, or ask the user — do not guess or brute-force credentials.) Then re-run the migration.

- [ ] **Step 6: Confirm the table exists and the event has run**

```bash
docker exec ffxi-database-1 mariadb -uxiadmin -pchangeme xidb -N -e "SELECT COUNT(*) FROM char_jobs_peak;"
```

Immediately after Step 5 this may be `0` (the event runs on its own 1-minute schedule, `STARTS CURRENT_TIMESTAMP` does not mean "immediately" — MariaDB events fire at the next scheduler tick after their start time, so allow up to ~60s). Wait up to 90 seconds, then re-run. Expected: count matches (or is close to) `SELECT COUNT(*) FROM char_jobs;` — every character with a `char_jobs` row should now have a `char_jobs_peak` row.

Also spot-check the seeded values match current standing (first-run behavior, per the spec's documented limitation):

```bash
docker exec ffxi-database-1 mariadb -uxiadmin -pchangeme xidb -N -e "SELECT cj.charid, cj.whm, cjp.whm FROM char_jobs cj JOIN char_jobs_peak cjp ON cjp.charid=cj.charid LIMIT 5;"
```

Expected: the two `whm` columns match for every row (peak == current, since this is the first sync).

- [ ] **Step 7: Commit the SQL migration file to the dashboard repo**

The `compose.yaml` change lives in the separate LSB stack repo at `/opt/stacks/ffxi` and is NOT part of this commit (out of scope for this repo's git history — note it in the commit body instead so the change is discoverable from here).

```bash
git add sql/char_jobs_peak.sql
git commit -m "$(cat <<'EOF'
sql: add char_jobs_peak table + sync event for true historical max level

char_jobs.<job> is LSB's current-standing value (can decrease via
exp-loss-on-death deleveling) — this table tracks a real historical
peak via a MariaDB EVENT (GREATEST-merge every 1 min), no LSB C++
changes needed. Also requires --event-scheduler=ON on the LSB stack's
database service (/opt/stacks/ffxi/compose.yaml, applied and verified
directly against the live database as part of this task — that repo
is outside this one's git history).
EOF
)"
```

---

### Task 2: Point `/api/db/jobs` at the new peak table

**Files:**
- Modify: `src/routes/db.ts` (the `GET /api/db/jobs` route, currently lines 486-497)

**Interfaces:**
- Consumes: `char_jobs_peak` (Task 1's output — same column names/types as `char_jobs`, so this is a pure table-name swap in the existing query, no new column mapping needed).
- Produces: nothing consumed by later tasks — this is the last task in this plan.

No new automated test — this is a one-word table-name swap in an existing, already-correct query (verified as spec-compliant in the design's Testing section: "No new pure logic to unit test"). Verification is live, against the real (now-tracking) data from Task 1.

- [ ] **Step 1: Swap the query's source table**

Open `src/routes/db.ts`. Find this exact block:

```ts
  router.get('/api/db/jobs', requireAuth, async (_req, res) => {
    try {
      // Aggregate in SQL instead of pulling every char_jobs row into Node.
      // "leveled" = above the level-1 default; MAX over only those rows.
      const sel = JOBS_LIST.map(j =>
        `MAX(CASE WHEN cj.${j} > 1 THEN cj.${j} ELSE 0 END) AS ${j}_max, SUM(cj.${j} > 1) AS ${j}_count`).join(', ');
      const [[r]] = await pool.execute<RowDataPacket[]>(
        `SELECT ${sel} FROM chars c JOIN char_jobs cj ON cj.charid = c.charid`);
      const stats = JOBS_LIST.map(job => ({
        job, max: Number(r?.[`${job}_max`] ?? 0), count: Number(r?.[`${job}_count`] ?? 0),
      }));
      res.json(stats);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
```

Replace it with (only the `FROM`/`JOIN` line changes — `char_jobs cj` becomes `char_jobs_peak cj`):

```ts
  router.get('/api/db/jobs', requireAuth, async (_req, res) => {
    try {
      // Aggregate in SQL instead of pulling every char_jobs_peak row into
      // Node. "leveled" = above the level-1 default; MAX over only those
      // rows. char_jobs_peak (not char_jobs) is used specifically because
      // char_jobs is LSB's live current-standing value and can decrease
      // via exp-loss-on-death deleveling — see
      // docs/superpowers/specs/2026-07-11-jobs-max-level-history-design.md.
      const sel = JOBS_LIST.map(j =>
        `MAX(CASE WHEN cj.${j} > 1 THEN cj.${j} ELSE 0 END) AS ${j}_max, SUM(cj.${j} > 1) AS ${j}_count`).join(', ');
      const [[r]] = await pool.execute<RowDataPacket[]>(
        `SELECT ${sel} FROM chars c JOIN char_jobs_peak cj ON cj.charid = c.charid`);
      const stats = JOBS_LIST.map(job => ({
        job, max: Number(r?.[`${job}_max`] ?? 0), count: Number(r?.[`${job}_count`] ?? 0),
      }));
      res.json(stats);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
```

- [ ] **Step 2: Type-check and build**

Run: `npm run build:all`
Expected: exit 0, no TypeScript errors (this is a string-literal change inside a template string — no type surface changes).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all existing tests still pass, same count as before this task (no new tests added — this route had no prior test file, and per the spec no new one is warranted for a table-name swap; confirm by checking the pre-task baseline count via `git stash` + `npm test` if unsure, then unstash).

- [ ] **Step 4: Deploy and verify live in the browser**

```bash
npm run docker:build
docker compose up -d --force-recreate
```

Then, using Playwright (headless chromium, login via `Sora`/`YourPassword1`, click "Database" then "Jobs" — this is an SPA, do not `page.goto()` a sub-route directly), verify:

1. The Jobs table renders with Max Level and Characters columns populated (non-error state).
2. Cross-check `GET /api/db/jobs` directly against `char_jobs_peak` (not `char_jobs`) — for at least one job with a nonzero max, confirm the reported `max` equals `SELECT MAX(<job>) FROM char_jobs_peak WHERE <job> > 1`.
3. **The concrete regression case that started this whole investigation:** pick a character and job, note the current `/api/db/jobs` max for that job. Force that character's `char_jobs.<job>` value down directly (simulating a delevel — e.g. `UPDATE char_jobs SET whm = 5 WHERE charid = 1` for a test character, NOT a real player's data, and only if you have a disposable/test character available; this project's memory notes "Sora" as a GM test character which may be safe to use, or ask the user which character is safe to use for this test). Wait for the sync event to run again if needed (peaks only increase, so lowering `char_jobs` should NOT lower `char_jobs_peak`), then confirm `GET /api/db/jobs` still reports the ORIGINAL (higher) max for that job, proving the fix actually survives a delevel — this is the exact bug the user reported.
4. Revert any test data mutation made in step 3 back to its original value once verified, to leave the database clean.

- [ ] **Step 5: Commit**

```bash
git add src/routes/db.ts
git commit -m "$(cat <<'EOF'
routes: read Jobs Max Level from char_jobs_peak, not char_jobs

char_jobs.<job> is LSB's live current-standing value and can decrease
via exp-loss-on-death deleveling (see charutils.cpp's
DelExperiencePoints), so MAX(char_jobs.<job>) could silently report a
lower number than a job's true historical peak. char_jobs_peak (added
in the prior commit, kept in sync by a MariaDB EVENT) only ever
increases — same column shape, so this is a pure table-name swap.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** the spec's two requirements (new `char_jobs_peak` table + sync event + event-scheduler infra enablement; dashboard route pointed at the new table) are covered by Task 1 and Task 2 respectively.
- **No placeholders:** all SQL/TypeScript/YAML blocks are complete and copy-pasteable, matching the spec's own SQL exactly and the verified current `db.ts` content (re-read via `Bash` immediately before writing this plan).
- **Type consistency:** N/A for Task 1 (pure SQL/infra). Task 2's change is a single string-literal edit inside an existing, unchanged-shape template string — no new types introduced.
- **Explicit human checkpoint:** Task 1 Step 2 is a hard stop before the live database container is touched, per the Global Constraints — this is the one step in this plan that must not be executed autonomously by an unattended subagent without a fresh confirmation at execution time, even though the design was already approved.
