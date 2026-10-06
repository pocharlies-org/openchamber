import { toast } from '@/components/ui';
import { describeRewindFiles, rewindClaudeCode } from '@/lib/claudeRewind';
import type { useI18n } from '@/lib/i18n';

type Translate = ReturnType<typeof useI18n>['t'];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * "Rewind code to here" on a prompt of a Claude Code session: preview what
 * would change, then rewind only once the user confirms from the toast.
 */
export const runClaudeRewind = async (sessionId: string, messageId: string, t: Translate): Promise<void> => {
  let preview;
  try {
    preview = await rewindClaudeCode(sessionId, messageId, { dryRun: true });
  } catch (error) {
    toast.error(t('chat.claudeRewind.failed'), { description: errorText(error) });
    return;
  }
  if (!preview.canRewind || preview.filesChanged.length === 0) {
    toast.info(t('chat.claudeRewind.nothing'), preview.error ? { description: preview.error } : undefined);
    return;
  }
  toast.warning(t('chat.claudeRewind.confirmTitle', { count: preview.filesChanged.length }), {
    description: t('chat.claudeRewind.confirmDescription', {
      files: describeRewindFiles(preview.filesChanged),
      insertions: preview.insertions,
      deletions: preview.deletions,
    }),
    action: {
      label: t('chat.claudeRewind.apply'),
      onClick: () => {
        void rewindClaudeCode(sessionId, messageId, { dryRun: false }).then(
          (result) => {
            if (result.canRewind) toast.success(t('chat.claudeRewind.done', { count: result.filesChanged.length }));
            else toast.error(t('chat.claudeRewind.failed'), result.error ? { description: result.error } : undefined);
          },
          (error: unknown) => toast.error(t('chat.claudeRewind.failed'), { description: errorText(error) }),
        );
      },
    },
  });
};
