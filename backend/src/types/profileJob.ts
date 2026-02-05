export type ProfileJob = {
  id: number;
  profile_id: number;
  job_id: number;
  job_hash: string;
  score: string;
  explanation: string;
  first_skill_match: string;
  second_skill_match: string;
  third_skill_match: string;
  summary: string;
  created_at: Date;
  updated_at: Date;
}
