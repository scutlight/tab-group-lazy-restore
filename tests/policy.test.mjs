import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  buildRestorePlan,
  isDiscardEligible,
  migrateSettings,
  normalizeSettings
} from "../extension/policy.js";

const tabs = [
  { id: 1, windowId: 1, active: true, groupId: 10, pinned: false, audible: false, status: "complete", url: "https://1.test/" },
  { id: 2, windowId: 1, active: false, groupId: 10, pinned: false, audible: false, status: "complete", url: "https://2.test/" },
  { id: 3, windowId: 1, active: false, groupId: 11, pinned: false, audible: false, status: "complete", url: "https://3.test/" },
  { id: 4, windowId: 1, active: false, groupId: -1, pinned: true, audible: false, status: "complete", url: "https://4.test/" },
  { id: 5, windowId: 1, active: false, groupId: -1, pinned: false, audible: true, status: "complete", url: "https://5.test/" },
  { id: 6, windowId: 2, active: true, groupId: -1, pinned: false, audible: false, status: "complete", url: "https://6.test/" },
  { id: 7, windowId: 2, active: false, groupId: 12, pinned: false, audible: false, status: "complete", url: "https://7.test/" },
  { id: 8, windowId: 2, active: false, groupId: 12, pinned: false, audible: false, discarded: true, status: "unloaded", url: "https://8.test/" }
];
const groups = [
  { id: 10, windowId: 1, collapsed: true },
  { id: 11, windowId: 1, collapsed: false },
  { id: 12, windowId: 2, collapsed: false }
];

assert.deepEqual(normalizeSettings({ enabled: false, keepPinned: "no" }), {
  ...DEFAULT_SETTINGS,
  enabled: false
});

assert.deepEqual(
  migrateSettings({
    settingsVersion: 3,
    enabled: false,
    collapseGroups: false,
    discardInactiveTabs: true,
    includeUngrouped: false,
    keepPinned: true,
    keepAudible: true
  }),
  {
    enabled: false,
    collapseGroups: false,
    discardInactiveTabs: true,
    includeUngrouped: false,
    keepPinned: false,
    keepAudible: false
  }
);

assert.deepEqual(buildRestorePlan(tabs, groups), {
  collapseGroupIds: [11, 12],
  expandGroupIds: [10],
  discardTabIds: [2, 3, 4, 5, 7]
});

assert.deepEqual(
  buildRestorePlan(tabs, groups, { keepPinned: true, keepAudible: true }),
  {
    collapseGroupIds: [11, 12],
    expandGroupIds: [10],
    discardTabIds: [2, 3, 7]
  }
);

assert.deepEqual(
  buildRestorePlan(tabs, groups, { collapseGroups: false, includeUngrouped: false }),
  {
    collapseGroupIds: [],
    expandGroupIds: [],
    discardTabIds: [2, 3, 7]
  }
);

const committed = { id: 9, active: false, discarded: false, groupId: -1, status: "complete", url: "https://safe.test/" };
assert.equal(isDiscardEligible({ ...committed, active: true }), false);
assert.equal(isDiscardEligible({ ...committed, discarded: true }), false);
assert.equal(isDiscardEligible({ active: false, discarded: false }), false);
assert.equal(isDiscardEligible({ ...committed, url: "" }), false);
assert.equal(isDiscardEligible({ ...committed, pendingUrl: "https://pending.test/" }), false);
assert.equal(isDiscardEligible({ ...committed, status: "loading" }), false);
assert.equal(isDiscardEligible({ ...committed, status: "unloaded" }), false);
assert.equal(isDiscardEligible({ ...committed, url: "chrome://settings/" }), false);
assert.equal(isDiscardEligible(committed), true);

console.log("policy tests passed");
