import { beforeEach, describe, expect, it, vi } from 'vitest';

// The confirm before anything leaves the app: web links go to the browser, and
// an email (mailto:) link goes to the mail app, as it did before the window
// lockdown. Nothing else is ever offered.

const showModal = vi.hoisted(() => vi.fn());
const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal }));
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));

const { confirmOpenExternalLink } = await import('./open-external-link');

type ModalArgs = { url: string; onSuccess: () => void };
const lastModal = () => showModal.mock.calls.at(-1)?.[1] as ModalArgs | undefined;

beforeEach(() => {
  showModal.mockClear();
  openExternalUrl.mockClear();
});

describe('confirmOpenExternalLink', () => {
  it('asks before an email link, then hands exactly that link on to open', () => {
    confirmOpenExternalLink(' mailto:someone@example.com?subject=Hi ');
    expect(showModal).toHaveBeenCalledWith('confirmExternalLinkModal', expect.anything());
    expect(lastModal()?.url).toBe('mailto:someone@example.com?subject=Hi');
    expect(openExternalUrl).not.toHaveBeenCalled();
    lastModal()?.onSuccess();
    expect(openExternalUrl).toHaveBeenCalledWith(
      'mailto:someone@example.com?subject=Hi',
      'Could not open the link'
    );
  });

  it('asks before a web link, as before', () => {
    confirmOpenExternalLink('https://example.com/docs.');
    expect(lastModal()?.url).toBe('https://example.com/docs');
  });

  it('offers nothing for any other scheme', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/hosts', 'mailtox:a@b.c', 'ftp://x/y'])
      confirmOpenExternalLink(url);
    expect(showModal).not.toHaveBeenCalled();
  });
});
