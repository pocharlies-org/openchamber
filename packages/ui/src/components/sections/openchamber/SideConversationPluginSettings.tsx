import React from 'react';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isUIPluginEnabled, useUIPluginsStore } from '@/stores/useUIPluginsStore';

const SIDE_CHAT_PLUGIN_ID = '@pocharlies/openchamber-side-chat';

export const SideConversationPluginSettings: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const catalog = useUIPluginsStore((state) => state.catalog);
  const enabled = useUIPluginsStore((state) => isUIPluginEnabled(state, SIDE_CHAT_PLUGIN_ID));
  const loadError = useUIPluginsStore((state) => state.loadError);
  const setPluginEnabled = useUIPluginsStore((state) => state.setPluginEnabled);
  const pluginAvailable = catalog.some((plugin) => plugin.id === SIDE_CHAT_PLUGIN_ID);

  if (isMobile || isVSCodeRuntime() || !pluginAvailable) return null;

  return (
    <SettingsSection
      title={t('settings.chat.uiPlugins.section')}
      info={t('settings.chat.uiPlugins.sectionInfo')}
      settingsItem="chat.ui-plugins"
    >
      <SettingsCheckboxRow
        checked={enabled}
        onChange={(next) => setPluginEnabled(SIDE_CHAT_PLUGIN_ID, next)}
        label={t('settings.chat.uiPlugins.sideChat.label')}
        ariaLabel={t('settings.chat.uiPlugins.sideChat.aria')}
        info={t('settings.chat.uiPlugins.sideChat.info')}
        settingsItem="chat.ui-plugins.side-chat"
      />
      {loadError ? (
        <p role="status" className="typography-meta mt-2 text-[var(--status-warning)]">
          {t('settings.chat.uiPlugins.catalogUnavailable')}
        </p>
      ) : null}
    </SettingsSection>
  );
};
