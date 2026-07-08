import { render, screen, fireEvent } from '@testing-library/react';
import { EngramSelector } from './EngramSelector';

const conns = [
  { id: 'a', name: 'Local', endpoint: 'ws://a' },
  { id: 'b', name: 'Work', endpoint: 'ws://b' },
];

it('renders the default engram name as the chip label', () => {
  render(<EngramSelector connections={conns} defaultConnId="a" statusById={{ a: true, b: false }} onSetDefault={() => {}} onManage={() => {}} />);
  expect(screen.getByRole('button', { name: /Local/ })).toBeInTheDocument();
});

it('opens a dropdown listing every connection plus a manage entry', () => {
  render(<EngramSelector connections={conns} defaultConnId="a" statusById={{ a: true, b: false }} onSetDefault={() => {}} onManage={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Local/ }));
  expect(screen.getByText('Work')).toBeInTheDocument();
  expect(screen.getByText(/Manage Engrams/)).toBeInTheDocument();
});

it('calls onSetDefault with the picked connection id', () => {
  const onSetDefault = vi.fn();
  render(<EngramSelector connections={conns} defaultConnId="a" statusById={{ a: true, b: false }} onSetDefault={onSetDefault} onManage={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Local/ }));
  fireEvent.click(screen.getByText('Work'));
  expect(onSetDefault).toHaveBeenCalledWith('b');
});

it('calls onManage when the manage entry is picked', () => {
  const onManage = vi.fn();
  render(<EngramSelector connections={conns} defaultConnId="a" statusById={{ a: true, b: false }} onSetDefault={() => {}} onManage={onManage} />);
  fireEvent.click(screen.getByRole('button', { name: /Local/ }));
  fireEvent.click(screen.getByText(/Manage Engrams/));
  expect(onManage).toHaveBeenCalled();
});
