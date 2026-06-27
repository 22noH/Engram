import { TurnBudget } from './turn-budget';

it('max까지만 소비하고 그 다음은 거부', () => {
  const b = new TurnBudget(2);
  expect(b.tryConsume()).toBe(true);
  expect(b.tryConsume()).toBe(true);
  expect(b.tryConsume()).toBe(false);
  expect(b.used()).toBe(2);
  expect(b.remaining()).toBe(0);
});
