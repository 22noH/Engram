import { render, screen, fireEvent } from '@testing-library/react';
import { ManageEngrams } from './ManageEngrams';

const conns = [
  { id: 'a', name: 'Local', endpoint: 'ws://127.0.0.1:47800' },
  { id: 'b', name: 'Work', endpoint: 'ws://192.168.0.9:47800' },
];

it('lists connections with name, endpoint and default marker', () => {
  render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
  expect(screen.getByText('Local')).toBeInTheDocument();
  expect(screen.getByText('ws://127.0.0.1:47800')).toBeInTheDocument();
  expect(screen.getByText('Work')).toBeInTheDocument();
  expect(screen.getByText('ws://192.168.0.9:47800')).toBeInTheDocument();
});

it('submitting the add form calls onAdd(name, endpoint)', () => {
  const onAdd = vi.fn();
  render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(/Name/), { target: { value: 'Laptop' } });
  fireEvent.change(screen.getByPlaceholderText(/Endpoint/), { target: { value: 'ws://10.0.0.2:47800' } });
  fireEvent.click(screen.getByText('Add Engram'));
  expect(onAdd).toHaveBeenCalledWith('Laptop', 'ws://10.0.0.2:47800');
});

it('does not call onAdd when name or endpoint is blank', () => {
  const onAdd = vi.fn();
  render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByText('Add Engram'));
  expect(onAdd).not.toHaveBeenCalled();
});

it('clicking remove on a non-default row calls onRemove(id)', () => {
  const onRemove = vi.fn();
  render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={onRemove} onSetDefault={() => {}} onClose={() => {}} />);
  const row = screen.getByText('Work').closest('.engramRow') as HTMLElement;
  fireEvent.click(row.querySelector('.danger') as HTMLElement);
  expect(onRemove).toHaveBeenCalledWith('b');
});

it('clicking "set default" on a non-default row calls onSetDefault(id)', () => {
  const onSetDefault = vi.fn();
  render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={onSetDefault} onClose={() => {}} />);
  fireEvent.click(screen.getByText('Set default'));
  expect(onSetDefault).toHaveBeenCalledWith('b');
});
