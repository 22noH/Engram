import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

describe('Add local brain button', () => {
  afterEach(() => {
    delete (window.engramDesktop as any);
  });

  it('does not render "Add local brain" button when window.engramDesktop is undefined', () => {
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    expect(screen.queryByText('Add local brain')).not.toBeInTheDocument();
  });

  it('does not render "Add local brain" button when window.engramDesktop.addLocalBrain is undefined', () => {
    (window.engramDesktop as any) = {};
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    expect(screen.queryByText('Add local brain')).not.toBeInTheDocument();
  });

  it('renders "Add local brain" button when window.engramDesktop.addLocalBrain exists', () => {
    const mockAddLocalBrain = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Add local brain')).toBeInTheDocument();
  });

  it('clicking "Add local brain" calls window.engramDesktop.addLocalBrain and then onAdd with resolved values', async () => {
    const mockAddLocalBrain = vi.fn().mockResolvedValue({ name: 'My brain', endpoint: 'ws://127.0.0.1:47801' });
    const onAdd = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };

    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add local brain'));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith('My brain', 'ws://127.0.0.1:47801');
    });
    expect(mockAddLocalBrain).toHaveBeenCalledWith('Local brain');
  });

  it('clicking "Add local brain" with a name input uses that name', async () => {
    const mockAddLocalBrain = vi.fn().mockResolvedValue({ name: 'Custom brain', endpoint: 'ws://127.0.0.1:47802' });
    const onAdd = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };

    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Name/), { target: { value: 'MyBrain' } });
    fireEvent.click(screen.getByText('Add local brain'));

    await waitFor(() => {
      expect(mockAddLocalBrain).toHaveBeenCalledWith('MyBrain');
    });
  });

  it('does not call onAdd if addLocalBrain resolves with falsy value', async () => {
    const mockAddLocalBrain = vi.fn().mockResolvedValue(null);
    const onAdd = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };

    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add local brain'));

    await waitFor(() => {
      expect(mockAddLocalBrain).toHaveBeenCalled();
    });
    expect(onAdd).not.toHaveBeenCalled();
  });
});
