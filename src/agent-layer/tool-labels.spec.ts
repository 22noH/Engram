import { toolLabel } from './tool-labels';

describe('toolLabel', () => {
  it('알려진 7종: wiki_search·web_search·fetch_url·코딩도구(대표 Bash)·ask_brain·ask_user·MCP접두는 이름 그대로(ko)', () => {
    expect(toolLabel('wiki_search', 'ko')).toBe('위키 검색 중');
    expect(toolLabel('web_search', 'ko')).toBe('웹 검색 중');
    expect(toolLabel('fetch_url', 'ko')).toBe('페이지 읽는 중');
    expect(toolLabel('Bash', 'ko')).toBe('코드 작업 중');
    expect(toolLabel('ask_brain', 'ko')).toBe('다른 모델에 위임 중');
    expect(toolLabel('ask_user', 'ko')).toBe('질문 게시 중');
    expect(toolLabel('mcp__engram__wiki_search', 'ko')).toBe('mcp__engram__wiki_search');
  });

  it('코딩 도구 그룹 전체(Read/Write/Edit/Glob/Grep)가 같은 라벨로 묶인다', () => {
    for (const name of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
      expect(toolLabel(name, 'ko')).toBe('코드 작업 중');
      expect(toolLabel(name, 'en')).toBe('Working on code');
    }
  });

  it('영어 로케일도 각 종류를 사람이 읽는 문구로 변환한다', () => {
    expect(toolLabel('wiki_search', 'en')).toBe('Searching the wiki');
    expect(toolLabel('web_search', 'en')).toBe('Searching the web');
    expect(toolLabel('fetch_url', 'en')).toBe('Reading a page');
    expect(toolLabel('ask_brain', 'en')).toBe('Delegating to another model');
    expect(toolLabel('ask_user', 'en')).toBe('Posting a question');
  });

  it('미지의 도구 이름은 크래시 없이 이름 그대로 폴백한다(ko·en 무관)', () => {
    expect(toolLabel('some_custom_tool', 'ko')).toBe('some_custom_tool');
    expect(toolLabel('some_custom_tool', 'en')).toBe('some_custom_tool');
  });

  it('lang 인자를 생략하면 configuredLang()(ENGRAM_LANG)을 따른다', () => {
    const prev = process.env.ENGRAM_LANG;
    try {
      process.env.ENGRAM_LANG = 'ko';
      expect(toolLabel('web_search')).toBe('웹 검색 중');
      process.env.ENGRAM_LANG = 'en';
      expect(toolLabel('web_search')).toBe('Searching the web');
    } finally {
      if (prev === undefined) delete process.env.ENGRAM_LANG;
      else process.env.ENGRAM_LANG = prev;
    }
  });
});
