import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileTarget } from '../src/links';

const win = process.platform === 'win32';

describe('fileTarget', () => {
  it('ignores web links', () => {
    expect(fileTarget('https://example.com/a.py#L3')).toBeUndefined();
  });

  it.runIf(win)('reads Antigravity file URLs, keeping a # folder and the line range', () => {
    expect(fileTarget('file:///d:/Nothing/#Projects/COURSERA%20DOWNLOADER%20GUI/App/maingui.py#L65-L77')).toEqual({
      file: String.raw`d:\Nothing\#Projects\COURSERA DOWNLOADER GUI\App\maingui.py`,
      line: 65,
      endLine: 77,
    });
  });

  it.runIf(win)('reads Codex-style paths with :line', () => {
    expect(fileTarget('/c:/Users/me/a.py:12:4')).toEqual({ file: String.raw`c:\Users\me\a.py`, line: 12, endLine: undefined });
    expect(fileTarget(String.raw`D:\x\b.ts:7`)).toEqual({ file: String.raw`D:\x\b.ts`, line: 7, endLine: undefined });
  });

  it('resolves relative paths against the workspace', () => {
    const base = path.resolve('/ws');
    expect(fileTarget('src/x.ts#L12', base)).toEqual({ file: path.join(base, 'src', 'x.ts'), line: 12, endLine: undefined });
    expect(fileTarget('src/x.ts')).toBeUndefined();
  });
});
