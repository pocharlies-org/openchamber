import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { registerCompanyOfficeRoutes } from './routes.js';

describe('Company Office routes', () => {
  test('returns an authenticated-runtime snapshot without cache persistence', async () => {
    const app = express();
    registerCompanyOfficeRoutes(app, { getSnapshot: async () => ({ schemaVersion: 1, company: { id: 'example-company' } }) });
    const response = await request(app).get('/api/company-office/snapshot').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.company.id).toBe('example-company');
  });

  test('keeps unavailable distinct from a valid empty snapshot', async () => {
    const app = express();
    registerCompanyOfficeRoutes(app, { getSnapshot: async () => { throw new Error('offline'); } });
    const response = await request(app).get('/api/company-office/snapshot').expect(503);
    expect(response.body).toEqual({ error: 'company_office_unavailable' });
  });
});
