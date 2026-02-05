-- Destroy ---------------------------------------------
--------------------------------------------------------

-- drop indexes
DROP INDEX IF EXISTS idx_profiles_user_name_lookup;
DROP INDEX IF EXISTS idx_profiles_user_location_lookup;
DROP INDEX IF EXISTS idx_jobs_source_job_lookup;

-- drop tables
DROP TABLE IF EXISTS refresh_status;
DROP TABLE IF EXISTS profile_jobs;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS users;

-- drop types
DROP TYPE IF EXISTS job_source;
DROP TYPE IF EXISTS job_fetch_status;
DROP TYPE IF EXISTS job_fetch_status_step;
DROP TYPE IF EXISTS match_score;
DROP TYPE IF EXISTS refresh_update_status;
DROP TYPE IF EXISTS refresh_update_status_step;

-- Create ----------------------------------------------
--------------------------------------------------------

-- Create tables and types
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  keywords VARCHAR(255)[],
  location VARCHAR(255),
  additional_context TEXT,
  resume TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE TYPE job_source AS ENUM (
  'LINKEDIN',
  'INDEED',
  'GLASSDOOR',
  'COMPANY_WEBSITE',
  'OTHER'
);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  source_id job_source DEFAULT 'LINKEDIN',
  source_job_id VARCHAR(255) NOT NULL,
  link VARCHAR(512) NOT NULL,
  company VARCHAR(255) NOT NULL,
  position VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(source_id, source_job_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_source_job_lookup ON jobs(source_id, source_job_id);

CREATE TYPE refresh_update_status AS ENUM (
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED'
);

CREATE TYPE refresh_update_status_step AS ENUM (
  'PENDING',
  'FETCHING_JOBS',
  'FILTERING_JOBS'
);

CREATE TABLE IF NOT EXISTS refresh_status (
  id SERIAL PRIMARY KEY,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  status refresh_update_status DEFAULT 'PENDING',
  step refresh_update_status_step DEFAULT 'PENDING',
  description VARCHAR(512),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TYPE match_score AS ENUM (
  'LOW',
  'MEDIUM',
  'HIGH',
  'TOP'
);

CREATE TABLE IF NOT EXISTS profile_jobs (
  id SERIAL PRIMARY KEY,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  job_hash VARCHAR(64) NOT NULL,
  score match_score,
  explanation TEXT,
  first_skill_match TEXT,
  second_skill_match TEXT,
  third_skill_match TEXT,
  summary TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(profile_id, job_id)
);

-- Insert sample data --------------------------------
------------------------------------------------------
INSERT INTO users (name, email) VALUES 
  ('John Doe', 'john@example.com'),
  ('Jane Smith', 'jane@example.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO profiles (user_id, name, keywords, location, additional_context, resume) VALUES 
  (1, 'default', '{"Software","Engineer"}', '105149290', 'Software Engineer', 'John Doe Resume'),
  (1, 'Product Manager Profile', '{"Product","Manager"}', '105149290', 'Product Manager', 'John Doe Resume'),
  (2, 'default', '{"Software","Engineer"}', '101174742', 'Software Engineer', 'Jane Smith Resume')