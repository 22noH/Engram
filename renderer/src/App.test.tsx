import { render, screen } from '@testing-library/react';
import App from './App';

it('앱이 타이틀을 렌더한다', () => {
  render(<App />);
  expect(screen.getByText('Engram')).toBeInTheDocument();
});
