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
    -- Target-table columns must be fully qualified (char_jobs_peak.<col>)
    -- inside GREATEST(): a bare column name here is ambiguous between the
    -- INSERT target and the char_jobs source table still in scope from
    -- the SELECT clause (confirmed via MariaDB error 1052 "Column 'war'
    -- in UPDATE is ambiguous" when this was first written without the
    -- qualification — the event silently failed every run, logged only
    -- to the server's own error log, not surfaced by `mariadb < file.sql`
    -- at apply time since CREATE EVENT itself succeeds either way).
    war=GREATEST(char_jobs_peak.war,VALUES(war)), mnk=GREATEST(char_jobs_peak.mnk,VALUES(mnk)),
    whm=GREATEST(char_jobs_peak.whm,VALUES(whm)), blm=GREATEST(char_jobs_peak.blm,VALUES(blm)),
    rdm=GREATEST(char_jobs_peak.rdm,VALUES(rdm)), thf=GREATEST(char_jobs_peak.thf,VALUES(thf)),
    pld=GREATEST(char_jobs_peak.pld,VALUES(pld)), drk=GREATEST(char_jobs_peak.drk,VALUES(drk)),
    bst=GREATEST(char_jobs_peak.bst,VALUES(bst)), brd=GREATEST(char_jobs_peak.brd,VALUES(brd)),
    rng=GREATEST(char_jobs_peak.rng,VALUES(rng)), sam=GREATEST(char_jobs_peak.sam,VALUES(sam)),
    nin=GREATEST(char_jobs_peak.nin,VALUES(nin)), drg=GREATEST(char_jobs_peak.drg,VALUES(drg)),
    smn=GREATEST(char_jobs_peak.smn,VALUES(smn)), blu=GREATEST(char_jobs_peak.blu,VALUES(blu)),
    cor=GREATEST(char_jobs_peak.cor,VALUES(cor)), pup=GREATEST(char_jobs_peak.pup,VALUES(pup)),
    dnc=GREATEST(char_jobs_peak.dnc,VALUES(dnc)), sch=GREATEST(char_jobs_peak.sch,VALUES(sch)),
    geo=GREATEST(char_jobs_peak.geo,VALUES(geo)), run=GREATEST(char_jobs_peak.run,VALUES(run));
END$$
DELIMITER ;
