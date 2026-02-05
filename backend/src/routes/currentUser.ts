import { requestContext } from '@fastify/request-context';
import { ContextUser } from '../types/user';
import { UnauthenticatedUser } from '.././constants';

export const getCurrentUser = (): ContextUser => {
  return requestContext.get('user') || UnauthenticatedUser;
}

export const isAuthenticated = (): boolean => {
  const user = getCurrentUser();
  return user !== UnauthenticatedUser;
}

export const requireAuth = (): void => {
  if (!isAuthenticated()) {
    throw new Error('User is not authenticated');
  }
}
