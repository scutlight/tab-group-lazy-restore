import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  buildRestorePlan,
  isDiscardEligible,
  migrateSettings,
  normalizeSettings
} from "./policy.js";

const STARTUP_WINDOW_MS = 60_000;
const STARTUP_PASS_DELAYS_MS = [250, 1_000, 3_000, 8_000, 15_000, 30_000, 45_000];
const STARTUP_DISCARD_NOT_BEFORE_MS = 30_000;
const STARTUP_TOPOLOGY_STABLE_MS = 10_000;
const STARTUP_ALARM_PREFIX = "lazy-restore-v4-startup:";
const STARTUP_RUN_KEY = "startupRunV4";
const STARTUP_PROGRESS_KEY = "startupProgressV4";
const STARTUP_STABILITY_KEY = "startupStabilityV4";
const STARTUP_GROUP_STATE_KEY = "startupGroupStateV4";
const STARTUP_ACTIVE_RESTORE_KEY = "startupActiveRestoreV4";
const LAST_RUN_KEY = "lastRunV4";
const ACTIVE_MARKERS_KEY = "activeMarkersV4";
const BROWSER_SESSION_READY_KEY = "browserSessionReadyV4";
const ACTIVE_RESTORE_WINDOW_MS = 15_000;
const MAX_RECORDED_ERRORS = 5;
const MAX_WORKERS = 4;
const LEGACY_RECORD_PREFIX = "suspended-record-";
const LEGACY_STATUS_PREFIXES = ["recovery-v", "repair-"];
const OBSOLETE_STATE_KEYS = new Set(["v4-missing-tabs-recovery-status"]);

let executionQueue = Promise.resolve();
let startupSweepTimer;

chrome.runtime.onInstalled.addListener((details) => {
  void handleInstalled(details).catch((error) => recordFatalStatus("install", error));
});

chrome.runtime.onStartup.addListener(() => {
  void startStartupRestore().catch((error) => recordFatalStatus("startup", error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(STARTUP_ALARM_PREFIX)) return;
  const alarmSuffix = alarm.name.slice(STARTUP_ALARM_PREFIX.length);
  const runId = alarmSuffix.slice(0, alarmSuffix.lastIndexOf(":"));
  void enqueueStartupPass(runId).catch(() => undefined);
});

chrome.tabs.onCreated.addListener(() => scheduleStartupSweep());
chrome.windows.onCreated.addListener(() => scheduleStartupSweep());
chrome.tabGroups.onCreated.addListener(() => scheduleStartupSweep());
chrome.tabs.onMoved.addListener(() => scheduleStartupSweep());
chrome.tabs.onAttached.addListener(() => scheduleStartupSweep());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "loading" || Number.isInteger(changeInfo.groupId)) {
    scheduleStartupSweep();
  }
});
chrome.tabs.onActivated.addListener((activeInfo) => {
  scheduleStartupSweep();
  void recordActivatedTab(activeInfo).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "get-state") {
    void getPublicState()
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "save-settings") {
    void saveSettings(message.settings)
      .then((settings) => sendResponse({ settings }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "optimize-now") {
    const windowId = Number.isInteger(message.windowId)
      ? message.windowId
      : chrome.windows.WINDOW_ID_CURRENT;
    void enqueueRun({ trigger: "manual", runId: makeRunId(), windowId })
      .then((lastRun) => sendResponse({ lastRun }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

async function handleInstalled(_details) {
  await initializeSettings();
  await clearStartupAlarms();
  await chrome.storage.session.remove([
    STARTUP_RUN_KEY,
    STARTUP_PROGRESS_KEY,
    STARTUP_STABILITY_KEY,
    STARTUP_GROUP_STATE_KEY,
    STARTUP_ACTIVE_RESTORE_KEY
  ]);
  await chrome.action.setBadgeText({ text: "" });
  await cleanLegacyStateIfSafe();
  await captureCurrentActiveMarkers();
  await chrome.storage.session.set({ [BROWSER_SESSION_READY_KEY]: true });
  // Deliberately do not call the optimizer here. Reloading an unpacked
  // extension fires onInstalled with reason "update".
}

async function initializeSettings() {
  const stored = await chrome.storage.sync.get({
    ...DEFAULT_SETTINGS,
    settingsVersion: 0
  });
  const settings = migrateSettings(stored);
  await chrome.storage.sync.set({ ...settings, settingsVersion: SETTINGS_VERSION });
  return settings;
}

async function getSettings() {
  const stored = await chrome.storage.sync.get({
    ...DEFAULT_SETTINGS,
    settingsVersion: SETTINGS_VERSION
  });
  return normalizeSettings(stored);
}

async function saveSettings(partial = {}) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...partial });
  await chrome.storage.sync.set({ ...next, settingsVersion: SETTINGS_VERSION });
  return next;
}

async function getPublicState() {
  const [settings, local, legacyTabs] = await Promise.all([
    getSettings(),
    chrome.storage.local.get(LAST_RUN_KEY),
    findLegacyTabs()
  ]);
  return {
    settings,
    lastRun: local[LAST_RUN_KEY] ?? null,
    migration: summarizeLegacyTabs(legacyTabs)
  };
}

async function startStartupRestore() {
  await chrome.storage.session.set({ [BROWSER_SESSION_READY_KEY]: false });
  const settings = await getSettings();
  const runId = makeRunId();
  const startedAt = Date.now();
  const startupRun = {
    runId,
    startedAt,
    until: startedAt + STARTUP_WINDOW_MS
  };

  await clearStartupAlarms();
  await chrome.storage.session.set({
    [STARTUP_RUN_KEY]: startupRun,
    [STARTUP_PROGRESS_KEY]: emptyProgress(runId, startedAt),
    [STARTUP_STABILITY_KEY]: emptyStability(runId),
    [STARTUP_GROUP_STATE_KEY]: emptyGroupState(runId),
    [STARTUP_ACTIVE_RESTORE_KEY]: await makeStartupActiveRestore(runId, startedAt)
  });

  if (!settings.enabled) {
    await finishStartupActiveRestore(runId);
    const status = makeStatus({
      trigger: "startup",
      state: "disabled",
      runId,
      startedAt,
      completedAt: Date.now()
    });
    await chrome.storage.local.set({ [LAST_RUN_KEY]: status });
    return status;
  }

  await Promise.all(
    STARTUP_PASS_DELAYS_MS.map((delay, index) =>
      chrome.alarms.create(`${STARTUP_ALARM_PREFIX}${runId}:${index}`, {
        when: Date.now() + delay
      })
    )
  );

  return enqueueStartupPass(runId);
}

async function clearStartupAlarms() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((alarm) => alarm.name.startsWith(STARTUP_ALARM_PREFIX))
      .map((alarm) => chrome.alarms.clear(alarm.name))
  );
}

async function captureCurrentActiveMarkers() {
  const tabs = await chrome.tabs.query({});
  const tabsByWindow = new Map();
  for (const tab of tabs) {
    if (!tabsByWindow.has(tab.windowId)) tabsByWindow.set(tab.windowId, []);
    tabsByWindow.get(tab.windowId).push(tab);
  }
  const markers = {};
  for (const tab of tabs.filter((item) => item.active)) {
    const marker = makeActiveMarker(tab, tabsByWindow.get(tab.windowId));
    if (marker) markers[String(tab.windowId)] = marker;
  }
  await chrome.storage.local.set({
    [ACTIVE_MARKERS_KEY]: { schemaVersion: 2, markers }
  });
}

async function makeStartupActiveRestore(runId, startedAt) {
  const stored = await chrome.storage.local.get(ACTIVE_MARKERS_KEY);
  const state = stored[ACTIVE_MARKERS_KEY];
  const markers = (state?.schemaVersion === 1 || state?.schemaVersion === 2) && state.markers
    ? Object.entries(state.markers)
        .filter(([, marker]) => isActiveMarker(marker))
        .map(([markerId, marker]) => ({ markerId, ...marker }))
    : [];
  return {
    runId,
    until: startedAt + ACTIVE_RESTORE_WINDOW_MS,
    markers,
    restoredMarkerIds: []
  };
}

async function recordActivatedTab(activeInfo) {
  const ready = await chrome.storage.session.get(BROWSER_SESSION_READY_KEY);
  if (!ready[BROWSER_SESSION_READY_KEY]) return;
  if (!Number.isInteger(activeInfo?.tabId)) return;
  await captureCurrentActiveMarkers();
}

async function continueStartupActiveRestore(runId) {
  const stored = await chrome.storage.session.get(STARTUP_ACTIVE_RESTORE_KEY);
  const state = stored[STARTUP_ACTIVE_RESTORE_KEY];
  if (!state || state.runId !== runId) return 0;

  const tabs = await chrome.tabs.query({});
  const restoredMarkerIds = new Set(state.restoredMarkerIds || []);
  const markers = state.markers
    .filter((marker) => !restoredMarkerIds.has(marker.markerId))
    .sort((a, b) => b.lastAccessed - a.lastAccessed);
  const usedTabIds = new Set();
  let restored = 0;

  for (const marker of markers) {
    const exactMatches = tabs.filter((tab) =>
      !usedTabIds.has(tab.id) &&
      Number.isInteger(tab.id) &&
      (Number.isInteger(tab.groupId) && tab.groupId >= 0) === marker.grouped &&
      tab.index === marker.index &&
      Boolean(tab.pinned) === marker.pinned &&
      tab.lastAccessed === marker.lastAccessed
    );
    const matches = exactMatches.length === 1
      ? exactMatches
      : findStructuralMatches(marker, tabs, usedTabIds);
    if (matches.length !== 1) continue;
    const target = matches[0];
    usedTabIds.add(target.id);
    const current = tabs.find((tab) => tab.windowId === target.windowId && tab.active);
    if (current?.id !== target.id) {
      await chrome.tabs.update(target.id, { active: true });
      for (const tab of tabs) {
        if (tab.windowId === target.windowId) tab.active = tab.id === target.id;
      }
    }
    restoredMarkerIds.add(marker.markerId);
    restored += 1;
  }

  const complete = restoredMarkerIds.size === state.markers.length;
  if (complete || Date.now() >= state.until) {
    await finishStartupActiveRestore(runId);
  } else {
    await chrome.storage.session.set({
      [STARTUP_ACTIVE_RESTORE_KEY]: {
        ...state,
        restoredMarkerIds: [...restoredMarkerIds]
      }
    });
  }
  return restored;
}

function findStructuralMatches(marker, tabs, usedTabIds) {
  if (
    typeof marker.windowStructure !== "string" ||
    (marker.groupOrdinal !== null && !Number.isInteger(marker.groupOrdinal))
  ) return [];

  const tabsByWindow = new Map();
  for (const tab of tabs) {
    if (!tabsByWindow.has(tab.windowId)) tabsByWindow.set(tab.windowId, []);
    tabsByWindow.get(tab.windowId).push(tab);
  }

  const matches = [];
  for (const windowTabs of tabsByWindow.values()) {
    const structure = describeWindowStructure(windowTabs);
    if (structure.signature !== marker.windowStructure) continue;
    const candidate = windowTabs.find((tab) => tab.index === marker.index);
    if (!candidate || usedTabIds.has(candidate.id) || !Number.isInteger(candidate.id)) continue;
    const grouped = Number.isInteger(candidate.groupId) && candidate.groupId >= 0;
    const groupOrdinal = grouped ? structure.groupOrdinals.get(candidate.groupId) : null;
    if (
      Boolean(candidate.pinned) === marker.pinned &&
      grouped === marker.grouped &&
      groupOrdinal === marker.groupOrdinal
    ) matches.push(candidate);
  }
  return matches;
}

async function finishStartupActiveRestore(runId) {
  const stored = await chrome.storage.session.get(STARTUP_ACTIVE_RESTORE_KEY);
  const state = stored[STARTUP_ACTIVE_RESTORE_KEY];
  if (state && state.runId !== runId) return;
  await captureCurrentActiveMarkers();
  await chrome.storage.session.remove(STARTUP_ACTIVE_RESTORE_KEY);
  await chrome.storage.session.set({ [BROWSER_SESSION_READY_KEY]: true });
}

function isActiveMarker(marker) {
  return Boolean(
    marker &&
    Number.isFinite(marker.lastAccessed) &&
    Number.isInteger(marker.index) &&
    typeof marker.pinned === "boolean" &&
    typeof marker.grouped === "boolean"
  );
}

function makeActiveMarker(tab, windowTabs) {
  if (!Number.isFinite(tab?.lastAccessed) || !Number.isInteger(tab.index)) return null;
  const grouped = Number.isInteger(tab.groupId) && tab.groupId >= 0;
  const structure = describeWindowStructure(windowTabs || [tab]);
  return {
    lastAccessed: tab.lastAccessed,
    index: tab.index,
    pinned: Boolean(tab.pinned),
    grouped,
    groupOrdinal: grouped ? structure.groupOrdinals.get(tab.groupId) : null,
    windowStructure: structure.signature
  };
}

function describeWindowStructure(windowTabs) {
  const sorted = [...windowTabs].sort((a, b) => a.index - b.index);
  const groupOrdinals = new Map();
  const tokens = sorted.map((tab) => {
    if (tab.pinned) return "p";
    if (!Number.isInteger(tab.groupId) || tab.groupId < 0) return "u";
    if (!groupOrdinals.has(tab.groupId)) groupOrdinals.set(tab.groupId, groupOrdinals.size);
    return `g${groupOrdinals.get(tab.groupId)}`;
  });
  return { signature: tokens.join(","), groupOrdinals };
}

function scheduleStartupSweep() {
  clearTimeout(startupSweepTimer);
  startupSweepTimer = setTimeout(() => {
    void getActiveStartupRun()
      .then((run) => run && enqueueStartupPass(run.runId))
      .catch(() => undefined);
  }, 100);
}

async function getActiveStartupRun(expectedRunId) {
  const stored = await chrome.storage.session.get(STARTUP_RUN_KEY);
  const run = stored[STARTUP_RUN_KEY];
  if (!run || run.until < Date.now()) return null;
  if (expectedRunId && run.runId !== expectedRunId) return null;
  return run;
}

async function enqueueStartupPass(expectedRunId) {
  const run = await getActiveStartupRun(expectedRunId);
  if (!run) return null;
  const work = executionQueue.then(async () => {
    const activeRun = await getActiveStartupRun(run.runId);
    if (!activeRun) return null;
    await continueStartupActiveRestore(run.runId);
    return optimize({ trigger: "startup", runId: run.runId });
  });
  executionQueue = work.catch(() => undefined);
  return work;
}

function enqueueRun(context) {
  const run = executionQueue.then(() => optimize(context));
  executionQueue = run.catch(() => undefined);
  return run;
}

async function optimize(context) {
  const startedAt = Date.now();
  try {
    if (context.trigger === "startup" && !(await getActiveStartupRun(context.runId))) {
      return (await chrome.storage.local.get(LAST_RUN_KEY))[LAST_RUN_KEY] ?? null;
    }

    const settings = await getSettings();
    if (context.trigger === "startup" && !settings.enabled) {
      const disabled = makeStatus({
        ...context,
        state: "disabled",
        startedAt,
        completedAt: Date.now()
      });
      await chrome.storage.local.set({ [LAST_RUN_KEY]: disabled });
      return disabled;
    }

    const scope = Number.isInteger(context.windowId)
      ? { tabs: { windowId: context.windowId }, groups: { windowId: context.windowId } }
      : { tabs: {}, groups: {} };
    const legacyTabs = await findLegacyTabs(scope.tabs);
    if (legacyTabs.length) {
      const blocked = makeStatus({
        ...context,
        state: "migration-required",
        startedAt,
        completedAt: Date.now(),
        skippedTabs: legacyTabs.length,
        errors: ["检测到旧版恢复页；请先在这些标签页中确认恢复原网址。"]
      });
      await chrome.storage.local.set({ [LAST_RUN_KEY]: blocked });
      return blocked;
    }

    const running = makeStatus({ ...context, state: "running", startedAt });
    await chrome.storage.local.set({ [LAST_RUN_KEY]: running });

    const [tabs, groups] = await Promise.all([
      chrome.tabs.query(scope.tabs),
      chrome.tabGroups.query(scope.groups)
    ]);
    const plan = buildRestorePlan(tabs, groups, settings);
    const groupControl = context.trigger === "startup"
      ? await prepareStartupGroupControl(context.runId, groups)
      : { allowedIds: new Set(groups.map((group) => group.id)) };
    const collapseGroupIds = plan.collapseGroupIds.filter((id) => groupControl.allowedIds.has(id));
    const expandGroupIds = plan.expandGroupIds.filter((id) => groupControl.allowedIds.has(id));
    const expectedTabSignatures = new Map(
      tabs.map((tab) => [tab.id, tabSafetySignature(tab)])
    );
    const discardTabIds = context.trigger === "startup"
      ? await getStableStartupDiscardIds(context.runId, tabs, groups, plan.discardTabIds)
      : plan.discardTabIds;

    const collapsed = await settleUnique(collapseGroupIds, (groupId) =>
      safelySetGroupCollapsed(groupId, true)
    );
    const expanded = await settleUnique(expandGroupIds, (groupId) =>
      safelySetGroupCollapsed(groupId, false)
    );
    const discarded = await settleUnique(discardTabIds, (tabId) =>
      safelyDiscardTab(tabId, settings, expectedTabSignatures.get(tabId))
    );
    if (context.trigger === "startup") {
      await recordStartupGroupChanges(
        context.runId,
        collapsed.changedIds,
        expanded.changedIds
      );
    }

    const passResult = {
      inspectedTabs: tabs.length,
      inspectedGroups: groups.length,
      discardedTabIds: discarded.changedIds,
      collapsedGroupIds: collapsed.changedIds,
      expandedGroupIds: expanded.changedIds,
      skippedTabIds: discarded.skippedIds,
      skippedGroupKeys: [
        ...collapsed.skippedIds.map((id) => `collapse:${id}`),
        ...expanded.skippedIds.map((id) => `expand:${id}`)
      ],
      errors: [...collapsed.errors, ...expanded.errors, ...discarded.errors]
    };

    const status = context.trigger === "startup"
      ? await mergeStartupProgress(context, passResult, startedAt)
      : makeStatus({
          ...context,
          state: "complete",
          startedAt,
          completedAt: Date.now(),
          passCount: 1,
          inspectedTabs: passResult.inspectedTabs,
          inspectedGroups: passResult.inspectedGroups,
          discardedTabs: passResult.discardedTabIds.length,
          collapsedGroups: passResult.collapsedGroupIds.length,
          expandedGroups: passResult.expandedGroupIds.length,
          skippedTabs: passResult.skippedTabIds.length,
          skippedGroups: passResult.skippedGroupKeys.length,
          failures: passResult.errors.length,
          errors: passResult.errors.slice(-MAX_RECORDED_ERRORS)
        });

    await chrome.storage.local.set({ [LAST_RUN_KEY]: status });
    return status;
  } catch (error) {
    const status = makeStatus({
      ...context,
      state: "error",
      startedAt,
      completedAt: Date.now(),
      failures: 1,
      errors: [formatError(error)]
    });
    await chrome.storage.local.set({ [LAST_RUN_KEY]: status });
    throw error;
  }
}

async function safelySetGroupCollapsed(groupId, collapsed) {
  const group = await chrome.tabGroups.get(groupId);
  const activeTabs = await chrome.tabs.query({ windowId: group.windowId, active: true });
  const activeGroupId = activeTabs[0]?.groupId;
  if (collapsed && activeGroupId === groupId) return "skipped";
  if (!collapsed && activeGroupId !== groupId) return "skipped";
  if (group.collapsed === collapsed) return "skipped";
  const updated = await chrome.tabGroups.update(groupId, { collapsed });
  return updated ? "changed" : "skipped";
}

async function safelyDiscardTab(tabId, settings, expectedSignature) {
  const tab = await chrome.tabs.get(tabId);
  if (expectedSignature && tabSafetySignature(tab) !== expectedSignature) return "skipped";
  if (!isDiscardEligible(tab, settings)) return "skipped";
  const discarded = await chrome.tabs.discard(tabId);
  return discarded ? "changed" : "skipped";
}

async function getStableStartupDiscardIds(runId, tabs, groups, candidateIds) {
  const now = Date.now();
  const stored = await chrome.storage.session.get([
    STARTUP_RUN_KEY,
    STARTUP_STABILITY_KEY
  ]);
  const run = stored[STARTUP_RUN_KEY];
  if (!run || run.runId !== runId || run.until < now) return [];

  const signature = topologySignature(tabs, groups);
  const previous = stored[STARTUP_STABILITY_KEY];
  const stability = previous?.runId === runId && previous.signature === signature
    ? previous
    : { runId, signature, stableSince: now, observations: 0 };
  stability.observations += 1;
  await chrome.storage.session.set({ [STARTUP_STABILITY_KEY]: stability });

  const oldEnough = now >= run.startedAt + STARTUP_DISCARD_NOT_BEFORE_MS;
  const stableLongEnough = now - stability.stableSince >= STARTUP_TOPOLOGY_STABLE_MS;
  if (!oldEnough || !stableLongEnough || stability.observations < 2) return [];
  return candidateIds;
}

async function prepareStartupGroupControl(runId, groups) {
  const stored = await chrome.storage.session.get([
    STARTUP_RUN_KEY,
    STARTUP_GROUP_STATE_KEY
  ]);
  const run = stored[STARTUP_RUN_KEY];
  if (!run || run.runId !== runId || run.until < Date.now()) {
    return { allowedIds: new Set() };
  }

  const previous = stored[STARTUP_GROUP_STATE_KEY];
  const state = previous?.runId === runId ? previous : emptyGroupState(runId);
  const observed = { ...state.observed };
  const overriddenIds = new Set(state.overriddenIds || []);
  const allowedIds = new Set();
  const currentIds = new Set(groups.map((group) => group.id));

  for (const group of groups) {
    const key = String(group.id);
    const seenBefore = Object.prototype.hasOwnProperty.call(observed, key);
    if (!seenBefore) {
      observed[key] = group.collapsed;
      continue;
    }
    if (observed[key] !== group.collapsed) {
      overriddenIds.add(group.id);
      observed[key] = group.collapsed;
    }
    if (!overriddenIds.has(group.id)) allowedIds.add(group.id);
  }

  for (const key of Object.keys(observed)) {
    if (!currentIds.has(Number(key))) delete observed[key];
  }
  const next = {
    runId,
    observed,
    overriddenIds: [...overriddenIds].filter((id) => currentIds.has(id))
  };
  await chrome.storage.session.set({ [STARTUP_GROUP_STATE_KEY]: next });
  return { allowedIds };
}

async function recordStartupGroupChanges(runId, collapsedIds, expandedIds) {
  if (!collapsedIds.length && !expandedIds.length) return;
  const stored = await chrome.storage.session.get(STARTUP_GROUP_STATE_KEY);
  const state = stored[STARTUP_GROUP_STATE_KEY];
  if (!state || state.runId !== runId) return;
  const observed = { ...state.observed };
  for (const id of collapsedIds) observed[String(id)] = true;
  for (const id of expandedIds) observed[String(id)] = false;
  await chrome.storage.session.set({
    [STARTUP_GROUP_STATE_KEY]: { ...state, observed }
  });
}

function topologySignature(tabs, groups) {
  const tabState = tabs
    .map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      groupId: tab.groupId,
      active: tab.active,
      discarded: tab.discarded,
      status: tab.status || "",
      url: tab.url || "",
      pendingUrl: tab.pendingUrl || ""
    }))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index || a.id - b.id);
  const groupState = groups
    .map((group) => ({
      id: group.id,
      windowId: group.windowId,
      title: group.title || "",
      color: group.color || ""
    }))
    .sort((a, b) => a.windowId - b.windowId || a.id - b.id);
  return JSON.stringify({ tabs: tabState, groups: groupState });
}

function tabSafetySignature(tab) {
  return JSON.stringify({
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    groupId: tab.groupId,
    active: tab.active,
    discarded: tab.discarded,
    status: tab.status || "",
    url: tab.url || "",
    pendingUrl: tab.pendingUrl || "",
    pinned: tab.pinned,
    audible: tab.audible
  });
}

async function settleUnique(ids, operation) {
  const remaining = [...new Set(ids)];
  const changedIds = [];
  const skippedIds = [];
  const errors = [];
  const workers = Array.from(
    { length: Math.min(MAX_WORKERS, remaining.length) },
    async () => {
      while (remaining.length) {
        const id = remaining.shift();
        try {
          const result = await operation(id);
          if (result === "changed") changedIds.push(id);
          else skippedIds.push(id);
        } catch (error) {
          skippedIds.push(id);
          errors.push(`${id}: ${formatError(error)}`);
        }
      }
    }
  );
  await Promise.all(workers);
  return { changedIds, skippedIds, errors };
}

async function mergeStartupProgress(context, pass, fallbackStartedAt) {
  const stored = await chrome.storage.session.get(STARTUP_PROGRESS_KEY);
  const existing = stored[STARTUP_PROGRESS_KEY];
  const progress = existing?.runId === context.runId
    ? existing
    : emptyProgress(context.runId, fallbackStartedAt);

  const discardedTabIds = union(progress.discardedTabIds, pass.discardedTabIds);
  const collapsedGroupIds = union(progress.collapsedGroupIds, pass.collapsedGroupIds);
  const expandedGroupIds = union(progress.expandedGroupIds, pass.expandedGroupIds);
  const skippedTabIds = difference(
    union(progress.skippedTabIds, pass.skippedTabIds),
    discardedTabIds
  );
  const changedGroupKeys = [
    ...collapsedGroupIds.map((id) => `collapse:${id}`),
    ...expandedGroupIds.map((id) => `expand:${id}`)
  ];
  const skippedGroupKeys = difference(
    union(progress.skippedGroupKeys, pass.skippedGroupKeys),
    changedGroupKeys
  );
  const errors = union(progress.errors, pass.errors).slice(-MAX_RECORDED_ERRORS);

  const next = {
    runId: context.runId,
    startedAt: progress.startedAt,
    passCount: progress.passCount + 1,
    inspectedTabs: pass.inspectedTabs,
    inspectedGroups: pass.inspectedGroups,
    discardedTabIds,
    collapsedGroupIds,
    expandedGroupIds,
    skippedTabIds,
    skippedGroupKeys,
    errors
  };
  await chrome.storage.session.set({ [STARTUP_PROGRESS_KEY]: next });

  return makeStatus({
    ...context,
    state: "complete",
    startedAt: next.startedAt,
    completedAt: Date.now(),
    passCount: next.passCount,
    inspectedTabs: next.inspectedTabs,
    inspectedGroups: next.inspectedGroups,
    discardedTabs: next.discardedTabIds.length,
    collapsedGroups: next.collapsedGroupIds.length,
    expandedGroups: next.expandedGroupIds.length,
    skippedTabs: next.skippedTabIds.length,
    skippedGroups: next.skippedGroupKeys.length,
    failures: next.errors.length,
    errors: next.errors
  });
}

async function findLegacyTabs(queryInfo = {}) {
  const tabs = await chrome.tabs.query(queryInfo);
  return tabs.filter((tab) => isLegacyUrl(tab.pendingUrl || tab.url || ""));
}

function isLegacyUrl(url) {
  const suspendedPage = chrome.runtime.getURL("suspended.html");
  return url.startsWith(suspendedPage);
}

function summarizeLegacyTabs(tabs) {
  return {
    required: tabs.length > 0,
    count: tabs.length,
    tabIds: tabs.map((tab) => tab.id).filter(Number.isInteger)
  };
}

async function cleanLegacyStateIfSafe() {
  const [legacyTabs, local] = await Promise.all([
    findLegacyTabs(),
    chrome.storage.local.get(null)
  ]);
  const keysToRemove = Object.keys(local).filter((key) =>
    LEGACY_STATUS_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    OBSOLETE_STATE_KEYS.has(key) ||
    key === "lastRun"
  );
  if (!legacyTabs.length) {
    keysToRemove.push(
      ...Object.keys(local).filter((key) => key.startsWith(LEGACY_RECORD_PREFIX))
    );
  }
  if (keysToRemove.length) await chrome.storage.local.remove([...new Set(keysToRemove)]);
}

async function recordFatalStatus(trigger, error) {
  const status = makeStatus({
    trigger,
    state: "error",
    runId: makeRunId(),
    startedAt: Date.now(),
    completedAt: Date.now(),
    failures: 1,
    errors: [formatError(error)]
  });
  await chrome.storage.local.set({ [LAST_RUN_KEY]: status });
  return status;
}

function emptyProgress(runId, startedAt) {
  return {
    runId,
    startedAt,
    passCount: 0,
    inspectedTabs: 0,
    inspectedGroups: 0,
    discardedTabIds: [],
    collapsedGroupIds: [],
    expandedGroupIds: [],
    skippedTabIds: [],
    skippedGroupKeys: [],
    errors: []
  };
}

function emptyStability(runId) {
  return { runId, signature: null, stableSince: 0, observations: 0 };
}

function emptyGroupState(runId) {
  return { runId, observed: {}, overriddenIds: [] };
}

function makeStatus(overrides = {}) {
  return {
    schemaVersion: 4,
    trigger: "startup",
    state: "complete",
    runId: null,
    startedAt: null,
    completedAt: null,
    passCount: 0,
    inspectedTabs: 0,
    inspectedGroups: 0,
    discardedTabs: 0,
    collapsedGroups: 0,
    expandedGroups: 0,
    skippedTabs: 0,
    skippedGroups: 0,
    failures: 0,
    errors: [],
    ...overrides
  };
}

function union(left = [], right = []) {
  return [...new Set([...left, ...right])];
}

function difference(values, excluded) {
  const excludedSet = new Set(excluded);
  return values.filter((value) => !excludedSet.has(value));
}

function makeRunId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
