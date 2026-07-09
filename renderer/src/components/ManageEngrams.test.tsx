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
  expect(onAdd).toHaveBeenCalledWith('Laptop', 'ws://10.0.0.2:47800', undefined);
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

it('토큰 입력을 onAdd 3번째 인자로 넘긴다', () => {
  const calls: unknown[][] = [];
  const { container } = render(
    <ManageEngrams
      connections={[{ id: 'local', name: 'Local', endpoint: 'ws://x' }]}
      defaultConnId="local"
      onAdd={(...a) => calls.push(a)}
      onRemove={() => {}}
      onSetDefault={() => {}}
      onClose={() => {}}
    />,
  );
  const inputs = container.querySelectorAll('#addEngram input');
  fireEvent.change(inputs[0], { target: { value: 'Remote' } });
  fireEvent.change(inputs[1], { target: { value: 'ws://r' } });
  fireEvent.change(inputs[2], { target: { value: 'tok' } });
  fireEvent.click(screen.getByText(/Add Engram|Engram 추가/));
  expect(calls[0]).toEqual(['Remote', 'ws://r', 'tok']);
});
