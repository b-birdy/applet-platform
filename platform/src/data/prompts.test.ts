import { describe, expect, it } from 'vitest';
import { devPrompt, checkPrompt, uploadPrompt } from './prompts';

const applet = { id: 'word-cards', name: '背单词', icon: '📚' };
const MCP_URL = 'https://example.com/mcp';

describe('prompt templates', () => {
  it('devPrompt includes get_spec, MCP endpoint and applet id', () => {
    const p = devPrompt(applet, MCP_URL);
    expect(p).toContain('get_spec');
    expect(p).toContain(MCP_URL);
    expect(p).toContain('word-cards');
    expect(p).toContain('背单词');
  });

  it('checkPrompt includes check_applet and id substitution', () => {
    const p = checkPrompt(applet, MCP_URL);
    expect(p).toContain('check_applet');
    expect(p).toContain('word-cards');
    expect(p).not.toContain('${'); // 模板占位必须已替换
  });

  it('uploadPrompt includes submit_applet and id substitution', () => {
    const p = uploadPrompt(applet, MCP_URL);
    expect(p).toContain('submit_applet');
    expect(p).toContain('word-cards');
    expect(p).not.toContain('${');
  });
});
