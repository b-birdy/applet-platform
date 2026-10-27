import { describe, expect, it } from 'vitest';
import { devPrompt, existingAppletPrompt, adoptPrompt } from './prompts';

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

  it('devPrompt merges self-check and upload (one-shot flow)', () => {
    const p = devPrompt(applet, MCP_URL);
    expect(p).toContain('check_applet');
    expect(p).toContain('submit_applet');
    expect(p).not.toContain('${'); // 模板占位必须已替换
  });

  it('requirement block merges into dev and existing prompts', () => {
    const a = { ...applet, version: 'v0.3', target: '手机端', purpose: '练习', features: ['出题', '判分'], avoid: ['不要弹窗'] };
    const dev = devPrompt(a, MCP_URL);
    expect(dev).toContain('v0.3');
    expect(dev).toContain('手机端');
    expect(dev).toContain('1. 出题');
    expect(dev).toContain('- 不要弹窗');
    const existing = existingAppletPrompt(a, MCP_URL);
    expect(existing).toContain('1. 出题');
  });

  it('adoptPrompt embeds access code when provided', () => {
    const p = adoptPrompt(applet, MCP_URL, 'CODE123');
    expect(p).toContain('CODE123');
    expect(p).toContain('agent_apply');
  });
});
