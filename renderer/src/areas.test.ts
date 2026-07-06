import { areaTabs } from './areas';

it('flag off면 Ask·Code만, on이면 Team이 Ask와 Code 사이에', () => {
  expect(areaTabs(false)).toEqual(['chat', 'code']);
  expect(areaTabs(true)).toEqual(['chat', 'team', 'code']);
});
