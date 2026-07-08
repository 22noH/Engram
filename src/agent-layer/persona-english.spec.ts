import * as fs from 'fs';
import * as path from 'path';

it('all personas/*.md are English', () => {
  const dir = path.join(__dirname, '..', '..', 'personas');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  expect(files.length).toBe(8);
  for (const f of files) {
    expect(/[가-힣]/.test(fs.readFileSync(path.join(dir, f), 'utf8'))).toBe(false);
  }
});
