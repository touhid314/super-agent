import path from 'node:path';

export interface FileTarget {
  file: string;
  /** 1-based lines, when the link names them. */
  line?: number;
  endLine?: number;
}

/**
 * Where a file link in an agent's answer points. Agents write them in several ways:
 * `file:///d:/a/%23b/x.py#L65-L77` (Antigravity), `D:\a\x.py:65` / `/c:/a/x.py:65:3` (Codex), `src/x.ts#L12` (relative
 * to the workspace, `base`). Only a trailing line marker is cut, so a folder named `#Projects` survives.
 */
export function fileTarget(href: string, base?: string): FileTarget | undefined {
  let s = href.trim();
  if (!s || /^[a-z][a-z0-9+.-]+:\/\//i.test(s) && !/^file:/i.test(s)) return undefined; // web and other schemes
  let line: number | undefined;
  let endLine: number | undefined;
  const hash = /#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/.exec(s);
  const colon = /:(\d+)(?::\d+)?(?:-(\d+))?$/.exec(s);
  const m = hash ?? colon;
  if (m) {
    line = Number(m[1]);
    endLine = m[2] ? Number(m[2]) : undefined;
    s = s.slice(0, m.index);
  }
  if (/^file:/i.test(s)) s = s.replace(/^file:\/*/i, process.platform === 'win32' ? '' : '/');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* a literal % in the name */
  }
  if (/^\/[a-z]:[\\/]/i.test(s)) s = s.slice(1); // /c:/Users/… on Windows
  if (!path.isAbsolute(s)) {
    if (!base) return undefined;
    s = path.resolve(base, s);
  }
  return { file: path.normalize(s), line, endLine };
}
