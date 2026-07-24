import { useEffect, useRef } from 'react';
import type { FileContext } from '../types/qa';
import styles from './Lightbox.module.css';

interface LightboxProps {
  file: FileContext;
  onClose: () => void;
}

export function Lightbox({ file, onClose }: LightboxProps) {
  // Use a ref so the Escape handler always calls the latest onClose
  // without needing it as a useEffect dependency.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Lock body scroll while lightbox is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const isImage = !!(file.is_image || file.content_type?.startsWith('image/'));
  const isVideo = !!(file.content_type?.startsWith('video/'));
  const isAudio = !!(file.content_type?.startsWith('audio/'));

  const renderMedia = () => {
    if (!file.media_url) return null;

    if (isImage) {
      return (
        <img
          src={file.media_url}
          alt={file.filename}
          className={styles.media}
        />
      );
    }

    if (isVideo) {
      return (
        <video
          controls
          autoPlay
          className={styles.media}
        >
          <source src={file.media_url} type={file.content_type} />
        </video>
      );
    }

    if (isAudio) {
      return (
        <audio
          controls
          autoPlay
          className={styles.audioPlayer}
        >
          <source src={file.media_url} type={file.content_type} />
        </audio>
      );
    }

    return null;
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.content}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="关闭"
        >
          ✕
        </button>

        <div className={styles.mediaWrapper}>
          {renderMedia()}
        </div>

        <div className={styles.caption}>{file.filename}</div>
      </div>
    </div>
  );
}
