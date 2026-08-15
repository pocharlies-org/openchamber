export function registerComposerGhostRoutes(app, { getComposerGhostService, resolveOptionalProjectDirectory }) {
  app.post('/api/composer/ghost', async (req, res) => {
    try {
      const { generateComposerGhost } = await getComposerGhostService();
      const directory = typeof req.body?.directory === 'string' && req.body.directory
        ? (resolveOptionalProjectDirectory?.(req.body.directory) ?? req.body.directory)
        : undefined;

      const result = await generateComposerGhost({
        directory,
        messages: req.body?.messages,
        model: req.body?.model,
        maxCompletionTokens: req.body?.maxCompletionTokens,
        promptCacheKey: req.body?.promptCacheKey,
      });
      res.json(result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      // 429 is routine on a shared plan and 501 means the user simply has no
      // compatible endpoint configured — neither deserves a server log.
      if (statusCode >= 500 && statusCode !== 501) {
        console.error('Composer ghost completion failed:', error);
      }
      res.status(statusCode).json({
        error: error.message || 'Composer ghost completion failed',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
  });
}
