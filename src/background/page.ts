import { AppError } from '../core/errors';
import { type Target, targetSchema } from '../core/model';

export async function captureTarget(): Promise<Target> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined)
    throw new AppError('no-tab', 'Open a website and click the Maildock toolbar button.');
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: () => ({
        origin: location.origin,
        title: document.title.slice(0, 200),
        protocol: location.protocol,
      }),
    });
    if (result?.result?.protocol !== 'https:' || !result.documentId) throw new Error('unsupported');
    return targetSchema.parse({
      tabId: tab.id,
      documentId: result.documentId,
      origin: result.result.origin,
      title: result.result.title,
    });
  } catch {
    throw new AppError(
      'page-access',
      'Open the page with the code field, then click the Maildock toolbar icon to allow filling on that tab.',
    );
  }
}

async function assertTarget(target: Target): Promise<void> {
  const current = await captureTarget();
  if (
    current.tabId !== target.tabId ||
    current.documentId !== target.documentId ||
    current.origin !== target.origin
  ) {
    throw new AppError('page-changed', 'The page changed. Check the website shown and try again.');
  }
}

function fillInPage(
  origin: string,
  code: string,
): 'filled' | 'wrong-origin' | 'no-field' | 'ambiguous' | 'failed' {
  if (location.origin !== origin || location.protocol !== 'https:' || window !== window.top)
    return 'wrong-origin';
  const visible = (input: HTMLInputElement) =>
    !input.disabled &&
    !input.readOnly &&
    input.type !== 'hidden' &&
    input.type !== 'password' &&
    input.getClientRects().length > 0 &&
    getComputedStyle(input).visibility === 'visible' &&
    getComputedStyle(input).display !== 'none' &&
    input.getAttribute('aria-hidden') !== 'true';
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const isCode = (input: HTMLInputElement) =>
    input.autocomplete === 'one-time-code' ||
    /(?:^|[\s_-])(?:otp|verification|security|auth|login|one.?time|code)(?:[\s_-]|$)/i.test(
      `${input.name} ${input.id} ${input.getAttribute('aria-label') ?? ''} ${input.placeholder}`,
    );
  const groups = new Map<Element, HTMLInputElement[]>();
  for (const input of inputs.filter(
    (value) =>
      value.maxLength === 1 &&
      (value.inputMode === 'numeric' || isCode(value) || value.pattern === '[0-9]*'),
  )) {
    const group = input.closest('fieldset, [role="group"]') ?? input.parentElement;
    if (group) groups.set(group, [...(groups.get(group) ?? []), input]);
  }
  const split = [...groups.values()].filter((values) => values.length === code.length);
  const single = inputs.filter(
    (input) =>
      input.maxLength !== 1 &&
      isCode(input) &&
      (input.maxLength < 0 || input.maxLength >= code.length) &&
      !/postal|zip|coupon|promo|recovery|backup/i.test(
        `${input.name} ${input.id} ${input.getAttribute('aria-label') ?? ''}`,
      ),
  );
  if (split.length + single.length === 0) return 'no-field';
  if (split.length + single.length !== 1) return 'ambiguous';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return 'failed';
  const fields = split[0] ?? single;
  if (fields.some((input) => input.value.trim() !== '')) return 'ambiguous';
  for (const [index, input] of fields.entries()) {
    setter.call(input, split.length ? code[index] : code);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  fields.at(-1)?.focus();
  return 'filled';
}

export async function fillTarget(target: Target, code: string): Promise<void> {
  await assertTarget(target);
  let result: chrome.scripting.InjectionResult<ReturnType<typeof fillInPage>>[];
  try {
    result = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      func: fillInPage,
      args: [target.origin, code],
    });
  } catch {
    throw new AppError(
      'page-changed',
      'The target page is no longer available. No code was submitted by Maildock.',
    );
  }
  const status = result[0]?.result;
  if (status === 'no-field')
    throw new AppError(
      'no-field',
      'No supported verification field was found. Single fields and grouped digit fields are supported.',
    );
  if (status === 'ambiguous')
    throw new AppError(
      'ambiguous-field',
      'The page has multiple possible fields or already contains a code. Clear the correct field and try again.',
    );
  if (status !== 'filled')
    throw new AppError(
      'fill-failed',
      'The page could not be filled safely. Try entering the code manually.',
    );
}
