export type User = {
  id: string;
  name: string;
  email: string;
  created_at: Date;
  updated_at: Date;
};

export type ContextUser = Omit<User, 'name' | 'created_at' | 'updated_at'>;
