import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { InlineEditableText } from './inline-editable-text';

it('shows the value as a button when not editing', () => {
  const { container } = render(
    <InlineEditableText
      value="Agent Name"
      placeholder="Unnamed"
      mutedPlaceholder={false}
      label="Name"
      className="text-xl"
      onChange={() => {}}
    />
  );
  expect(container.querySelector('button')).toHaveTextContent('Agent Name');
});

it('shows the placeholder when value is empty', () => {
  const { container } = render(
    <InlineEditableText
      value=""
      placeholder="Add a name"
      mutedPlaceholder
      label="Name"
      className="text-xl"
      onChange={() => {}}
    />
  );
  expect(container.querySelector('button')).toHaveTextContent('Add a name');
});

it('switches to input on click and calls onChange', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { container } = render(
    <InlineEditableText
      value="Old Name"
      placeholder="Unnamed"
      mutedPlaceholder={false}
      label="Name"
      className="text-xl"
      onChange={onChange}
    />
  );

  await user.click(container.querySelector('button')!);
  const input = screen.getByRole('textbox', { name: 'Name' });
  expect(input).toHaveValue('Old Name');

  await user.clear(input);
  await user.type(input, 'New Name');
  expect(onChange).toHaveBeenCalled();
});

it('reverts value on Escape', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { container } = render(
    <InlineEditableText
      value="Original"
      placeholder="Unnamed"
      mutedPlaceholder={false}
      label="Name"
      className="text-xl"
      onChange={onChange}
    />
  );

  await user.click(container.querySelector('button')!);
  const input = screen.getByRole('textbox');
  await user.clear(input);
  await user.type(input, 'Changed');

  await user.keyboard('{Escape}');
  const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
  expect(lastCall[0]).toBe('Original');
  expect(container.querySelector('button')).toHaveTextContent('Original');
});

it('exits editing on Enter', async () => {
  const user = userEvent.setup();
  const { container } = render(
    <InlineEditableText
      value="Name"
      placeholder="Unnamed"
      mutedPlaceholder={false}
      label="Name"
      className="text-xl"
      onChange={() => {}}
    />
  );

  await user.click(container.querySelector('button')!);
  await user.keyboard('{Enter}');
  expect(container.querySelector('button')).toBeInTheDocument();
});
