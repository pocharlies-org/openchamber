/**
 * HTTP surface for updating this fork through the pipeline.
 *
 * The dispatch route is the one that replaces `npm install`. It is gated on an
 * explicit confirmation in the body: a green pipeline ends in a deploy, so a
 * stray request — a prefetch, a scripted click, a link — must not be able to
 * roll production forward. UI visibility is not authorization.
 */
import {
  dispatchForkUpdate,
  getForkUpdateStatus,
  readDispatchRequest,
  readRunIdParam,
  FORK_UPDATE_WORKFLOW,
  PIPELINE_REPO,
} from './pipeline.js';

export const registerForkUpdateRoutes = (app, dependencies = {}) => {
  const fetchImpl = dependencies.fetchImpl;
  // No JSON body parser is mounted globally, because the OpenCode proxy needs
  // the raw stream. This route reads its own, the way the Linear routes do.
  const parseJsonBody = dependencies.express.json({ limit: '16kb' });

  app.post('/api/openchamber/fork-update/dispatch', parseJsonBody, async (req, res) => {
    const request = readDispatchRequest(req.body);
    if (!request.confirm) {
      return res.status(400).json({
        started: false,
        reason: 'confirmation-required',
        error: 'Updating runs the fork pipeline and deploys when it turns green. Send confirm: true to proceed.',
      });
    }

    const result = await dispatchForkUpdate({ fetchImpl, tokenOverride: dependencies.tokenOverride, ref: request.ref });
    if (!result.started) {
      const hints = {
        'no-credential': 'This machine has no GitHub credential. Sign in to GitHub in Settings, or install and authenticate the gh CLI.',
        'workflow-not-found': `The pipeline has no ${FORK_UPDATE_WORKFLOW} in ${PIPELINE_REPO}.`,
        'not-authorized': 'The GitHub credential on this machine cannot start workflows in the pipeline repository.',
        unreachable: 'The pipeline could not be reached. Nothing was started.',
      };
      return res.status(result.reason === 'unreachable' ? 502 : 409).json({
        ...result,
        error: hints[result.reason] || result.detail || 'The pipeline refused the update.',
      });
    }

    return res.status(202).json({ started: true });
  });

  app.get('/api/openchamber/fork-update/status', async (req, res) => {
    const status = await getForkUpdateStatus({
      fetchImpl,
      tokenOverride: dependencies.tokenOverride,
      runId: readRunIdParam(req.query.runId),
    });
    return res.json(status);
  });
};
