-- ============================================================
-- Supabase Seed Data
-- ============================================================
-- This file contains sample data for development and testing
-- It will be loaded automatically when running `supabase db reset`

-- Insert sample users
INSERT INTO users (name, email) VALUES 
  ('John Doe', 'john@example.com'),
  ('Jane Smith', 'jane@example.com')
ON CONFLICT (email) DO NOTHING;

-- Insert sample profiles
INSERT INTO profiles (user_id, name, keywords, location, additional_context, resume) VALUES 
  (1, 'default', '{"Software","Engineer"}', '105149290', 'Software Engineer', 'John Doe Resume'),
  (1, 'Product Manager Profile', '{"Product","Manager"}', '105149290', 'Product Manager', 'John Doe Resume'),
  (2, 'default', '{"Software","Engineer"}', '101174742', 'Software Engineer', 'Jane Smith Resume')
ON CONFLICT (user_id, name) DO NOTHING;
