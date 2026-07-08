import * as fs from 'fs';
import * as path from 'path';
it('all prompts/*.md are English', () => {
  const dir = path.join(__dirname, '..', '..', 'prompts');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    expect(/[가-힣]/.test(txt)).toBe(false);
  }
});
