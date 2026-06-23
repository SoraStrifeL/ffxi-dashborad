-- Dashboard edit queue.
-- Apply once against xidb:
--   mariadb -u xiadmin -p xidb < sql/dashboard_queue.sql

CREATE TABLE IF NOT EXISTS `dashboard_queue` (
  `id`           INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  `charid`       INT UNSIGNED     NOT NULL,
  `action`       VARCHAR(32)      NOT NULL,
  `params`       TEXT             NOT NULL DEFAULT '',
  `requested_by` VARCHAR(64)      NOT NULL DEFAULT 'system',
  `status`       ENUM('pending','done','error','deferred')
                                  NOT NULL DEFAULT 'pending',
  `result`       TEXT             NOT NULL DEFAULT '',
  `created_at`   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processed_at` TIMESTAMP        NULL     DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_charid_status` (`charid`, `status`),
  KEY `idx_status`        (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
