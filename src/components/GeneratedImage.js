import { useState } from 'react';
import './GeneratedImage.css';

export default function GeneratedImage({ data, mimeType, prompt }) {
  const [enlarged, setEnlarged] = useState(false);
  const src = data ? `data:${mimeType || 'image/png'};base64,${data}` : null;

  const handleDownload = (e) => {
    e.stopPropagation();
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    const slug = (prompt || 'image').slice(0, 40).replace(/\s+/g, '-').replace(/[^\w\u3131-\u318E\uAC00-\uD7A3\-]/g, '') || `image-${Date.now()}`;
    a.download = `generated-${slug}.png`;
    a.click();
  };

  if (!src) return null;

  const imgEl = (
    <div className="generated-image-wrap">
      <img src={src} alt={prompt || 'Generated'} className="generated-image-img" />
      <div className="generated-image-actions">
        <button type="button" className="generated-image-download-btn" onClick={handleDownload}>
          Download
        </button>
        <button type="button" className="generated-image-enlarge-btn" onClick={() => setEnlarged(true)}>
          Enlarge
        </button>
      </div>
    </div>
  );

  if (enlarged) {
    return (
      <div className="generated-image-lightbox" onClick={() => setEnlarged(false)} role="button" tabIndex={0}>
        <div className="generated-image-lightbox-inner" onClick={(e) => e.stopPropagation()}>
          <img src={src} alt={prompt || 'Generated'} />
          <button type="button" className="generated-image-close-btn" onClick={() => setEnlarged(false)}>
            Close
          </button>
          <button type="button" className="generated-image-download-btn-lb" onClick={handleDownload}>
            Download
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="generated-image-click-wrap" onClick={() => setEnlarged(true)} role="button" tabIndex={0}>
      {imgEl}
    </div>
  );
}
