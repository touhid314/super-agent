import fs from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { fileTarget } from './links';

export interface MarkdownImage { uri: string; file: string }
export type MarkdownImages = Record<string, MarkdownImage>;

const parser = new MarkdownIt();
parser.validateLink = value => !/^\s*(?:javascript|vbscript|data):/i.test(value);
const image = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/** Resolve only explicit Markdown images inside the webview's allowed roots. */
export function markdownImages(texts: string[], cwd: string, roots: string[], uriFor: (file: string) => string): MarkdownImages {
  const allowed = roots.flatMap(root => { try { return [fs.realpathSync(root)]; } catch { return []; } });
  const result: MarkdownImages = {};
  for (const text of texts) {
    if (!text.includes('![')) continue;
    for (const block of parser.parse(text, {})) {
      for (const token of block.children ?? []) {
        if (token.type !== 'image') continue;
        const src = token.attrGet('src') ?? '';
        // Reject remote schemes and network shares, including encoded forms.
        let decoded = src;
        try { decoded = decodeURIComponent(src); } catch { /* literal % */ }
        if (/^(?:[a-z][a-z\d+.-]*:)/i.test(decoded) && !/^(?:file:|[a-z]:[\\/])/i.test(decoded)) continue;
        if (/^file:\/\/[^/]/i.test(decoded) || /^(?:\/\/|\\\\)/.test(decoded)) continue;
        const target = fileTarget(src, cwd);
        if (!target || !image.test(target.file)) continue;
        try {
          const file = fs.realpathSync(target.file);
          if (!fs.statSync(file).isFile()) continue;
          if (!allowed.some(root => {
            const relative = path.relative(root, file);
            return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
          })) continue;
          result[src] = { file, uri: uriFor(file) };
        } catch { /* Missing, unfinished or unreadable image. */ }
      }
    }
  }
  return result;
}
