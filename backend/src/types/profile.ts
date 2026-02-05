export type Profile = {
  id: number;
  userId: number;
  name: string;
  keywords: string[];
  location: string;
  resume: string
  additionalContext: string;
  created_at: Date;
  updated_at: Date;
}
