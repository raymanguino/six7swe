import { ContextUser } from './types/user';

export const INPUT_LIMITS = {
  jobDescription: 50000,
  chatMessage: 2000,
} as const;

export const UnauthenticatedUser: ContextUser = { 
  id: 'some-unauthenticated-id', 
  email: 'some-unauthenticated-email@67swe.com',
};
