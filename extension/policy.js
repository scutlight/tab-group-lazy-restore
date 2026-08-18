export const SETTINGS_VERSION = 4;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  collapseGroups: true,
  discardInactiveTabs: true,
  includeUngrouped: true,
  keepPinned: false,
  keepAudible: false
});

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

export function normalizeSettings(value = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).map(([key, defaultValue]) => [
      key,
      typeof value[key] === "boolean" ? value[key] : defaultValue
    ])
  );
}

export function migrateSettings(value = {}) {
  if (value.settingsVersion === SETTINGS_VERSION) return normalizeSettings(value);

  // V4 changes the default contract to "only the current tab stays loaded".
  // Preserve old general preferences, but adopt the new pinned/audio defaults.
  return normalizeSettings({
    enabled: value.enabled,
    collapseGroups: value.collapseGroups,
    discardInactiveTabs: value.discardInactiveTabs,
    includeUngrouped: value.includeUngrouped,
    keepPinned: false,
    keepAudible: false
  });
}

export function isDiscardEligible(tab, rawSettings = {}) {
  const settings = normalizeSettings(rawSettings);
  if (!Number.isInteger(tab?.id) || tab.active || tab.discarded) return false;
  if (!hasCommittedWebPage(tab)) return false;
  if (!settings.includeUngrouped && tab.groupId < 0) return false;
  if (settings.keepPinned && tab.pinned) return false;
  if (settings.keepAudible && tab.audible) return false;
  return true;
}

export function hasCommittedWebPage(tab) {
  if (tab?.status !== "complete") return false;
  if (typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0) return false;
  if (typeof tab?.url !== "string" || tab.url.length === 0) return false;
  try {
    const protocol = new URL(tab.url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function buildRestorePlan(tabs, groups, rawSettings = {}) {
  const settings = normalizeSettings(rawSettings);
  const activeGroupIds = new Set(
    tabs
      .filter((tab) => tab.active && Number.isInteger(tab.groupId) && tab.groupId >= 0)
      .map((tab) => tab.groupId)
  );

  const collapseGroupIds = settings.collapseGroups
    ? groups
        .filter((group) => !activeGroupIds.has(group.id) && !group.collapsed)
        .map((group) => group.id)
    : [];

  const expandGroupIds = settings.collapseGroups
    ? groups
        .filter((group) => activeGroupIds.has(group.id) && group.collapsed)
        .map((group) => group.id)
    : [];

  const discardTabIds = settings.discardInactiveTabs
    ? tabs.filter((tab) => isDiscardEligible(tab, settings)).map((tab) => tab.id)
    : [];

  return { collapseGroupIds, expandGroupIds, discardTabIds };
}
