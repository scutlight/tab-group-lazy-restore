import assert from "node:assert/strict";

function createEvent() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, emit(...args) { return listeners.map((fn) => fn(...args)); } };
}

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      if (typeof keys === "string") return { [keys]: structuredClone(data[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, structuredClone(data[key])]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, data[key] ?? structuredClone(fallback)]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
}

const events = {
  installed: createEvent(), startup: createEvent(), message: createEvent(), alarm: createEvent(),
  tabCreated: createEvent(), tabUpdated: createEvent(), tabActivated: createEvent(), tabMoved: createEvent(), tabAttached: createEvent(),
  windowCreated: createEvent(), groupCreated: createEvent(), groupUpdated: createEvent()
};
const tabs = [
  tab(1, 101, 0, -1, true, 9_000),
  tab(2, 101, 1, -1, false, 1_000),
  tab(3, 101, 2, 20, false, 700),
  tab(4, 202, 0, -1, true, 8_000),
  tab(5, 202, 1, -1, false, 2_000)
];
tabs.find((item) => item.id === 4).pinned = true;
const groups = [
  { id: 20, windowId: 101, title: "A", color: "blue", collapsed: false },
  { id: 30, windowId: 202, title: "B", color: "red", collapsed: false }
];
const sync = createStorage();
const local = createStorage({
  activeMarkersV4: {
    schemaVersion: 2,
    markers: {
      "old-window-1": {
        lastAccessed: 1_000, index: 1, pinned: false, grouped: false,
        groupOrdinal: null, windowStructure: "u,u,g0"
      },
      "old-window-2": {
        lastAccessed: 2_000, index: 1, pinned: false, grouped: true,
        groupOrdinal: 0, windowStructure: "p,g0"
      }
    }
  }
});
const session = createStorage();
const updateCalls = [];

globalThis.chrome = {
  runtime: { onInstalled: events.installed, onStartup: events.startup, onMessage: events.message, getURL: (path) => `chrome-extension://test/${path}` },
  alarms: { onAlarm: events.alarm, async getAll() { return []; }, async clear() {}, async create() {} },
  action: { async setBadgeText() {} },
  storage: { sync, local, session },
  windows: { WINDOW_ID_CURRENT: -2, onCreated: events.windowCreated },
  tabs: {
    onCreated: events.tabCreated, onUpdated: events.tabUpdated, onActivated: events.tabActivated, onMoved: events.tabMoved, onAttached: events.tabAttached,
    async query(queryInfo = {}) {
      return tabs
        .filter((item) => queryInfo.windowId == null || item.windowId === queryInfo.windowId)
        .filter((item) => queryInfo.active == null || item.active === queryInfo.active)
        .map((item) => structuredClone(item));
    },
    async get(tabId) { return structuredClone(tabs.find((item) => item.id === tabId)); },
    async update(tabId, changes) {
      assert.deepEqual(changes, { active: true });
      const target = tabs.find((item) => item.id === tabId);
      for (const item of tabs.filter((item) => item.windowId === target.windowId)) item.active = false;
      target.active = true;
      updateCalls.push({ tabId, changes: structuredClone(changes) });
      return structuredClone(target);
    },
    async discard() { throw new Error("early startup must not discard"); }
  },
  tabGroups: {
    onCreated: events.groupCreated, onUpdated: events.groupUpdated,
    async query() { return groups.map((group) => structuredClone(group)); },
    async get(groupId) { return structuredClone(groups.find((group) => group.id === groupId)); },
    async update() { throw new Error("first observation must not update groups"); }
  }
};

await import("../extension/service-worker.js?active-restore-test");
events.startup.emit();
await waitFor(() => updateCalls.length === 1 && local.data.lastRunV4?.state === "complete");

assert.deepEqual(updateCalls, [{ tabId: 2, changes: { active: true } }]);
assert.equal(tabs.find((item) => item.id === 2).active, true, "the exact ungrouped marker is restored immediately");
assert.equal(tabs.find((item) => item.id === 4).active, true, "the wrong pinned tab remains active only while group membership is missing");
assert.equal(session.data.browserSessionReadyV4, false, "the incorrect startup tab cannot overwrite the saved marker");
assert.equal(local.data.activeMarkersV4.markers["old-window-2"].lastAccessed, 2_000);

tabs.find((item) => item.id === 5).groupId = 30;
tabs.find((item) => item.id === 5).lastAccessed = 2_500;
events.tabUpdated.emit(5, { groupId: 30 }, structuredClone(tabs.find((item) => item.id === 5)));
await waitFor(() => updateCalls.length === 2);

assert.deepEqual(updateCalls, [
  { tabId: 2, changes: { active: true } },
  { tabId: 5, changes: { active: true } }
]);
assert.equal(tabs.find((item) => item.id === 2).active, true, "the exact ungrouped marker is restored");
assert.equal(tabs.find((item) => item.id === 1).active, false);
assert.equal(tabs.find((item) => item.id === 4).active, false);
assert.equal(tabs.find((item) => item.id === 5).active, true, "the grouped marker is retried after Chrome restores membership");
assert.equal(session.data.browserSessionReadyV4, true);

const serialized = JSON.stringify(local.data.activeMarkersV4);
assert.doesNotMatch(serialized, /https?:|title|url|groupTitle/i, "active markers contain no browsing data");

tabs.find((item) => item.id === 2).active = false;
tabs.find((item) => item.id === 1).active = true;
tabs.find((item) => item.id === 1).lastAccessed = 12_000;
events.tabActivated.emit({ tabId: 1, windowId: 101 });
await waitFor(() => local.data.activeMarkersV4?.markers?.["101"]?.lastAccessed === 12_000);
assert.deepEqual(local.data.activeMarkersV4.markers["101"], {
  lastAccessed: 12_000,
  index: 0,
  pinned: false,
  grouped: false,
  groupOrdinal: null,
  windowStructure: "u,u,g0"
});

console.log("active tab restore tests passed");

function tab(id, windowId, index, groupId, active, lastAccessed) {
  return {
    id, windowId, index, groupId, active, lastAccessed,
    pinned: false, audible: false, discarded: false, status: "complete", url: `https://${id}.test/`
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for active-tab restore");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
