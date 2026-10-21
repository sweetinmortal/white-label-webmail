import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment } from '../lib/api';

function cidDocument(html: string, urls: Map<string, string>): string {
  if (!urls.size) return html;
  return html.replace(/\b(src|background)=(["'])(cid:[^"']+)\2/gi, (match, attribute: string, quote: string, value: string) => {
    const id = value.slice(4).trim();
    const url = urls.get(id) ?? urls.get(id.toLowerCase());
    return url ? `${attribute}=${quote}${url}${quote}` : match;
  });
}

export default function EmailBody({ html, styles, remoteImages, attachments, color }: {
  html: string; styles: string; remoteImages: number; attachments: Attachment[]; color: string;
}) {
  const [showRemote, setShowRemote] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(420);
  const cidUrls = useMemo(() => {
    const urls = new Map<string, string>();
    for (const attachment of attachments) {
      if (!attachment.inline || !attachment.contentId || attachment.content.byteLength === 0) continue;
      const url = URL.createObjectURL(new Blob([attachment.content], { type: attachment.mimeType }));
      urls.set(attachment.contentId, url);
      urls.set(attachment.contentId.toLowerCase(), url);
    }
    return urls;
  }, [attachments]);

  useEffect(() => () => {
    for (const url of new Set(cidUrls.values())) URL.revokeObjectURL(url);
  }, [cidUrls]);

  const frameDocument = useMemo(() => {
    const images = showRemote ? "img-src data: blob: https: http:" : "img-src data: blob:";
    const csp = `default-src 'none'; ${images}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'`;
    const safeColor = /^#[a-f0-9]{6}$/i.test(color) ? color : '#0875d1';
    const base = `html,body{margin:0;padding:0;background:#fff;color:#172033;font:14px/1.55 Arial,Helvetica,sans-serif;overflow-wrap:anywhere}body{padding:2px}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}a{color:${safeColor}}blockquote{margin:0 0 0 12px;padding-left:12px;border-left:3px solid #e5e7eb}`;
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${base}\n${styles}</style></head><body>${cidDocument(html, cidUrls)}</body></html>`;
  }, [cidUrls, color, html, showRemote, styles]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      try {
        const document = frame.contentDocument;
        if (!document) return;
        setFrameHeight(Math.min(Math.max(document.documentElement.scrollHeight, 160), 20_000));
      } catch {
        setFrameHeight(420);
      }
    };
    const loaded = () => {
      observer?.disconnect();
      measure();
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    frame.addEventListener('load', loaded);
    loaded();
    return () => { frame.removeEventListener('load', loaded); observer?.disconnect(); };
  }, [frameDocument]);

  return <div className="email-preview">
    {remoteImages > 0 && <div className="remote-images" role="status"><ImageIcon size={17} /><span>{showRemote ? `${remoteImages} imagen${remoteImages === 1 ? '' : 'es'} remota${remoteImages === 1 ? '' : 's'} habilitada${remoteImages === 1 ? '' : 's'}.` : `Se bloquearon ${remoteImages} imagen${remoteImages === 1 ? '' : 'es'} remota${remoteImages === 1 ? '' : 's'} para proteger tu privacidad.`}</span><button type="button" className="button button-secondary" onClick={() => setShowRemote((value) => !value)}>{showRemote ? 'Ocultar imágenes' : 'Mostrar imágenes'}</button></div>}
    <iframe ref={frameRef} className="email-frame" title="Contenido del mensaje" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={frameDocument} style={{ height: `${frameHeight}px` }} />
  </div>;
}
