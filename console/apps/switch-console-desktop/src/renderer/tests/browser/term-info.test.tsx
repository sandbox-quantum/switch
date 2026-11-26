import { GLOSSARY, TermInfo } from '@switch-console/chat-ui/primitives/term-info';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('TermInfo', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('says what the term means, from the one glossary', async () => {
    await act(async () => {
      root.render(<TermInfo term="room" />);
    });
    const button = container.querySelector<HTMLElement>('[aria-label="What “Room” means"]');
    expect(button).not.toBeNull();

    await act(async () => button!.click());

    expect(document.body.textContent).toContain(GLOSSARY.room.meaning);
  });
});
