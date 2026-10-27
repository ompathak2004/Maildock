import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { publicError } from '../core/errors';
import { senderMatchesSite } from '../core/matching';
import {
  type Candidate,
  type Command,
  emailAddress,
  inboxId,
  type Target,
  type ViewState,
} from '../core/model';
import { send } from './bridge';
import { ParticleWordmark } from './ParticleWordmark';
import { checkLabel } from './presentation';

const allowHint =
  'Open the page with the code field, then click the Maildock toolbar icon to allow filling on that tab.';

// Sites the user allowed permanently through chrome.permissions; filling there needs no toolbar
// click. Managed from the panel so the grant and its removal are both explicit user gestures.
async function allowedSites(): Promise<string[]> {
  const granted = await chrome.permissions.getAll();
  return (granted.origins ?? []).filter((value) => value !== 'https://api.resend.com/*');
}

function sitePattern(origin: string): string {
  return `${origin}/*`;
}

export function App() {
  const [view, setView] = useState<ViewState | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [now, setNow] = useState(Date.now());
  const [sites, setSites] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const polling = useRef(false);

  const run = useCallback(async (command: Command) => {
    setBusy(command.type);
    setError(null);
    try {
      const result = await send(command);
      setView(result.state);
      if (command.type === 'state.get' || command.type === 'watch.poll') setTarget(result.target);
      if (command.type === 'auth.disconnect') {
        setTarget(null);
        setAccepted(false);
      }
      if (command.type === 'inbox.create') {
        setCreating(false);
        setNewEmail('');
        setNewName('');
      }
    } catch (error) {
      setError(publicError(error).error);
      const current = await send({ type: 'state.get' }).catch(() => null);
      if (current) {
        setView(current.state);
        setTarget(current.target);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void run({ type: 'state.get' });
    void allowedSites().then(setSites);
  }, [run]);

  async function allowSite(origin: string) {
    setError(null);
    const granted = await chrome.permissions
      .request({ origins: [sitePattern(origin)] })
      .catch(() => false);
    if (!granted) setError(`Maildock was not allowed on ${new URL(origin).host}.`);
    setSites(await allowedSites());
    await run({ type: 'watch.poll' });
  }

  async function forgetSite(pattern: string) {
    await chrome.permissions.remove({ origins: [pattern] }).catch(() => false);
    setSites(await allowedSites());
  }

  async function copy(item: Extract<Candidate, { kind: 'code' }>) {
    try {
      await navigator.clipboard.writeText(item.code);
      setCopied(item.messageId);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('The clipboard is not available. Select the code and copy it by hand.');
    }
  }
  const connected = view?.connected ?? false;
  const watch = view?.watch;

  useEffect(() => {
    if (!connected || busy) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (polling.current) return;
      polling.current = true;
      void send({ type: 'watch.poll' })
        .then((result) => {
          setView(result.state);
          setTarget(result.target);
        })
        .catch((error: unknown) => {
          setError(publicError(error).error);
        })
        .finally(() => {
          polling.current = false;
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [connected, busy]);

  const selected =
    view?.inboxes.find((value) => value.id === view.settings.selectedInboxId) ?? view?.inboxes[0];
  const disabled = !!busy;
  const host = target ? new URL(target.origin).host : null;
  const knownSender = view?.settings.rules.find((value) => value.origin === target?.origin)?.sender;
  const seconds = (at: number) => Math.max(0, Math.round((now - at) / 1000));
  const matchesSite = (item: Candidate) =>
    !!target && senderMatchesSite(item.sender, target.origin);
  // Newest first, except that a sender from the current website's domain moves to the top.
  const items = [...(watch?.items ?? [])].sort(
    (a, b) => Number(matchesSite(b)) - Number(matchesSite(a)) || b.receivedAt - a.receivedAt,
  );
  const siteAllowed = (origin: string) => sites.includes(sitePattern(origin));

  function create(event: FormEvent) {
    event.preventDefault();
    const parsed = emailAddress.safeParse(newEmail.trim());
    if (!parsed.success) {
      setError('Enter an address on your verified receiving domain.');
      return;
    }
    void run({ type: 'inbox.create', email: parsed.data, name: newName.trim() });
  }

  return (
    <div className="app-shell">
      <header className="header">
        <div className="brand">
          {view?.connected ? <ParticleWordmark compact /> : <span>Maildock</span>}
          <span className="beta">Preview</span>
        </div>
        <span className="local-badge">Local session</span>
      </header>
      <main>
        {error && (
          <div className="alert" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="dismiss"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        {!view ? (
          <div className="loading" role="status">
            Opening your workspace…
          </div>
        ) : !view.connected ? (
          <>
            <section className="welcome">
              <div className="brand-display">
                <ParticleWordmark />
              </div>
              <h1>
                Your code.
                <br />
                Right where you need it.
              </h1>
              <p className="intro">
                Bring verification emails from Resend to your login tab. Review, fill, and get back
                to work.
              </p>
            </section>
            <section className="card">
              <div className="card-heading">
                <img className="provider-logo" src="/resend.webp" alt="" width={40} height={40} />
                <div>
                  <h2>Connect Resend</h2>
                  <p>Your inbox, on your device.</p>
                </div>
              </div>
              <div className="permission-note">
                <strong>A powerful permission</strong>
                <p>
                  Resend currently requires full account access to read inboxes. Use a dedicated
                  account. Maildock keeps credentials in this browser session.
                </p>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>I understand the account access I’m granting.</span>
              </label>
              <button
                type="button"
                className="primary"
                disabled={!accepted || disabled}
                onClick={() => void run({ type: 'auth.connect' })}
              >
                {busy === 'auth.connect' ? 'Connecting…' : 'Continue with Resend'}
              </button>
              <p className="fine-print">You’ll sign in securely on Resend. No API key to paste.</p>
            </section>
            <div className="promise">
              <p>
                Maildock has no email-processing server.
                <br />
                Your mail stays with your provider and this browser.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="page-heading">
              <p className="eyebrow">Verification</p>
              <h1>Your inbox, in reach.</h1>
              <p>Request a code on the website. It appears here. Fill it with one click.</p>
            </div>
            <section className="card">
              <div className="section-heading">
                <h2>Your inbox</h2>
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled}
                  onClick={() => void run({ type: 'inbox.list' })}
                >
                  {busy === 'inbox.list' ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
              {view.inboxes.length ? (
                <>
                  <label className="sr-only" htmlFor="inbox">
                    Inbox
                  </label>
                  <select
                    id="inbox"
                    value={selected?.id ?? ''}
                    disabled={disabled}
                    onChange={(event) =>
                      void run({ type: 'inbox.select', inboxId: inboxId.parse(event.target.value) })
                    }
                  >
                    {view.inboxes.map((inbox) => (
                      <option key={inbox.id} value={inbox.id}>
                        {inbox.email_address}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">
                    Use this address on the website requesting your code.
                  </p>
                </>
              ) : (
                <div className="empty">
                  <p>No inboxes found.</p>
                  <span>
                    Create an inbox on a verified receiving domain, or refresh after adding one in
                    Resend.
                  </span>
                </div>
              )}
              <button
                type="button"
                className="text-button create-link"
                disabled={disabled}
                onClick={() => setCreating(!creating)}
              >
                {creating ? 'Cancel' : 'Create an inbox'}
              </button>
              {creating && (
                <form onSubmit={create} className="create-form">
                  <label htmlFor="new-email">Email address</label>
                  <input
                    id="new-email"
                    type="email"
                    value={newEmail}
                    onChange={(event) => setNewEmail(event.target.value)}
                    placeholder="work@yourdomain.com"
                    required
                    maxLength={254}
                  />
                  <label htmlFor="new-name">Inbox name</label>
                  <input
                    id="new-name"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="Work"
                    required
                    maxLength={64}
                  />
                  <p className="field-hint">
                    The domain needs receiving configured. Creating an inbox can affect your Resend
                    bill.
                  </p>
                  <button type="submit" className="secondary" disabled={disabled}>
                    {busy === 'inbox.create' ? 'Creating…' : 'Create inbox'}
                  </button>
                </form>
              )}
            </section>
            {watch?.lastFill && (
              <section className="card complete" role="status">
                <h2>You’re ready to continue.</h2>
                <p>
                  The code was filled on {new URL(watch.lastFill.origin).host}. Maildock has cleared
                  its copy.
                </p>
                {!siteAllowed(watch.lastFill.origin) && (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled}
                      onClick={() => watch.lastFill && void allowSite(watch.lastFill.origin)}
                    >
                      Always allow {new URL(watch.lastFill.origin).host}
                    </button>
                    <p className="fine-print">
                      Skips the toolbar click on this website next time. Maildock still fills only
                      when you press Fill. Remove the site any time below.
                    </p>
                  </>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() => void run({ type: 'watch.done' })}
                >
                  Done
                </button>
              </section>
            )}
            {selected && watch && items.length === 0 && (
              <section className="card watch-card" aria-live="polite">
                <p className="eyebrow">Watching your inbox</p>
                <h2>Request your code on the website.</h2>
                <p>New verification emails to {selected.email_address} appear here.</p>
                <p className="fine-print">
                  You can close this panel. Maildock checks every 30 seconds in the background,
                  though Chrome may delay checks. A compact popup opens when a new code arrives. Pin
                  the toolbar icon to reopen it if you miss it.
                </p>
                {watch.note && <p className="notice">{watch.note}</p>}
                <div className="watch-bottom">
                  <span>
                    {watch.checkedAt ? `Checked ${seconds(watch.checkedAt)}s ago` : 'Checking…'}
                  </span>
                  <span>{host ? `Ready to fill on ${host}` : 'No tab allowed yet'}</span>
                </div>
                {!host && <p className="fine-print">{allowHint}</p>}
              </section>
            )}
            {items.map((item, index) => {
              const check = checkLabel[item.check];
              const blocked = item.check === 'fail';
              const hint = !host
                ? null
                : matchesSite(item)
                  ? `Matches ${host}.`
                  : !knownSender
                    ? `First code for ${host}. Check the address.`
                    : knownSender === item.sender
                      ? 'Same sender as your last fill here.'
                      : `Differs from ${knownSender}, which you used here before.`;
              const linkHost = item.kind === 'link' ? new URL(item.url).host : null;
              return (
                <section
                  key={item.messageId}
                  className="card result-card"
                  aria-live={index === 0 ? 'polite' : undefined}
                >
                  <p className="eyebrow">
                    {item.kind === 'link'
                      ? 'Sign-in link'
                      : index === 0
                        ? 'Code received'
                        : 'Earlier code'}{' '}
                    · {seconds(item.receivedAt)}s ago
                  </p>
                  {item.kind === 'code' ? (
                    <output className="code-display" aria-label={`Verification code ${item.code}`}>
                      {item.code}
                    </output>
                  ) : (
                    <p className="link-display">{linkHost}</p>
                  )}
                  <dl className="message-details">
                    <div>
                      <dt>From</dt>
                      <dd>
                        {item.sender}{' '}
                        <span className={`check check-${check.tone}`}>{check.text}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Subject</dt>
                      <dd>{item.subject}</dd>
                    </div>
                    {item.kind === 'code' && (
                      <div>
                        <dt>Fill on</dt>
                        <dd>{host ?? 'No tab allowed yet'}</dd>
                      </div>
                    )}
                    {item.kind === 'code' && hint && (
                      <div>
                        <dt>Sender</dt>
                        <dd>{hint}</dd>
                      </div>
                    )}
                  </dl>
                  {blocked && (
                    <p className="notice">
                      Resend could not authenticate this sender. Maildock will not fill, copy, or
                      open it. Request a new code on the website.
                    </p>
                  )}
                  {watch?.note && <p className="notice">{watch.note}</p>}
                  {item.kind === 'code' ? (
                    <>
                      <button
                        type="button"
                        className="primary"
                        disabled={disabled || !target || blocked}
                        onClick={() =>
                          target &&
                          void run({ type: 'watch.fill', messageId: item.messageId, target })
                        }
                      >
                        {busy === 'watch.fill'
                          ? 'Checking and filling…'
                          : host
                            ? `Fill ${item.code} on ${host}`
                            : 'Fill code'}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={disabled || blocked}
                        onClick={() => void copy(item)}
                      >
                        {copied === item.messageId ? 'Copied' : 'Copy code'}
                      </button>
                      <p className="fine-print">
                        {host
                          ? 'Filling is your confirmation that you requested this code for this website. Maildock never clicks Submit.'
                          : allowHint}
                      </p>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary"
                        disabled={disabled || blocked}
                        onClick={() => void run({ type: 'watch.open', messageId: item.messageId })}
                      >
                        {busy === 'watch.open' ? 'Opening…' : `Open link on ${linkHost}`}
                      </button>
                      <p className="fine-print">
                        Opens in a new tab only when you press the button. Check that the website
                        matches the one you signed in to.
                      </p>
                    </>
                  )}
                  <button
                    type="button"
                    className="text-button centered"
                    disabled={disabled}
                    onClick={() => void run({ type: 'watch.dismiss', messageId: item.messageId })}
                  >
                    {item.kind === 'code' ? 'Discard code' : 'Discard link'}
                  </button>
                </section>
              );
            })}
            {sites.length > 0 && (
              <section className="card">
                <h2>Allowed websites</h2>
                <p className="field-hint">Maildock can fill here without the toolbar click.</p>
                <ul className="site-list">
                  {sites.map((pattern) => (
                    <li key={pattern}>
                      <span>{new URL(pattern.replace(/\/\*$/, '/')).host}</span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={disabled}
                        onClick={() => void forgetSite(pattern)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="connection-row">
              <span>Resend connected</span>
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() => void run({ type: 'auth.disconnect' })}
              >
                {busy === 'auth.disconnect' ? 'Revoking access…' : 'Disconnect'}
              </button>
            </div>
            <p className="session-note">
              Session only. Reconnect after restarting your browser.
              <br />
              Disconnect revokes the Resend grant.
            </p>
          </>
        )}
      </main>
      <footer>
        <span>Local by design.</span>
        <a href="https://resend.com/inboxes" target="_blank" rel="noreferrer">
          Open Resend
        </a>
      </footer>
    </div>
  );
}
