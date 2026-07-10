import { areaTabs } from './areas';

it('flag off면 Ask·Code·Wiki, on이면 Ask·Team·Code·Wiki', () => {
  expect(areaTabs(false)).toEqual(['chat', 'code', 'wiki']);
  expect(areaTabs(true)).toEqual(['chat', 'team', 'code', 'wiki']);
});
