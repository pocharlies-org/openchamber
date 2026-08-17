import { buildGhostPrompt, createGhostContextStore, projectGhostTurns } from './context.js';

export function registerComposerGhostRoutes(app, {
  getComposerGhostService,
  validateDirectoryPath,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
}) {
  let contextStore;
  app.post('/api/composer/ghost', async (req, res) => {
    try {
      const { generateComposerGhost } = await getComposerGhostService();
      contextStore ||= createGhostContextStore();
      const requestedDirectory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      let directory;
      if (requestedDirectory) {
        const validated = await validateDirectoryPath(requestedDirectory);
        if (!validated.ok) {
          return res.status(400).json({ error: validated.error });
        }
        directory = validated.directory;
      }

      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const draft = typeof req.body?.draft === 'string' ? req.body.draft : '';
      const historyUrl = new URL(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, ''));
      if (directory) historyUrl.searchParams.set('directory', directory);
      const historyResponse = await fetch(historyUrl, {
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(10000),
      });
      if (!historyResponse.ok) {
        const error = new Error(`OpenCode session messages failed with ${historyResponse.status}`);
        error.statusCode = 502;
        throw error;
      }
      const history = await historyResponse.json();
      const reconciled = contextStore.reconcile({
        sessionId,
        directory,
        turns: projectGhostTurns(history),
      });
      if (!reconciled) return res.status(409).json({ error: 'Session has no user message yet' });
      const prompt = buildGhostPrompt(reconciled.state, draft);
      const completionKey = `${prompt.prefixHash}:${draft}`;
      const promptMetadata = {
        prefixHash: prompt.prefixHash,
        prefixBytes: prompt.prefixBytes,
        generation: prompt.generation,
        turnCount: prompt.turnCount,
        prefixChanged: reconciled.changed,
      };
      const cachedResult = contextStore.getCompletion(sessionId, directory, completionKey);
      if (cachedResult) {
        return res.json({ ...cachedResult, ...promptMetadata });
      }

      const result = await contextStore.getOrCreateCompletion(sessionId, directory, completionKey, () => (
        generateComposerGhost({
          directory,
          messages: prompt.messages,
          promptCacheKey: prompt.promptCacheKey,
        })
      ));
      res.json({
        ...result,
        ...promptMetadata,
      });
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
