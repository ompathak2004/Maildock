import { defineBackground } from 'wxt/utils/define-background';
import { handleMessage, pollInbox } from '../background/controller';
import { initializeStorage } from '../background/storage';

export default defineBackground(() => {
  const ready = initializeStorage().then(async () => {
    await Promise.all([
      chrome.action.setBadgeBackgroundColor({ color: '#171717' }),
      chrome.action.setBadgeTextColor({ color: '#ffffff' }),
      chrome.alarms.clear('expire-attempt'),
    ]);
    if (!(await chrome.alarms.get('watch-inbox')))
      await chrome.alarms.create('watch-inbox', { periodInMinutes: 0.5 });
  });
  const refresh = () => {
    void ready.then(pollInbox).catch(() => chrome.action.setBadgeText({ text: '' }));
  };
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
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'watch-inbox') refresh();
  });
  refresh();
});
