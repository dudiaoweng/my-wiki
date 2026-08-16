import { useState, useMemo, useRef, useEffect } from 'react';
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
    // Parse document attachment markers: <!-- doc-attachment: filename | safe_name -->
    const docMarkerRe = /<!-- doc-attachment: (.+?) \| (.+?) -->/g;
    let dm: RegExpExecArray | null;
    const docAttachments: { name: string; safeName: string }[] = [];
    while ((dm = docMarkerRe.exec(result)) !== null) {
      docAttachments.push({ name: dm[1].trim(), safeName: dm[2].trim() });
    }

    // Helper: check if an item with the same unique src is already in the list.
    // Dedup by src (unique per file) rather than name (may collide for same-named files).
    const isAlreadyShown = (src: string, name: string): boolean => {
      if (src) {
        return items.some((it) => it.src === src);
      }
      // Legacy fallback (no src): check by name against media item src filenames
      return items.some((it) => {
        if (it.name === name) return true;
        const srcFile = it.src.split('/').pop()?.split('?')[0] ?? '';
        const safeNameMatch = srcFile.match(/^[a-f0-9-]+_(.+)$/i);
        return safeNameMatch && safeNameMatch[1] === name;
      });
    };

    // Add document attachments from persistent markers (before sorting, so order applies)
    for (const da of docAttachments) {
      const docSrc = `/api/media/${da.safeName}`;
      if (!isAlreadyShown(docSrc, da.name)) {
        items.push({ type: 'document', src: docSrc, name: da.name });
      }
    }

    // Add document attachment from article metadata (fallback for legacy articles without markers)
    if (attachmentName && !isAlreadyShown('', attachmentName)) {
      items.push({ type: 'document', src: '', name: attachmentName });
    }

    // Parse upload order from content marker
    const orderMatch = result.match(/<!-- attachments-order: (.+?) -->/);
    const orderList = orderMatch ? orderMatch[1].split(', ').map(s => s.trim()) : [];
    // Remove marker comments from clean content
    let cleanContent = result
      .replace(/\n*<!-- doc-attachment: .+? -->\n*/g, '\n')
      .replace(/\n*<!-- attachments-order: .+? -->\n*/g, '\n')
      .trim();

    // Sort ALL items (media + documents + legacy) by upload order.
    // Walk the order list and assign each matching item its ORIGINAL position.
    if (orderList.length > 0) {
      const assigned = new Map<MediaItem, number>();
      for (let orderIdx = 0; orderIdx < orderList.length; orderIdx++) {
        const o = orderList[orderIdx];
        const match = items.find(
          (it) =>
            !assigned.has(it) &&
            (o === it.name ||
              it.src.includes(o) ||
              (it.src.split('/').pop()?.startsWith(o.split('.')[0]) ?? false)),
        );
        if (match) {
          assigned.set(match, orderIdx);
        }
      }
      const idxMap = new Map(items.map((it, i) => [it, i]));
      items.sort((a, b) => {
        const aiNorm = assigned.has(a) ? assigned.get(a)! : 999 + (idxMap.get(a) ?? 0);
        const biNorm = assigned.has(b) ? assigned.get(b)! : 999 + (idxMap.get(b) ?? 0);
        return aiNorm - biNorm;
      });
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

export function AttachmentGallery({
  items,
  articleId,
  onReprocess,
  processing = null,
}: {
  items: MediaItem[];
  articleId?: string;
  onReprocess?: (item: MediaItem) => void | Promise<void>;
  /** Article processing state: null | "processing" | "processing:{safe_name}" */
  processing?: string | null;
}) {
  const [lightboxItem, setLightboxItem] = useState<MediaItem | null>(null);
  const [parsingKeys, setParsingKeys] = useState<Set<string>>(new Set());
  const prevProcessingRef = useRef(processing);

  // When article processing finishes, clear local parsing state
  useEffect(() => {
    if (prevProcessingRef.current && !processing) {
      setParsingKeys(new Set());
    }
    prevProcessingRef.current = processing;
  }, [processing]);

  if (items.length === 0) return null;

  const handleReprocess = async (item: MediaItem) => {
    const key = item.src.split('/').pop()?.split('?')[0] || item.name;
    setParsingKeys((prev) => new Set(prev).add(key));
    try {
      await onReprocess?.(item);
    } catch {
      setParsingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <>
      <div className={styles.gallery}>
        {items.map((item, i) => {
          const isImage = item.type === 'image';
          const isVideo = item.type === 'video';
          const isAudio = item.type === 'audio';
          const hasSrc = !!item.src;
          const itemKey = item.src.split('/').pop()?.split('?')[0] || item.name;
          // Local tracking OR article-level specific file marker (e.g. "processing:file.jpg")
          const serverParsing = typeof processing === 'string' && processing.startsWith('processing:')
            ? processing.slice('processing:'.length) === itemKey
            : false;
          const isParsing = parsingKeys.has(itemKey) || serverParsing;
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
                {isParsing && (
                  <span className={styles.parsingOverlay}>解析中…</span>
                )}
                {onReprocess && !isParsing && (
                  <button
                    className={styles.reprocessBtn}
                    onClick={(e) => { e.stopPropagation(); handleReprocess(item); }}
                    title={`重新解析 ${item.name}`}
                  >
                    🔄
                  </button>
                )}
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
