import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ManageEngrams } from './ManageEngrams';
import { T } from '../i18n';

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
  fireEvent.click(screen.getByText('Connect'));
  expect(onAdd).toHaveBeenCalledWith('Laptop', 'ws://10.0.0.2:47800');
});

it('does not call onAdd when name or endpoint is blank', () => {
  const onAdd = vi.fn();
  render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByText('Connect'));
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

describe('Advanced — create a separate local Engram', () => {
  afterEach(() => {
    delete (window as any).engramDesktop;
  });

  it('does not render the advanced section when window.engramDesktop is undefined', () => {
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    expect(screen.queryByText('Create local Engram')).not.toBeInTheDocument();
  });

  it('does not render the advanced section when window.engramDesktop.addLocalBrain is undefined', () => {
    (window.engramDesktop as any) = {};
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    expect(screen.queryByText('Create local Engram')).not.toBeInTheDocument();
  });

  it('renders the advanced section collapsed by default when addLocalBrain exists', () => {
    (window.engramDesktop as any) = { addLocalBrain: vi.fn() };
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    const details = screen.getByText('Create local Engram').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it('a single click arms the confirm step without calling addLocalBrain', () => {
    const mockAddLocalBrain = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);

    fireEvent.click(screen.getByText('Advanced — create a separate local Engram')); // open details
    fireEvent.click(screen.getByText('Create local Engram'));

    expect(mockAddLocalBrain).not.toHaveBeenCalled();
    expect(screen.getByText('Create? This runs a new instance')).toBeInTheDocument();
  });

  it('a second click on the confirm button calls addLocalBrain and then onAdd with resolved values', async () => {
    const mockAddLocalBrain = vi.fn().mockResolvedValue({ name: 'My brain', endpoint: 'ws://127.0.0.1:47801' });
    const onAdd = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };

    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Advanced — create a separate local Engram'));
    fireEvent.click(screen.getByText('Create local Engram'));
    fireEvent.click(screen.getByText('Create? This runs a new instance'));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith('My brain', 'ws://127.0.0.1:47801');
    });
    expect(mockAddLocalBrain).toHaveBeenCalledTimes(1);
    expect(mockAddLocalBrain).toHaveBeenCalledWith('Local brain');
  });

  it('uses the workspace name input (not the remote-connect name field)', async () => {
    const mockAddLocalBrain = vi.fn().mockResolvedValue({ name: 'Custom', endpoint: 'ws://127.0.0.1:47802' });
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };

    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Advanced — create a separate local Engram'));
    // 원격 연결 폼의 Name 필드에 값을 넣어도 로컬 생성엔 영향 없어야 한다(구버전 버그).
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'RemoteName' } });
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'MyWorkspace' } });
    fireEvent.click(screen.getByText('Create local Engram'));
    fireEvent.click(screen.getByText('Create? This runs a new instance'));

    await waitFor(() => {
      expect(mockAddLocalBrain).toHaveBeenCalledWith('MyWorkspace');
    });
  });

  it('disables the confirm button while the create promise is in flight', async () => {
    let resolve!: (v: { name: string; endpoint: string }) => void;
    const mockAddLocalBrain = vi.fn(() => new Promise<{ name: string; endpoint: string }>((r) => { resolve = r; }));
    const onAdd = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };

    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Advanced — create a separate local Engram'));
    fireEvent.click(screen.getByText('Create local Engram'));
    const confirmBtn = screen.getByText('Create? This runs a new instance');
    fireEvent.click(confirmBtn);

    expect(mockAddLocalBrain).toHaveBeenCalledTimes(1);
    expect(confirmBtn).toBeDisabled();
    // 진행 중 재클릭해도 두 번째 호출은 발생하지 않는다(5연타 방지).
    fireEvent.click(confirmBtn);
    expect(mockAddLocalBrain).toHaveBeenCalledTimes(1);

    resolve({ name: 'X', endpoint: 'ws://127.0.0.1:47803' });
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith('X', 'ws://127.0.0.1:47803'));
  });

  it('does not call onAdd if addLocalBrain resolves with a falsy value', async () => {
    const mockAddLocalBrain = vi.fn().mockResolvedValue(null);
    const onAdd = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };

    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={onAdd} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Advanced — create a separate local Engram'));
    fireEvent.click(screen.getByText('Create local Engram'));
    fireEvent.click(screen.getByText('Create? This runs a new instance'));

    await waitFor(() => {
      expect(mockAddLocalBrain).toHaveBeenCalled();
    });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('closing the details disarms the confirm step', () => {
    const mockAddLocalBrain = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);

    const summary = screen.getByText('Advanced — create a separate local Engram');
    fireEvent.click(summary); // open
    fireEvent.click(screen.getByText('Create local Engram'));
    expect(screen.getByText('Create? This runs a new instance')).toBeInTheDocument();

    fireEvent.click(summary); // close -> disarms
    fireEvent.click(summary); // reopen
    // 다시 armed 없이 원래 라벨로 돌아와 있어야 한다.
    expect(screen.getByText('Create local Engram')).toBeInTheDocument();
    expect(mockAddLocalBrain).not.toHaveBeenCalled();
  });

  it('clicking elsewhere in the modal (not the confirm button) disarms the confirm step', () => {
    const mockAddLocalBrain = vi.fn();
    (window.engramDesktop as any) = { addLocalBrain: mockAddLocalBrain };
    render(<ManageEngrams connections={conns} defaultConnId="a" onAdd={() => {}} onRemove={() => {}} onSetDefault={() => {}} onClose={() => {}} />);

    fireEvent.click(screen.getByText('Advanced — create a separate local Engram'));
    fireEvent.click(screen.getByText('Create local Engram'));
    expect(screen.getByText('Create? This runs a new instance')).toBeInTheDocument();

    fireEvent.click(screen.getByText(T.manageEngrams)); // click the modal heading, not the confirm button
    expect(screen.getByText('Create local Engram')).toBeInTheDocument();
    expect(mockAddLocalBrain).not.toHaveBeenCalled();
  });
});
