import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { publicError } from '../core/errors';
import { type Command, emailAddress, inboxId, type Target, type ViewState } from '../core/model';
import { send } from './bridge';
import { ParticleWordmark } from './ParticleWordmark';

export function App() {
  const [view, setView] = useState<ViewState | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [sender, setSender] = useState('');
  const [codeLength, setCodeLength] = useState(6);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [reviewedMessageId, setReviewedMessageId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [now, setNow] = useState(Date.now());
  const polling = useRef(false);

  const run = useCallback(async (command: Command) => {
    setBusy(command.type);
    setError(null);
    try {
      const result = await send(command);
      setView(result.state);
      if (result.target) {
        setTarget(result.target);
        const rule = result.state.settings.rules.find(
          (value) => value.origin === result.target?.origin,
        );
        setSender(rule?.sender ?? '');
        setCodeLength(rule?.codeLength ?? 6);
      }
      if (command.type === 'auth.disconnect') {
        setTarget(null);
        setSender('');
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
      if (current) setView(current.state);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void run({ type: 'state.get' });
  }, [run]);
  const attempt = view?.attempt;
  const attemptId = attempt?.id;
  const phase = attempt?.phase;
  const candidateId = attempt?.phase === 'ready' ? attempt.candidate.messageId : null;
  const reviewed = candidateId !== null && reviewedMessageId === candidateId;

  useEffect(() => {
    if (!attemptId || (phase !== 'watching' && phase !== 'ready') || busy) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (polling.current) return;
      polling.current = true;
      void send({ type: 'watch.poll', attemptId })
        .then((result) => {
          setView(result.state);
        })
        .catch((error: unknown) => {
          setError(publicError(error).error);
        })
        .finally(() => {
          polling.current = false;
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [attemptId, phase, busy]);

  const selected =
    view?.inboxes.find((value) => value.id === view.settings.selectedInboxId) ?? view?.inboxes[0];
  const active = phase === 'watching' || phase === 'ready';
  const disabled = !!busy;

  function start(event: FormEvent) {
    event.preventDefault();
    const parsed = emailAddress.safeParse(sender.trim());
    if (!selected || !target || !parsed.success) {
      setError('Enter the exact email address this website sends codes from.');
      return;
    }
    void run({
      type: 'watch.start',
      inboxId: selected.id,
      target,
      sender: parsed.data,
      codeLength,
    });
  }

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
              <p>Choose an inbox. Watch for a code. Fill when ready.</p>
            </div>
            <section className="card">
              <div className="section-heading">
                <h2>Your inbox</h2>
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled || active}
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
                    disabled={disabled || active}
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
                disabled={disabled || active}
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
            {!active && (
              <section className="card">
                <div className="section-heading">
                  <h2>The website</h2>
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled}
                    onClick={() => void run({ type: 'target.get' })}
                  >
                    {busy === 'target.get'
                      ? 'Checking…'
                      : target
                        ? 'Change tab'
                        : 'Use current tab'}
                  </button>
                </div>
                {target ? (
                  <div className="site">
                    <div>
                      <strong>{new URL(target.origin).host}</strong>
                      <span>{target.title || 'Your active tab'}</span>
                    </div>
                  </div>
                ) : (
                  <p className="field-hint">
                    Open the login page and click Maildock in your browser toolbar. Then select “Use
                    current tab”.
                  </p>
                )}
                <form onSubmit={start} className="watch-form">
                  <label htmlFor="sender">Expected sender address</label>
                  <input
                    id="sender"
                    type="email"
                    placeholder="accounts@example.com"
                    value={sender}
                    onChange={(event) => setSender(event.target.value)}
                    required
                    maxLength={254}
                  />
                  <p className="field-hint">
                    Use the exact sender from a previous verification email. The sender is not
                    necessarily the website’s domain.
                  </p>
                  <div className="length-row">
                    <label htmlFor="length">Code length</label>
                    <select
                      id="length"
                      value={codeLength}
                      onChange={(event) => setCodeLength(Number(event.target.value))}
                    >
                      {[4, 5, 6, 7, 8].map((value) => (
                        <option key={value} value={value}>
                          {value} characters
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="instruction">
                    <p>
                      Start watching here.
                      <br />
                      <strong>Then request a new code on the website.</strong>
                    </p>
                  </div>
                  <button
                    type="submit"
                    className="primary"
                    disabled={disabled || !selected || !target || !sender}
                  >
                    {busy === 'watch.start' ? 'Preparing inbox…' : 'Start watching'}
                  </button>
                </form>
              </section>
            )}
            {attempt?.phase === 'watching' && (
              <section className="card watch-card" aria-live="polite">
                <p className="eyebrow">Watching for a new email</p>
                <h2>Now request your code.</h2>
                <p>
                  Waiting for <strong>{attempt.sender}</strong>
                </p>
                <dl className="message-details route">
                  <div>
                    <dt>Inbox</dt>
                    <dd>{attempt.inbox.email_address}</dd>
                  </div>
                  <div>
                    <dt>Website</dt>
                    <dd>{new URL(attempt.target.origin).host}</dd>
                  </div>
                </dl>
                {attempt.note && <p className="notice">{attempt.note}</p>}
                <div className="watch-bottom">
                  <span>{Math.max(0, Math.ceil((attempt.expiresAt - now) / 1000))}s remaining</span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled}
                    onClick={() => void run({ type: 'watch.stop' })}
                  >
                    Stop watching
                  </button>
                </div>
                <p className="fine-print">
                  Keep this panel open. Navigating to a new page ends this watch.
                </p>
              </section>
            )}
            {attempt?.phase === 'ready' && (
              <section className="card result-card" aria-live="polite">
                <p className="eyebrow">Code received</p>
                <h2>Ready when you are.</h2>
                <output
                  className="code-display"
                  aria-label={`Verification code ${attempt.candidate.code}`}
                >
                  {attempt.candidate.code}
                </output>
                <dl className="message-details">
                  <div>
                    <dt>From</dt>
                    <dd>{attempt.candidate.sender}</dd>
                  </div>
                  <div>
                    <dt>Subject</dt>
                    <dd>{attempt.candidate.subject}</dd>
                  </div>
                  <div>
                    <dt>Fill on</dt>
                    <dd>{new URL(attempt.target.origin).host}</dd>
                  </div>
                </dl>
                <div className="permission-note">
                  <strong>Review before filling</strong>
                  <p>
                    Resend does not expose sender authentication in this Inbox response. Matching
                    the address alone does not prove who sent the email.
                  </p>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(event) =>
                      setReviewedMessageId(event.target.checked ? candidateId : null)
                    }
                  />
                  <span>I requested this code for this website and reviewed the sender.</span>
                </label>
                <button
                  type="button"
                  className="primary"
                  disabled={disabled || !reviewed}
                  onClick={() =>
                    void run({
                      type: 'watch.fill',
                      attemptId: attempt.id,
                      messageId: attempt.candidate.messageId,
                      reviewedSender: true,
                    })
                  }
                >
                  {busy === 'watch.fill' ? 'Checking and filling…' : 'Fill code'}
                </button>
                <p className="fine-print">
                  Maildock never clicks Submit. Some websites submit when a field is filled.
                </p>
                <button
                  type="button"
                  className="text-button centered"
                  disabled={disabled}
                  onClick={() => void run({ type: 'watch.stop' })}
                >
                  Discard code
                </button>
              </section>
            )}
            {attempt?.phase === 'filled' && (
              <section className="card complete" role="status">
                <h2>You’re ready to continue.</h2>
                <p>
                  The code was filled on {new URL(attempt.target.origin).host}. Maildock has cleared
                  its copy.
                </p>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() => void run({ type: 'watch.stop' })}
                >
                  Done
                </button>
              </section>
            )}
            {attempt?.phase === 'stopped' && (
              <section className="notice" role="status">
                {attempt.reason}
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
