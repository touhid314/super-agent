import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownImages } from '../src/markdown-images';
import { renderMarkdown } from '../src/webview/components/Markdown';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sa-markdown-')) throw new Error('Unexpected test cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-markdown-'));
  temporary.push(dir);
  const allowed = path.join(dir, 'workspace');
  fs.mkdirSync(allowed);
  const file = path.join(allowed, 'preview one#.png');
  fs.writeFileSync(file, 'image bytes');
  return { dir, allowed, file };
}

describe('local Markdown images', () => {
  it('maps an encoded relative path to an allowed webview resource and preserves its absolute click target', () => {
    const { allowed, file } = workspace();
    const text = '![Preview](<./preview one%23.png>)';
    const images = markdownImages([text], allowed, [allowed], () => 'https://file.vscode-resource.vscode-cdn.net/safe.png');
    const html = renderMarkdown(text, images);
    expect(html).toContain('src="https://file.vscode-resource.vscode-cdn.net/safe.png"');
    expect(html).toContain(`data-local-file="${file}"`);
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('src="./');
  });

  it('supports both absolute file paths and file URLs', () => {
    const { allowed, file } = workspace();
    for (const src of [file.replace(/\\/g, '/'), pathToFileURL(file).href]) {
      const text = `![Absolute](<${src}>)`;
      const mapped = markdownImages([text], allowed, [allowed], () => 'webview-resource:image');
      expect(Object.values(mapped)).toEqual([{ file: fs.realpathSync(file), uri: 'webview-resource:image' }]);
    }
  });

  it('does not publish files outside allowed roots, including through a directory junction', () => {
    const { dir, allowed } = workspace();
    const outside = path.join(dir, 'outside'); fs.mkdirSync(outside);
    const secret = path.join(outside, 'private.png'); fs.writeFileSync(secret, 'private');
    const link = path.join(allowed, 'linked'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const map = markdownImages(['![Outside](../outside/private.png)', '![Linked](linked/private.png)'], allowed, [allowed], () => 'must-not-be-used');
    expect(map).toEqual({});
  });

  it('ignores network URLs, missing files, directories and images inside code blocks', () => {
    const { allowed } = workspace();
    fs.mkdirSync(path.join(allowed, 'directory.png'));
    const texts = ['![Remote](https://example.com/photo.png)', '![Missing](missing.png)', '![Folder](directory.png)', '```md\n![Not an image](preview%20one%23.png)\n```'];
    expect(markdownImages(texts, allowed, [allowed], () => 'unused')).toEqual({});
  });

  it('keeps unresolved images usable as links without broken image markup or raw HTML execution', () => {
    const html = renderMarkdown('![Preview](missing.png)\n\n<script>alert(1)</script>\n\n![Bad](javascript:alert(1))');
    expect(html).toContain('<a href="missing.png">Preview</a>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });
});
