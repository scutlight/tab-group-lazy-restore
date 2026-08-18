const SETTING_IDS = [
  "enabled",
  "collapseGroups",
  "discardInactiveTabs",
  "includeUngrouped",
  "keepPinned",
  "keepAudible"
];

const controls = Object.fromEntries(
  SETTING_IDS.map((id) => [id, document.getElementById(id)])
);
const optimizeButton = document.getElementById("optimize");
const status = document.getElementById("status");
const migration = document.getElementById("migration");
const migrationText = document.getElementById("migrationText");

void loadState();

for (const [id, control] of Object.entries(controls)) {
  control.addEventListener("change", async () => {
    try {
      const response = await sendMessage({
        type: "save-settings",
        settings: { [id]: control.checked }
      });
      if (response.error) throw new Error(response.error);
      applySettings(response.settings);
      showStatus("设置已保存");
    } catch (error) {
      control.checked = !control.checked;
      showStatus(`保存失败：${error.message}`, true);
    }
  });
}

optimizeButton.addEventListener("click", async () => {
  optimizeButton.disabled = true;
  optimizeButton.textContent = "正在整理…";
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const response = await sendMessage({
      type: "optimize-now",
      windowId: currentWindow.id
    });
    if (response.error) throw new Error(response.error);
    renderLastRun(response.lastRun);
  } catch (error) {
    showStatus(`整理失败：${error.message}`, true);
  } finally {
    optimizeButton.disabled = false;
    optimizeButton.textContent = "立即整理当前窗口";
  }
});

async function loadState() {
  try {
    const response = await sendMessage({ type: "get-state" });
    if (response.error) throw new Error(response.error);
    applySettings(response.settings);
    renderMigration(response.migration);
    renderLastRun(response.lastRun);
  } catch (error) {
    showStatus(`读取失败：${error.message}`, true);
  }
}

function applySettings(settings) {
  for (const id of SETTING_IDS) controls[id].checked = Boolean(settings[id]);
}

function renderMigration(state) {
  const required = Boolean(state?.required);
  migration.hidden = !required;
  optimizeButton.disabled = required;
  if (required) migrationText.textContent = `共有 ${state.count} 个标签页等待确认。`;
}

function renderLastRun(lastRun) {
  if (!lastRun) {
    showStatus("尚未整理；下次启动 Chrome 时会自动执行");
    return;
  }
  if (lastRun.state === "migration-required") {
    showStatus("已安全停止：请先恢复旧版标签页", true);
    return;
  }
  if (lastRun.state === "disabled") {
    showStatus("启动时自动整理目前已关闭");
    return;
  }
  if (lastRun.state === "running") {
    showStatus("正在整理恢复的标签页…");
    return;
  }
  if (lastRun.state === "error") {
    showStatus(`执行失败：${lastRun.errors?.[0] || "未知错误"}`, true);
    return;
  }

  const prefix = lastRun.trigger === "manual" ? "本次" : "最近启动时";
  const skipped = lastRun.skippedTabs + lastRun.skippedGroups;
  const skippedText = skipped ? `，跳过 ${skipped} 项` : "";
  showStatus(
    `${prefix}检查 ${lastRun.inspectedTabs} 个标签页，收起 ${lastRun.collapsedGroups} 组，卸载 ${lastRun.discardedTabs} 页${skippedText}`
  );
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response ?? {});
    });
  });
}
