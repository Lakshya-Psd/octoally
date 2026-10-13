import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, ZoomIn, ZoomOut, Maximize2, FileWarning } from 'lucide-react';
import { api } from '../lib/api';
import { usePlatform } from '../lib/platform';
import { previewUrl, parseDelimited, type PreviewKind } from '../lib/preview';

interface FilePreviewProps {
  path: string;
  kind: PreviewKind;
  extension: string;
  /** Text content (csv) — media kinds are streamed from the preview server instead. */
  content?: string;
  /** Changes when the file changed on disk, forcing a reload. */
  version: number;
}

/** Shown when the browser can't display a file (unknown type, unsupported codec ...). */
export function PreviewUnavailable({ path, message }: { path: string; message: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-xs p-6 text-center" style={{ color: 'var(--text-secondary)' }}>
      <FileWarning className="w-8 h-8 opacity-60" />
      <span>{message}</span>
      <button
        onClick={() => api.files.openExternal(path).catch(() => {})}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
      >
        <ExternalLink className="w-3.5 h-3.5" /> Open in default app
      </button>
    </div>
  );
}

function ImagePreview({ src, path }: { src: string; path: string }) {
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);

  if (failed) return <PreviewUnavailable path={path} message="This image format can't be shown here." />;

  const btn = 'p-1 rounded hover:bg-white/10';
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-3 py-1 text-xs shrink-0" style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
        <button className={btn} title="Fit to panel" onClick={() => { setFit(true); setZoom(1); }}><Maximize2 className="w-3.5 h-3.5" /></button>
        <button className={btn} title="Zoom out" onClick={() => { setFit(false); setZoom(z => Math.max(0.1, z / 1.25)); }}><ZoomOut className="w-3.5 h-3.5" /></button>
        <button className={btn} title="Zoom in" onClick={() => { setFit(false); setZoom(z => Math.min(16, z * 1.25)); }}><ZoomIn className="w-3.5 h-3.5" /></button>
        <span className="ml-1">{fit ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
        {size && <span className="ml-auto">{size.w} × {size.h}px</span>}
      </div>
      <div
        className="flex-1 overflow-auto flex"
        style={{
          // Checkerboard so transparent images are visible
          backgroundImage: 'linear-gradient(45deg,#2a2a2a 25%,transparent 25%),linear-gradient(-45deg,#2a2a2a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2a2a 75%),linear-gradient(-45deg,transparent 75%,#2a2a2a 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
          backgroundColor: '#1f1f1f',
        }}
      >
        <img
          src={src}
          alt={path}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          onClick={() => { if (fit) { setFit(false); setZoom(1); } else { setFit(true); } }}
          className="m-auto"
          style={fit
            ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'zoom-in' }
            : { width: size ? size.w * zoom : undefined, maxWidth: 'none', cursor: 'zoom-out', imageRendering: zoom >= 3 ? 'pixelated' : 'auto' }}
        />
      </div>
    </div>
  );
}

function MediaPreview({ src, path, kind }: { src: string; path: string; kind: 'video' | 'audio' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) {
    return <PreviewUnavailable path={path} message={`This ${kind} can't be played here (unsupported format or codec).`} />;
  }
  if (kind === 'audio') {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <audio key={src} src={src} controls preload="metadata" onError={() => setFailed(true)} style={{ width: 'min(600px, 100%)' }} />
      </div>
    );
  }
  return (
    <div className="flex-1 flex items-center justify-center min-h-0 p-2" style={{ background: '#000' }}>
      <video key={src} src={src} controls preload="metadata" onError={() => setFailed(true)} style={{ maxWidth: '100%', maxHeight: '100%' }} />
    </div>
  );
}

function TablePreview({ content, delimiter }: { content: string; delimiter: string }) {
  const { rows, truncated } = useMemo(() => parseDelimited(content, delimiter), [content, delimiter]);
  if (rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--text-secondary)' }}>Empty file</div>;
  }
  const [header, ...body] = rows;
  const cell = 'px-2 py-1 whitespace-pre align-top';
  return (
    <div className="flex-1 overflow-auto text-xs" style={{ color: 'var(--text-primary)' }}>
      <table className="border-collapse" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
        <thead>
          <tr>
            <th className={cell} style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>#</th>
            {header.map((h, i) => (
              <th key={i} className={`${cell} text-left`} style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} style={{ background: ri % 2 ? 'rgba(255,255,255,0.02)' : undefined }}>
              <td className={cell} style={{ color: 'var(--text-secondary)' }}>{ri + 1}</td>
              {header.map((_, ci) => <td key={ci} className={cell} style={{ borderLeft: '1px solid var(--border)' }}>{r[ci] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <div className="p-2" style={{ color: 'var(--text-secondary)' }}>Showing the first {rows.length} rows.</div>}
    </div>
  );
}

/**
 * Visual preview of a file: images, video, audio, PDFs, live HTML pages, SVG
 * and CSV/TSV tables. Media and pages are served by the preview server on its
 * own origin, so previewed pages can't reach the dashboard or the API.
 */
export function FilePreview({ path, kind, extension, content = '', version }: FilePreviewProps) {
  const platform = usePlatform();
  const src = previewUrl(path, version, platform.previewBase);

  if (kind === 'csv') {
    return <TablePreview content={content} delimiter={extension.toLowerCase() === 'tsv' ? '\t' : ','} />;
  }
  if (!src) {
    return <PreviewUnavailable path={path} message="Preview isn't available (the preview server isn't running)." />;
  }
  switch (kind) {
    case 'image':
    case 'svg':
      return <ImagePreview src={src} path={path} />;
    case 'video':
    case 'audio':
      return <MediaPreview src={src} path={path} kind={kind} />;
    case 'pdf':
      return <iframe key={src} src={src} title={path} className="flex-1 w-full border-0" style={{ background: '#525659' }} />;
    case 'html':
      return (
        <iframe
          key={src}
          src={src}
          title={path}
          className="flex-1 w-full border-0"
          style={{ background: '#fff' }}
          allow="autoplay; fullscreen; clipboard-write"
        />
      );
    default:
      return <PreviewUnavailable path={path} message="This file can't be previewed here." />;
  }
}
