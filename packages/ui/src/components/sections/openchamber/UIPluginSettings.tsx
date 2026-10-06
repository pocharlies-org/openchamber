import React from 'react';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isUIPluginEnabled, useUIPluginsStore } from '@/stores/useUIPluginsStore';

const STREAM_METRICS_PLUGIN_ID = '@pocharlies/openchamber-stream-metrics';

export const UIPluginSettings: React.FC = () => {
  const { t } = useI18n();
  const catalog = useUIPluginsStore((state) => state.catalog);
  const streamMetricsEnabled = useUIPluginsStore((state) => isUIPluginEnabled(state, STREAM_METRICS_PLUGIN_ID));
  const loadError = useUIPluginsStore((state) => state.loadError);
  const setPluginEnabled = useUIPluginsStore((state) => state.setPluginEnabled);
  const streamMetricsAvailable = catalog.some((plugin) => plugin.id === STREAM_METRICS_PLUGIN_ID);

  if (isVSCodeRuntime() || !streamMetricsAvailable) return null;

  return (
    <SettingsSection
      title={t('settings.chat.uiPlugins.section')}
      info={t('settings.chat.uiPlugins.sectionInfo')}
      settingsItem="chat.ui-plugins"
    >
      {streamMetricsAvailable ? (
        <SettingsCheckboxRow
          checked={streamMetricsEnabled}
          onChange={(next) => setPluginEnabled(STREAM_METRICS_PLUGIN_ID, next)}
          label={t('settings.chat.uiPlugins.streamMetrics.label')}
          ariaLabel={t('settings.chat.uiPlugins.streamMetrics.aria')}
          info={t('settings.chat.uiPlugins.streamMetrics.info')}
          settingsItem="chat.ui-plugins.stream-metrics"
        />
      ) : null}
      {loadError ? (
        <p role="status" className="typography-meta mt-2 text-[var(--status-warning)]">
          {t('settings.chat.uiPlugins.catalogUnavailable')}
        </p>
      ) : null}
    </SettingsSection>
  );
};
