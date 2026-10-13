/**
 * File preview helpers: which files the viewer can show visually, and the URL
 * the preview server (own origin, see server/src/services/preview-server.ts)
 * serves them from.
 */
import { getPlatformSync } from './platform';
import { toSlash } from './paths';

export type PreviewKind =
  | 'image' | 'video' | 'audio' | 'pdf'   // binary media — always previewed
  | 'html' | 'svg' | 'csv' | 'markdown'   // text with a rendered preview + code view
  | 'text';                               // code / plain text only

const KIND_BY_EXT: Record<string, PreviewKind> = {};
const add = (kind: PreviewKind, exts: string) => exts.split(' ').forEach((e) => { KIND_BY_EXT[e] = kind; });
add('image', 'png jpg jpeg jfif gif webp avif bmp ico tif tiff');
add('video', 'mp4 m4v mov webm ogv mkv avi');
add('audio', 'mp3 wav ogg oga opus m4a aac flac weba');
add('pdf', 'pdf');
add('html', 'html htm xhtml');
add('svg', 'svg');
add('csv', 'csv tsv');
add('markdown', 'md mdx markdown');

export function previewKind(extension: string): PreviewKind {
  return KIND_BY_EXT[extension.toLowerCase()] ?? 'text';
}

/** Binary media that must not be loaded into the text editor. */
export function isMediaKind(kind: PreviewKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf';
}

/** Kinds that have both a rendered preview and an editable source. */
export function hasSourceView(kind: PreviewKind): boolean {
  return kind === 'html' || kind === 'svg' || kind === 'csv' || kind === 'markdown';
}

/** Preview-server URL for an absolute file path, or null if the server isn't available. */
export function previewUrl(path: string, version?: number, base: string | null | undefined = getPlatformSync().previewBase): string | null {
  if (!base) return null;
  const encoded = toSlash(path)
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  const url = `${base}${encoded.startsWith('/') ? '' : '/'}${encoded}`;
  return version ? `${url}?v=${version}` : url;
}

/** Minimal CSV/TSV parser (RFC 4180 quoting). Caps rows so huge files stay responsive. */
export function parseDelimited(text: string, delimiter: string, maxRows = 2000): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1 };
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return { rows, truncated: false };
}
