import { useState, useMemo } from 'react';
import { Lightbox } from './Lightbox';
import type { FileContext } from '../types/qa';
import styles from './AttachmentGallery.module.css';

export interface MediaItem {
  type: 'image' | 'video' | 'audio' | 'document';
  src: string;
  name: string;
  poster?: string;  // video thumbnail
}

/** Map file extension to an emoji icon. */
function getFileIcon(filename: string): string {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'pdf': return '📕';
    case 'doc': case 'docx': return '📝';
    case 'xls': case 'xlsx': case 'csv': return '📊';
    case 'ppt': case 'pptx': return '📽';
    case 'txt': case 'md': case 'log': return '📄';
    case 'json': case 'xml': case 'yaml': case 'yml': case 'toml': return '📋';
    case 'py': case 'js': case 'ts': case 'jsx': case 'tsx': return '💻';
    case 'html': case 'htm': case 'css': case 'scss': return '🌐';
    case 'zip': case 'rar': case '7z': case 'tar': case 'gz': return '📦';
    default: return '📎';
  }
}

/** Extract media tags from article content + document attachment info. */
export function useAttachments(
  content: string,
  attachmentName?: string | null,
): { mediaItems: MediaItem[]; cleanContent: string } {
  return useMemo(() => {
    const items: MediaItem[] = [];
    const seen = new Set<string>();
    const toRemove: { start: number; end: number }[] = [];

    // Find all media tags — both self-closing (<img ...>) and paired (<video>...</video>)
    const tagRe = /<(img|video|audio)\b[^>]*\/?>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(content)) !== null) {
      const tag = m[0];
      const tagName = m[1].toLowerCase();
      const src = (tag.match(/src="([^"]*)"/i) ?? [])[1] || '';
      const alt = (tag.match(/alt="([^"]*)"/i) ?? [])[1] || '';
      const poster = (tag.match(/poster="([^"]*)"/i) ?? [])[1] || undefined;
      const name = alt || src.split('/').pop() || tagName;

      // Record position for removal
      let end = m.index + tag.length;
      // For video/audio, also find closing tag
      if (tagName === 'video' || tagName === 'audio') {
        const closeRe = new RegExp('</' + tagName + '>', 'i');
        const closeMatch = closeRe.exec(content.slice(end));
        if (closeMatch) {
          end += closeMatch.index + closeMatch[0].length;
        }
      }
      // Include trailing whitespace
      while (end < content.length && /\s/.test(content[end])) end++;
      toRemove.push({ start: m.index, end });

      if (!src || seen.has(src)) continue;
      seen.add(src);
      // Also deduplicate by poster URL (video thumbnail)
      if (poster && seen.has(poster)) continue;
      if (poster) seen.add(poster);
      const type = tagName === 'img' ? 'image' : tagName === 'video' ? 'video' : 'audio';
      items.push({ type, src, name, poster });
    }

    // Build clean content by cutting out matched ranges (in reverse order)
    let result = content;
    for (const r of toRemove.reverse()) {
      result = result.slice(0, r.start) + result.slice(r.end);
    }
    // Parse upload order from content marker
    const orderMatch = result.match(/<!-- attachments-order: (.+?) -->/);
    const orderList = orderMatch ? orderMatch[1].split(', ').map(s => s.trim()) : [];
    // Remove the order comment from clean content
    let cleanContent = result.replace(/\n*<!-- attachments-order: .+? -->\n*/g, '\n').trim();

    // Sort items by upload order
    if (orderList.length > 0) {
      items.sort((a, b) => {
        const ai = orderList.findIndex(o => o === a.name || a.src.includes(o) || (a.src.split('/').pop()?.startsWith(o.split('.')[0])));
        const bi = orderList.findIndex(o => o === b.name || b.src.includes(o) || (b.src.split('/').pop()?.startsWith(o.split('.')[0])));
        return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999);
      });
    }

    // Add document attachment from article data (only if not already shown as media)
    if (attachmentName) {
      const alreadyShown = items.some((it) => {
        // Match by original name OR by safe name embedded in src
        if (it.name === attachmentName) return true;
        const srcFile = it.src.split('/').pop()?.split('?')[0] ?? '';
        // Safe name format: {uuid}_{original}.ext — strip UUID prefix for comparison
        const safeNameMatch = srcFile.match(/^[a-f0-9]+_(.+)$/i);
        return safeNameMatch && safeNameMatch[1] === attachmentName;
      });
      if (!alreadyShown) {
        // Document attachment was uploaded first — insert at beginning
        items.splice(0, 0, { type: 'document', src: '', name: attachmentName });
      }
    }

    return { mediaItems: items, cleanContent };
  }, [content, attachmentName]);
}

/** Infer content_type from MediaItem for Lightbox compatibility. */
function toLightboxFile(item: MediaItem): FileContext {
  const ext = (item.name.split('.').pop() ?? '').toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp',
    mp4: 'video/mp4', avi: 'video/avi', mov: 'video/quicktime',
    mkv: 'video/x-matroska', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
    flac: 'audio/flac', ogg: 'audio/ogg',
  };
  const content_type = mimeMap[ext] || '';
  return {
    filename: item.name,
    media_url: item.src,
    content_type,
    content: '',
  };
}

export function AttachmentGallery({ items, articleId }: { items: MediaItem[]; articleId?: string }) {
  const [lightboxItem, setLightboxItem] = useState<MediaItem | null>(null);

  if (items.length === 0) return null;

  return (
    <>
      <div className={styles.gallery}>
        {items.map((item, i) => {
          const isImage = item.type === 'image';
          const isVideo = item.type === 'video';
          const isAudio = item.type === 'audio';
          const hasSrc = !!item.src;
          return (
            <div
              key={i}
              className={styles.mediaItem}
              onClick={() => { if (hasSrc) setLightboxItem(item); }}
              title={hasSrc ? `点击查看 ${item.name}` : item.name}
              role={hasSrc ? 'button' : undefined}
              tabIndex={hasSrc ? 0 : undefined}
              onKeyDown={(e) => { if (e.key === 'Enter' && hasSrc) setLightboxItem(item); }}
            >
              <div className={styles.thumb}>
                {isImage && hasSrc ? (
                  <img src={item.src} alt={item.name} className={styles.thumbImg} />
                ) : isVideo && item.poster ? (
                  <img src={item.poster} alt={item.name} className={styles.thumbImg} />
                ) : (
                  <span className={styles.thumbIcon}>
                    {isVideo ? '🎬' : isAudio ? '🎵' : getFileIcon(item.name)}
                  </span>
                )}
                {isVideo && <span className={styles.playOverlay}>▶</span>}
                <a
                  href={hasSrc ? `${item.src}?download=1` : `/api/articles/${articleId}/download`}
                  download={item.name}
                  className={styles.dlBtn}
                  onClick={(e) => e.stopPropagation()}
                  title={`下载 ${item.name}`}
                >
                  ⬇
                </a>
              </div>
              <span className={styles.label}>{item.name}</span>
            </div>
          );
        })}
      </div>

      {lightboxItem && (
        <Lightbox
          file={toLightboxFile(lightboxItem)}
          onClose={() => setLightboxItem(null)}
        />
      )}
    </>
  );
}
