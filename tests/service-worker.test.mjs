import assert from "node:assert/strict";

let fakeNow = 1_800_000_000_000;
Date.now = () => fakeNow;

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    }
  };
}

function createStorageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      if (typeof keys === "string") return { [keys]: structuredClone(data[keys]) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, structuredClone(data[key])]));
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          data[key] === undefined ? structuredClone(fallback) : structuredClone(data[key])
        ])
      );
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

const events = {
  installed: createEvent(),
  startup: createEvent(),
  message: createEvent(),
  alarm: createEvent(),
  tabCreated: createEvent(),
  tabUpdated: createEvent(),
  tabActivated: createEvent(),
  tabMoved: createEvent(),
  tabAttached: createEvent(),
  windowCreated: createEvent(),
  groupCreated: createEvent(),
  groupUpdated: createEvent()
};
const calls = {
  alarms: [],
  tabQueries: [],
  groupQueries: [],
  groupUpdates: [],
  discards: [],
  badges: []
};

const tabs = [
  { id: 1, windowId: 1, index: 0, active: true, groupId: 10, pinned: false, audible: false, discarded: false, status: "complete", url: "https://one.test/" },
  { id: 2, windowId: 1, index: 1, active: false, groupId: 10, pinned: false, audible: false, discarded: false, status: "complete", url: "https://two.test/" },
  { id: 3, windowId: 1, index: 2, active: false, groupId: 11, pinned: false, audible: false, discarded: false, status: "complete", url: "https://three.test/" },
  { id: 4, windowId: 1, index: 3, active: false, groupId: -1, pinned: true, audible: false, discarded: false, status: "complete", url: "https://pinned.test/" },
  { id: 5, windowId: 1, index: 4, active: false, groupId: -1, pinned: false, audible: true, discarded: false, status: "complete", url: "https://audio.test/" },
  { id: 6, windowId: 2, index: 0, active: true, groupId: -1, pinned: false, audible: false, discarded: false, status: "complete", url: "https://six.test/" },
  { id: 7, windowId: 2, index: 1, active: false, groupId: 12, pinned: false, audible: false, discarded: false, status: "complete", url: "chrome://settings/" },
  { id: 9, windowId: 2, index: 2, active: false, groupId: 12, pinned: false, audible: false, discarded: false, status: "unloaded", url: "", pendingUrl: "https://restoring.test/" }
];
const groups = [
  { id: 10, windowId: 1, title: "A", color: "blue", collapsed: true },
  { id: 11, windowId: 1, title: "B", color: "red", collapsed: false },
  { id: 12, windowId: 2, title: "C", color: "green", collapsed: false }
];

const sync = createStorageArea({ keepPinned: true, keepAudible: true, settingsVersion: 3 });
const local = createStorageArea({
  "recovery-v310-reverse-current": { state: "complete" },
  lastRun: { state: "complete" }
});
const session = createStorageArea();
let beforeGetHook = null;

globalThis.chrome = {
  runtime: {
    onInstalled: events.installed,
    onStartup: events.startup,
    onMessage: events.message,
    getURL: (path) => `chrome-extension://test-extension/${path}`
  },
  storage: { sync, local, session },
  action: {
    async setBadgeText(value) {
      calls.badges.push(value);
    }
  },
  alarms: {
    onAlarm: events.alarm,
    async getAll() {
      return [];
    },
    async clear() {
      return true;
    },
    async create(name, options) {
      calls.alarms.push({ name, options });
    }
  },
  tabs: {
    onCreated: events.tabCreated,
    onUpdated: events.tabUpdated,
    onActivated: events.tabActivated,
    onMoved: events.tabMoved,
    onAttached: events.tabAttached,
    async query(queryInfo = {}) {
      calls.tabQueries.push(structuredClone(queryInfo));
      return tabs
        .filter((tab) => queryInfo.windowId == null || tab.windowId === queryInfo.windowId)
        .filter((tab) => queryInfo.active == null || tab.active === queryInfo.active)
        .map((tab) => structuredClone(tab));
    },
    async get(tabId) {
      if (beforeGetHook) await beforeGetHook(tabId);
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) throw new Error("No tab");
      return structuredClone(tab);
    },
    async discard(tabId) {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || tab.active || tab.discarded || tab.url.startsWith("chrome://")) return undefined;
      tab.discarded = true;
      calls.discards.push(tabId);
      return structuredClone(tab);
    }
  },
  windows: {
    WINDOW_ID_CURRENT: -2,
    onCreated: events.windowCreated
  },
  tabGroups: {
    onCreated: events.groupCreated,
    onUpdated: events.groupUpdated,
    async query(queryInfo = {}) {
      calls.groupQueries.push(structuredClone(queryInfo));
      return groups
        .filter((group) => queryInfo.windowId == null || group.windowId === queryInfo.windowId)
        .map((group) => structuredClone(group));
    },
    async get(groupId) {
      const group = groups.find((item) => item.id === groupId);
      if (!group) throw new Error("No group");
      return structuredClone(group);
    },
    async update(groupId, changes) {
      const group = groups.find((item) => item.id === groupId);
      if (!group) return undefined;
      group.collapsed = changes.collapsed;
      calls.groupUpdates.push({ groupId, collapsed: changes.collapsed });
      return structuredClone(group);
    }
  }
};

await import("../extension/service-worker.js?service-worker-test");

const initialFingerprint = fingerprint();
events.installed.emit({ reason: "install" });
await waitFor(() => sync.data.settingsVersion === 4 && calls.badges.length === 1);
events.installed.emit({ reason: "update", previousVersion: "3.1.0" });
await waitFor(() => calls.badges.length === 2);
assert.deepEqual(fingerprint(), initialFingerprint, "install/update must not touch tabs or groups");
assert.deepEqual(calls.discards, []);
assert.deepEqual(calls.groupUpdates, []);
assert.equal(sync.data.keepPinned, false);
assert.equal(sync.data.keepAudible, false);
assert.equal(local.data["recovery-v310-reverse-current"], undefined);

events.startup.emit();
await waitFor(() => local.data.lastRunV4?.state === "complete");
assert.equal(calls.alarms.length, 7, "startup schedules seven follow-up passes");
assert.deepEqual(calls.groupUpdates, [], "the first startup observation does not mutate groups");
fakeNow += 250;
events.alarm.emit({ name: calls.alarms[0].name });
await waitFor(() => calls.groupUpdates.length === 3);
assert.deepEqual(calls.groupUpdates, [
  { groupId: 11, collapsed: true },
  { groupId: 12, collapsed: true },
  { groupId: 10, collapsed: false }
]);
assert.deepEqual(calls.discards, [], "startup never discards during the early restore phase");
assert.ok(!calls.discards.includes(1));
assert.ok(!calls.discards.includes(6));
assert.ok(!calls.discards.includes(9), "uncommitted restored tabs are never discarded");

const passCountBeforeManualExpand = local.data.lastRunV4.passCount;
groups.find((group) => group.id === 11).collapsed = false;
events.groupUpdated.emit(structuredClone(groups.find((group) => group.id === 11)));
await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(local.data.lastRunV4.passCount, passCountBeforeManualExpand, "a group update does not schedule another pass");
fakeNow += 750;
events.alarm.emit({ name: calls.alarms[1].name });
await waitFor(() => local.data.lastRunV4.passCount > passCountBeforeManualExpand);
assert.equal(
  calls.groupUpdates.filter((call) => call.groupId === 11 && call.collapsed).length,
  1,
  "a manually expanded group is never collapsed again during this startup"
);

fakeNow += 31_000;
events.alarm.emit({ name: calls.alarms.find((alarm) => alarm.name.endsWith(":5")).name });
await waitFor(() => calls.discards.length === 4);
assert.deepEqual([...calls.discards].sort((a, b) => a - b), [2, 3, 4, 5]);
assert.equal(local.data.lastRunV4.discardedTabs, 4);
assert.equal(local.data.lastRunV4.skippedTabs, 0);

tabs.push({
  id: 8,
  windowId: 1,
  index: 5,
  active: false,
  groupId: 13,
  pinned: false,
  audible: false,
  discarded: false,
  status: "complete",
  url: "https://late.test/"
});
groups.push({ id: 13, windowId: 1, title: "Late", color: "yellow", collapsed: false });
events.alarm.emit({ name: calls.alarms[0].name });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.ok(!calls.discards.includes(8), "a late tab must first become topologically stable");
fakeNow += 11_000;
events.alarm.emit({ name: calls.alarms[0].name });
await waitFor(() => calls.discards.includes(8));
assert.ok(calls.groupUpdates.some((call) => call.groupId === 13 && call.collapsed));
assert.equal(local.data.lastRunV4.discardedTabs, 5, "startup totals use unique IDs");

events.alarm.emit({ name: calls.alarms[0].name });
await waitFor(() => local.data.lastRunV4.passCount >= 3);
assert.equal(local.data.lastRunV4.discardedTabs, 5, "repeating a pass does not inflate totals");

const messageListener = events.message.listeners[0];
tabs.find((tab) => tab.id === 1).active = true;
tabs.find((tab) => tab.id === 2).active = false;
tabs.find((tab) => tab.id === 2).discarded = false;
beforeGetHook = async (tabId) => {
  if (tabId !== 2) return;
  tabs.find((tab) => tab.id === 1).active = false;
  tabs.find((tab) => tab.id === 2).active = true;
  beforeGetHook = null;
};
const discardCountBeforeRace = calls.discards.length;
const manualResponse = await sendRuntimeMessage(messageListener, {
  type: "optimize-now",
  windowId: 1
});
assert.equal(manualResponse.lastRun.state, "complete");
assert.equal(calls.discards.length, discardCountBeforeRace, "newly active tab is revalidated and preserved");
assert.equal(tabs.find((tab) => tab.id === 2).discarded, false);

const beforeReloadFingerprint = fingerprint();
const mutationCounts = {
  discards: calls.discards.length,
  groupUpdates: calls.groupUpdates.length
};
events.installed.emit({ reason: "update", previousVersion: "4.0.0" });
events.installed.emit({ reason: "update", previousVersion: "4.0.0" });
await waitFor(() => calls.badges.length === 4);
assert.deepEqual(fingerprint(), beforeReloadFingerprint, "two reloads preserve the full tab fingerprint");
assert.deepEqual(
  { discards: calls.discards.length, groupUpdates: calls.groupUpdates.length },
  mutationCounts,
  "two reloads perform no tab or group mutations"
);

tabs.push({
  id: 99,
  windowId: 1,
  index: 6,
  active: false,
  groupId: -1,
  pinned: false,
  audible: false,
  discarded: false,
  status: "complete",
  url: "chrome-extension://test-extension/suspended.html#legacy"
});
const blockedMutationCounts = {
  discards: calls.discards.length,
  groupUpdates: calls.groupUpdates.length
};
const blockedResponse = await sendRuntimeMessage(messageListener, {
  type: "optimize-now",
  windowId: 1
});
assert.equal(blockedResponse.lastRun.state, "migration-required");
assert.deepEqual(
  { discards: calls.discards.length, groupUpdates: calls.groupUpdates.length },
  blockedMutationCounts,
  "legacy pages block the whole operation before the first mutation"
);

tabs.splice(tabs.findIndex((tab) => tab.id === 99), 1);
const beforeSecondStartup = fingerprint();
const discardCountBeforeSecondStartup = calls.discards.length;
const previousRunId = local.data.lastRunV4.runId;
const alarmCountBeforeSecondStartup = calls.alarms.length;
fakeNow += 70_000;
events.startup.emit();
await waitFor(() => local.data.lastRunV4?.runId !== previousRunId);
const secondStartupAlarms = calls.alarms.slice(alarmCountBeforeSecondStartup);
assert.equal(secondStartupAlarms.length, 7);
assert.deepEqual(fingerprint(), beforeSecondStartup, "a second startup preserves all tabs and groups");
assert.equal(calls.discards.length, discardCountBeforeSecondStartup);

fakeNow += 31_000;
events.alarm.emit({ name: secondStartupAlarms.find((alarm) => alarm.name.endsWith(":5")).name });
await waitFor(() => local.data.lastRunV4.passCount >= 2);
assert.deepEqual(fingerprint(), beforeSecondStartup, "the second startup's stable pass preserves structure");
assert.equal(calls.discards.length, discardCountBeforeSecondStartup + 1);
assert.equal(calls.discards.at(-1), 1, "only the newly inactive committed tab is discarded");
assert.ok(!calls.discards.includes(9), "uncommitted tabs remain untouched across consecutive startups");

console.log("service worker integration tests passed");

function fingerprint() {
  return {
    tabs: tabs.map(({ id, windowId, index, active, groupId, pinned, url }) => ({
      id,
      windowId,
      index,
      active,
      groupId,
      pinned,
      url
    })),
    groups: groups.map(({ id, windowId, title, color, collapsed }) => ({
      id,
      windowId,
      title,
      color,
      collapsed
    }))
  };
}

function sendRuntimeMessage(listener, message) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, {}, resolve);
    assert.equal(keepChannelOpen, true);
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for asynchronous work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
