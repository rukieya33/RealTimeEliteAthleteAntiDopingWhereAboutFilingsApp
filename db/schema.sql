-- =====================================================================
--  Real-Time Elite Athlete Anti-Doping Whereabouts Filings
--  MySQL 8 schema
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS whereabouts_failures;
DROP TABLE IF EXISTS filing_activities;
DROP TABLE IF EXISTS whereabouts_filings;
DROP TABLE IF EXISTS competition_entries;
DROP TABLE IF EXISTS competitions;
DROP TABLE IF EXISTS travel_bookings;
DROP TABLE IF EXISTS allowed_locations;
DROP TABLE IF EXISTS athletes;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

-- Agency staff who use the app ------------------------------------------
CREATE TABLE users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name     VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role          ENUM('admin','manager','viewer') NOT NULL DEFAULT 'manager',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL
) ENGINE=InnoDB;

-- Elite athletes represented by the agency -------------------------------
CREATE TABLE athletes (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  athlete_code   VARCHAR(20)  NOT NULL UNIQUE,
  first_name     VARCHAR(80)  NOT NULL,
  last_name      VARCHAR(80)  NOT NULL,
  gender         ENUM('Female','Male','Other') NOT NULL,
  date_of_birth  DATE         NULL,
  nationality    VARCHAR(80)  NOT NULL,
  sport          VARCHAR(80)  NOT NULL,
  discipline     VARCHAR(120) NULL,
  testing_pool   ENUM('RTP','TP','Other') NOT NULL DEFAULT 'RTP',
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40)  NULL,
  agent_name     VARCHAR(120) NULL,
  status         ENUM('Active','Injured','Retired','Suspended') NOT NULL DEFAULT 'Active',
  notes          TEXT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_athletes_sport (sport),
  INDEX idx_athletes_pool (testing_pool)
) ENGINE=InnoDB;

-- Locations each athlete is allowed to declare in a whereabouts filing ----
CREATE TABLE allowed_locations (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  athlete_id    INT UNSIGNED NOT NULL,
  label         VARCHAR(120) NOT NULL,
  location_type ENUM('Home','Training','Gym','Medical','Family','Hotel','Competition Venue','Training Camp','Other') NOT NULL,
  address_line  VARCHAR(190) NOT NULL,
  city          VARCHAR(100) NOT NULL,
  region        VARCHAR(100) NULL,
  country       VARCHAR(80)  NOT NULL,
  postcode      VARCHAR(20)  NULL,
  access_notes  VARCHAR(255) NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_loc_athlete FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  INDEX idx_loc_athlete (athlete_id, is_active)
) ENGINE=InnoDB;

-- Competitions (with made-up venues) ------------------------------------
CREATE TABLE competitions (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                  VARCHAR(160) NOT NULL,
  sport                 VARCHAR(80)  NOT NULL,
  level                 ENUM('International','Continental','National','Invitational') NOT NULL DEFAULT 'International',
  venue                 VARCHAR(160) NOT NULL,
  competition_location  VARCHAR(160) NOT NULL,   -- "City, Country"
  city                  VARCHAR(100) NOT NULL,
  country               VARCHAR(80)  NOT NULL,
  start_date            DATE NOT NULL,
  end_date              DATE NOT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_comp_dates (start_date, end_date)
) ENGINE=InnoDB;

CREATE TABLE competition_entries (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  competition_id  INT UNSIGNED NOT NULL,
  athlete_id      INT UNSIGNED NOT NULL,
  event_name      VARCHAR(120) NULL,
  entry_status    ENUM('Entered','Confirmed','Withdrawn') NOT NULL DEFAULT 'Confirmed',
  CONSTRAINT fk_entry_comp FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  CONSTRAINT fk_entry_athlete FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_entry (competition_id, athlete_id)
) ENGINE=InnoDB;

-- Travel bookings (with made-up travel booking locations) ----------------
CREATE TABLE travel_bookings (
  id                       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  athlete_id               INT UNSIGNED NOT NULL,
  competition_id           INT UNSIGNED NULL,
  booking_ref              VARCHAR(20)  NOT NULL UNIQUE,
  travel_type              ENUM('Flight','Train','Car','Ferry','Coach') NOT NULL,
  carrier                  VARCHAR(100) NULL,
  travel_booking_location  VARCHAR(160) NOT NULL,   -- destination "City, Country"
  origin                   VARCHAR(160) NOT NULL,
  destination_city         VARCHAR(100) NOT NULL,
  depart_at                DATETIME NOT NULL,
  arrive_at                DATETIME NOT NULL,
  accommodation            VARCHAR(190) NULL,
  status                   ENUM('Booked','Confirmed','Completed','Cancelled') NOT NULL DEFAULT 'Confirmed',
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_travel_athlete FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  CONSTRAINT fk_travel_comp FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE SET NULL,
  INDEX idx_travel_dates (athlete_id, depart_at, arrive_at)
) ENGINE=InnoDB;

-- Daily whereabouts filings ----------------------------------------------
-- One filing per athlete per day: an overnight address and a 60-minute
-- testing slot (05:00–23:00), plus regular activities for that day.
CREATE TABLE whereabouts_filings (
  id                     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  athlete_id             INT UNSIGNED NOT NULL,
  filing_date            DATE NOT NULL,
  overnight_location_id  INT UNSIGNED NOT NULL,
  slot_start             TIME NOT NULL,
  slot_end               TIME NOT NULL,
  slot_location_id       INT UNSIGNED NOT NULL,
  notes                  VARCHAR(255) NULL,
  source                 ENUM('Quarterly','Update','Seed','Import') NOT NULL DEFAULT 'Quarterly',
  version                INT UNSIGNED NOT NULL DEFAULT 1,
  submitted_by           INT UNSIGNED NULL,
  submitted_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_filing_athlete FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  CONSTRAINT fk_filing_overnight FOREIGN KEY (overnight_location_id) REFERENCES allowed_locations(id),
  CONSTRAINT fk_filing_slot FOREIGN KEY (slot_location_id) REFERENCES allowed_locations(id),
  CONSTRAINT fk_filing_user FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_filing_day (athlete_id, filing_date),
  INDEX idx_filing_date (filing_date)
) ENGINE=InnoDB;

CREATE TABLE filing_activities (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  filing_id      INT UNSIGNED NOT NULL,
  activity_type  ENUM('Training','Competition','Gym','Medical','Work','Study','Travel','Other') NOT NULL,
  location_id    INT UNSIGNED NOT NULL,
  start_time     TIME NOT NULL,
  end_time       TIME NOT NULL,
  description    VARCHAR(190) NULL,
  CONSTRAINT fk_act_filing FOREIGN KEY (filing_id) REFERENCES whereabouts_filings(id) ON DELETE CASCADE,
  CONSTRAINT fk_act_location FOREIGN KEY (location_id) REFERENCES allowed_locations(id),
  INDEX idx_act_filing (filing_id)
) ENGINE=InnoDB;

-- Recorded whereabouts failures (filing failures and missed tests) --------
CREATE TABLE whereabouts_failures (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  athlete_id     INT UNSIGNED NOT NULL,
  failure_type   ENUM('Filing Failure','Missed Test') NOT NULL,
  incident_date  DATE NOT NULL,
  description    VARCHAR(255) NULL,
  status         ENUM('Under Review','Confirmed','Dismissed') NOT NULL DEFAULT 'Under Review',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fail_athlete FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  INDEX idx_fail_athlete (athlete_id, incident_date)
) ENGINE=InnoDB;

-- Audit trail that also feeds the live activity stream --------------------
CREATE TABLE audit_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NULL,
  user_name   VARCHAR(120) NULL,
  action      VARCHAR(40)  NOT NULL,
  entity      VARCHAR(40)  NOT NULL,
  entity_id   INT UNSIGNED NULL,
  athlete_id  INT UNSIGNED NULL,
  summary     VARCHAR(255) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;
