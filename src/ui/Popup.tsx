import { useEffect, useState } from 'react';
import { publicError } from '../core/errors';
import { senderMatchesSite } from '../core/matching';
import type { Command, Response } from '../core/model';
import { send } from './bridge';
import { checkLabel } from './presentation';

export function Popup() {
  const [result, setResult] = useState<Extract<Response, { ok: true }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<number | null>(null);
  const connected = result?.state.connected ?? false;

  useEffect(() => {
    void chrome.windows.getCurrent().then((window) => setWindowId(window.id ?? null));
  }, []);

  useEffect(() => {
    if (busy) return;
    let stopped = false;
    let timer: number | undefined;
    async function refresh(type: 'state.get' | 'watch.poll') {
      try {
        const current = await send({ type });
        if (!stopped) setResult(current);
      } catch (error) {
        if (!stopped) setError(publicError(error).error);
      } finally {
        if (!stopped)
          timer = window.setTimeout(() => {
            void refresh(connected ? 'watch.poll' : 'state.get');
          }, 3000);
      }
    }
    void refresh('state.get');
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [busy, connected]);

  async function run(command: Command) {
    setBusy(true);
    setError(null);
    try {
      setResult(await send(command));
    } catch (error) {
      setError(publicError(error).error);
      const current = await send({ type: 'state.get' }).catch(() => null);
      if (current) setResult(current);
    } finally {
      setBusy(false);
    }
  }

  function openPanel() {
    if (windowId === null) return;
    void chrome.sidePanel
      .open({ windowId })
      .then(() => window.close())
      .catch(() => setError('Could not open the panel. Click the Maildock icon and try again.'));
  }

  async function copy(code: string, messageId: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(messageId);
    } catch {
      setError('The clipboard is not available. Select the code and copy it by hand.');
    }
  }

  const target = result?.target;
  const host = target ? new URL(target.origin).host : null;
  const watch = result?.state.watch;
  const codes = (watch?.items ?? [])
    .filter((item) => item.kind === 'code')
    .filter((item) => item.check !== 'fail')
    .sort(
      (a, b) =>
        Number(!!target && senderMatchesSite(b.sender, target.origin)) -
          Number(!!target && senderMatchesSite(a.sender, target.origin)) ||
        b.receivedAt - a.receivedAt,
    );

  return (
    <div className="popup-shell">
      <header className="header">
        <span className="brand">Maildock</span>
        <button type="button" className="text-button" onClick={() => window.close()}>
          Close
        </button>
      </header>
      <main>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {!result ? (
          <p role="status">Opening Maildock…</p>
        ) : !connected ? (
          <section className="popup-empty">
            <h1>Your next code, right here.</h1>
            <p>Connect your Resend inbox to show new codes in this popup.</p>
            <button
              type="button"
              className="primary"
              disabled={windowId === null}
              onClick={openPanel}
            >
              Connect inbox
            </button>
          </section>
        ) : codes.length ? (
          <>
            <h1>{codes.length === 1 ? 'Your code is ready' : 'Your codes are ready'}</h1>
            {codes.map((item) => (
              <section
                className="popup-code"
                key={item.messageId}
                aria-label={`Code from ${item.sender}`}
              >
                <div className="popup-sender">
                  <span>{item.sender}</span>
                  <span className={`check check-${checkLabel[item.check].tone}`}>
                    {checkLabel[item.check].text}
                  </span>
                </div>
                <p className="popup-subject">{item.subject}</p>
                <code className="code-display">{item.code}</code>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !target}
                  onClick={() => {
                    if (target) void run({ type: 'watch.fill', messageId: item.messageId, target });
                  }}
                >
                  {busy ? 'Working…' : host ? `Fill code on ${host}` : 'Fill code'}
                </button>
                <div className="popup-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void copy(item.code, item.messageId)}
                  >
                    {copied === item.messageId ? 'Copied' : 'Copy code'}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void run({ type: 'watch.dismiss', messageId: item.messageId })}
                  >
                    Dismiss code
                  </button>
                </div>
              </section>
            ))}
            {!target && (
              <p className="field-hint">
                To enable Fill, close this popup and click the Maildock toolbar icon on your login
                page.
              </p>
            )}
          </>
        ) : (
          <section className="popup-empty" role="status">
            <h1>{watch?.lastFill ? 'Code filled' : 'Waiting for a code'}</h1>
            <p>
              {watch?.lastFill
                ? `Continue on ${new URL(watch.lastFill.origin).host}.`
                : 'You can close this popup. New codes will appear here when they arrive.'}
            </p>
          </section>
        )}
        {watch?.note && (
          <p className="notice" role="status">
            {watch.note}
          </p>
        )}
      </main>
      <footer>
        <span>{connected ? 'Connected to Resend' : 'Local session'}</span>
        <button
          type="button"
          className="text-button"
          disabled={busy || windowId === null}
          onClick={openPanel}
        >
          Open Maildock
        </button>
      </footer>
    </div>
  );
}
