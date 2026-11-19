import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NewRoomRow } from './new-room-row';

describe('NewRoomRow', () => {
  it('reads New Room and creates one when clicked', () => {
    const onCreate = vi.fn();
    expect(renderToStaticMarkup(createElement(NewRoomRow, { onCreate }))).toContain('New Room');
    NewRoomRow({ onCreate }).props.onClick();
    expect(onCreate).toHaveBeenCalledOnce();
  });
});
