import { areaTabs } from './areas';

it('flag off면 Ask·Code·Wiki, on이면 Ask·Team·Code·Wiki', () => {
  expect(areaTabs(false)).toEqual(['chat', 'code', 'wiki']);
  expect(areaTabs(true)).toEqual(['chat', 'team', 'code', 'wiki']);
});

it('admin=true면 admin 탭 포함(맨 뒤)', () => {
  expect(areaTabs(true, true)).toEqual(['chat', 'team', 'code', 'wiki', 'admin']);
  expect(areaTabs(true, false)).toEqual(['chat', 'team', 'code', 'wiki']);
});
