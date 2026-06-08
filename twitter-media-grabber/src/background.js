/*
 * Service worker. The extension does most of its work in the content script,
 * so this is intentionally light. Kept for future use (e.g. chrome.downloads
 * fallbacks) and to satisfy MV3's background entry.
 */
chrome.runtime.onInstalled.addListener(function () {
  // no-op; present so install completes cleanly.
});
