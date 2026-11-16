import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

export type UploadMethod = 'sendDocument' | 'sendPhoto' | 'sendVideo';
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const markdown = new MarkdownIt();
const validateLink = markdown.validateLink;
// Markdown normally rejects file: and Windows drive schemes; here links are only parsed, never rendered.
markdown.validateLink = value => /^(?:file:|[a-z]:[\\/])/i.test(value) || validateLink(value);

/** Only files the agent explicitly references, never a scan of the workspace. */
export function mediaIn(text: string, cwd: string): string[] {
  const found = new Set<string>();
  const add = (value: string) => {
    try {
      let raw = value.trim();
      if (/^file:/i.test(raw)) raw = fileURLToPath(raw);
      else {
        // Reject remote URLs; only upload locally authored/referenced media.
        if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return;
        try { raw = decodeURIComponent(raw); } catch { /* a literal percent sign in a local filename */ }
        if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return;
      }
      if (raw.startsWith('//') || raw.startsWith('\\\\')) return;
      if (!IMAGE.test(raw) && !VIDEO.test(raw)) return;
      const file = path.resolve(cwd, raw);
      if (fs.statSync(file).isFile()) found.add(fs.realpathSync(file));
    } catch {
      // Missing, malformed, or unreadable references are not attachments.
    }
  };
  for (const block of markdown.parse(text, {})) {
    if (block.type !== 'inline') continue;
    let inLink = false;
    for (const token of block.children ?? []) {
      if (token.type === 'image') add(token.attrGet('src') ?? '');
      if (token.type === 'link_open') { add(token.attrGet('href') ?? ''); inLink = true; }
      if (token.type === 'link_close') inLink = false;
      if (token.type === 'code_inline') add(token.content);
      if (token.type === 'text' && !inLink) {
        // Bare paths without spaces remain supported. Use a link or inline code for spaces.
        const localText = token.content.replace(/\b[a-z][a-z\d+.-]*:\/\/\S+/gi, '');
        for (const match of localText.matchAll(/(?:[a-z]:[\\/]|\.{0,2}\/)?[\w./\\~-]+\.(?:png|jpe?g|gif|webp|bmp|mp4|m4v|mov|webm|mkv|avi)\b/gi)) add(match[0]);
      }
    }
  }
  return [...found];
}

/** Telegram plays MPEG4 inline; unsupported image/video formats go as original files. */
export function mediaMethod(file: string, size: number): UploadMethod {
  if (/\.(png|jpe?g)$/i.test(file) && size <= MAX_PHOTO_BYTES) return 'sendPhoto';
  if (/\.(mp4|m4v)$/i.test(file)) return 'sendVideo';
  return 'sendDocument';
}

export function mediaType(file: string): string {
  const types: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
    '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  };
  return types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
