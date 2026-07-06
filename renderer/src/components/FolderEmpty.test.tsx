import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FolderEmpty } from './FolderEmpty';

it('네이티브 pickFolder 결과를 onSetRepo로 넘긴다', async () => {
  (window as any).engramDesktop = { pickFolder: async () => 'C:/repo/x' };
  const set: string[] = [];
  render(<FolderEmpty onSetRepo={(p) => set.push(p)} />);
  fireEvent.click(screen.getByText(/폴더 선택|Choose folder/));
  await waitFor(() => expect(set).toEqual(['C:/repo/x']));
  delete (window as any).engramDesktop;
});
