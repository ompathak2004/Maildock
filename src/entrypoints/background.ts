import { defineBackground } from 'wxt/utils/define-background';
import { handleMessage, state } from '../background/controller';
import { initializeStorage } from '../background/storage';

export default defineBackground(() => {
  const ready = initializeStorage();
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    void ready
      .then(() => handleMessage(message, sender))
      .then(sendResponse)
      .catch(() =>
        sendResponse({
          ok: false,
          code: 'storage',
          error: 'Maildock could not initialize secure session storage.',
        }),
      );
    return true;
  });
  chrome.action.onClicked.addListener((tab) => {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  });
  void chrome.alarms.create('expire-attempt', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'expire-attempt')
      void ready.then(() => navigator.locks.request('maildock-state', state));
  });
});
