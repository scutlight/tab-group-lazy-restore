const key = location.hash.slice(1);
const storageKey = `suspended-record-${key}`;
const title = document.getElementById("title");
const url = document.getElementById("url");
const resume = document.getElementById("resume");
const record = key ? (await chrome.storage.local.get(storageKey))[storageKey] : null;

if (record?.url && isSafeRestoreUrl(record.url)) {
  title.textContent = record.title || "发现旧版休眠标签页";
  url.textContent = record.url;
  resume.href = record.url;
  resume.hidden = false;
} else {
  title.textContent = "找不到可恢复的原网址";
  url.textContent = "这个旧版记录缺失或网址不安全；扩展不会猜测、创建或移动标签页。";
}

function isSafeRestoreUrl(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "file:", "ftp:", "chrome:", "about:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}
