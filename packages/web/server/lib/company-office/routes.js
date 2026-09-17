export const registerCompanyOfficeRoutes = (app, service) => {
  app.get('/api/company-office/snapshot', async (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.getSnapshot());
    } catch (error) {
      const notConfigured = error?.code === 'NOT_CONFIGURED';
      res.status(notConfigured ? 404 : 503).json({
        error: notConfigured ? 'company_office_not_configured' : 'company_office_unavailable',
      });
    }
  });
};
