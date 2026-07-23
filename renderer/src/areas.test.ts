import { areaTabs } from './areas';

// R2-1(Quiet Library 라운드2) — Team 탭이 있을 때 최전방(Team·Chat·Code·Wiki)으로 순서 변경(사용자 승인 목업).
it('flag off면 Chat·Code·Wiki, on이면 Team·Chat·Code·Wiki', () => {
  expect(areaTabs(false)).toEqual(['chat', 'code', 'wiki']);
  expect(areaTabs(true)).toEqual(['team', 'chat', 'code', 'wiki']);
});

it('admin=true면 admin 탭 포함(맨 뒤)', () => {
  expect(areaTabs(true, true)).toEqual(['team', 'chat', 'code', 'wiki', 'admin']);
  expect(areaTabs(true, false)).toEqual(['team', 'chat', 'code', 'wiki']);
});
