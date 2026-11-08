import Fastify, { FastifyInstance } from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../../constants';
import { createProfileHandler, updateProfileHandler } from '../../routes/handlers/profileHandlers';
import type { Profile } from '../../db/schema/jobHunt';

/**
 * Verifies the profile write boundary.
 *
 * `profiles.location` is a LinkedIn numeric region id, not a display string.
 * Accepting a city name here would let a profile be saved and then fail
 * during a refresh, so the id is validated when the profile is written.
 */
describe('profile geo id validation', () => {
  let app: FastifyInstance;
  let createProfile: jest.Mock;
  let updateProfile: jest.Mock;

  const profile: Profile = {
    id: 1,
    userId: 1,
    name: 'default',
    keywords: ['Engineer'],
    location: '105149290',
    additionalContext: null,
    resume: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    createProfile = jest.fn().mockResolvedValue(profile);
    updateProfile = jest.fn().mockResolvedValue(profile);

    app = Fastify();
    await app.register(fastifyRequestContext, {
      defaultStoreValues: { user: UnauthenticatedUser },
    });

    app.addHook('onRequest', async () => {
      requestContext.set('user', { id: 1, email: 'john@example.com' });
    });

    app.decorate('profileService', {
      createProfile,
      updateProfile,
      getProfileForUser: jest.fn().mockResolvedValue(profile),
    } as never);

    app.post('/job-hunt/profiles', createProfileHandler);
    app.patch('/job-hunt/profiles/:profileId', updateProfileHandler);
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a numeric region id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/job-hunt/profiles',
      payload: { name: 'default', keywords: ['Engineer'], location: '105149290' },
    });

    expect(response.statusCode).toBe(201);
    expect(createProfile).toHaveBeenCalled();
  });

  it('rejects a city name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/job-hunt/profiles',
      payload: { name: 'default', keywords: ['Engineer'], location: 'Toronto, Ontario' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().details.location).toBeDefined();
    expect(createProfile).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric value', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/job-hunt/profiles',
      payload: { name: 'default', keywords: ['Engineer'], location: 'abc123' },
    });

    expect(response.statusCode).toBe(400);
    expect(createProfile).not.toHaveBeenCalled();
  });

  it('allows a profile with no location at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/job-hunt/profiles',
      payload: { name: 'default', keywords: ['Engineer'] },
    });

    expect(response.statusCode).toBe(201);
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({ location: null }),
    );
  });

  it('rejects a city name on update', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/job-hunt/profiles/1',
      payload: { location: 'Toronto' },
    });

    expect(response.statusCode).toBe(400);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('trims a padded numeric id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/job-hunt/profiles',
      payload: { name: 'default', keywords: ['Engineer'], location: '  105149290  ' },
    });

    expect(response.statusCode).toBe(201);
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({ location: '105149290' }),
    );
  });
});
