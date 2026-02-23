import { useState, useCallback } from 'react';
import { fetchYouTubeChannelData } from '../services/mongoApi';
import './YouTubeChannelDownload.css';

const DEFAULT_URL = 'https://www.youtube.com/@veritasium';
const DEFAULT_MAX = 10;
const MAX_VIDEOS_LIMIT = 100;

export default function YouTubeChannelDownload() {
  const [channelUrl, setChannelUrl] = useState(DEFAULT_URL);
  const [maxVideos, setMaxVideos] = useState(DEFAULT_MAX);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const handleDownload = useCallback(async () => {
    setError('');
    setResult(null);
    setLoading(true);
    setProgress(10);

    const max = Math.min(MAX_VIDEOS_LIMIT, Math.max(1, parseInt(maxVideos, 10) || 10));
    const timer = setInterval(() => {
      setProgress((p) => Math.min(p + 8, 90));
    }, 300);

    try {
      const data = await fetchYouTubeChannelData(channelUrl.trim(), max);
      clearInterval(timer);
      setProgress(100);
      setResult(data);
    } catch (err) {
      clearInterval(timer);
      setProgress(0);
      try {
        const j = JSON.parse(err.message);
        setError(j.error || err.message);
      } catch {
        setError(err.message || 'Download failed');
      }
    } finally {
      setLoading(false);
    }
  }, [channelUrl, maxVideos]);

  const handleDownloadJson = useCallback(() => {
    if (!result?.videos) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `youtube-channel-${result.channelTitle?.replace(/\W+/g, '-') || 'data'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  return (
    <div className="youtube-download">
      <h2 className="youtube-download-title">YouTube Channel Download</h2>
      <p className="youtube-download-desc">
        Enter a YouTube channel URL to download video metadata (title, description, duration, views, likes, comments, video URL).
      </p>

      <div className="youtube-download-form">
        <label>
          Channel URL
          <input
            type="url"
            value={channelUrl}
            onChange={(e) => setChannelUrl(e.target.value)}
            placeholder="https://www.youtube.com/@channel"
            disabled={loading}
          />
        </label>
        <label>
          Max videos (1–100)
          <input
            type="number"
            min={1}
            max={MAX_VIDEOS_LIMIT}
            value={Math.min(MAX_VIDEOS_LIMIT, Math.max(1, Number(maxVideos) || DEFAULT_MAX))}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              const clamped = Number.isNaN(v) ? DEFAULT_MAX : Math.min(MAX_VIDEOS_LIMIT, Math.max(1, v));
              setMaxVideos(clamped);
            }}
            disabled={loading}
          />
        </label>
        <button
          type="button"
          className="youtube-download-btn"
          onClick={handleDownload}
          disabled={loading}
        >
          {loading ? 'Downloading…' : 'Download Channel Data'}
        </button>
      </div>

      {/* Progress bar: shown while downloading; progress state 0–100 updated during fetch */}
      {loading && (
        <div className="youtube-progress-wrap" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="youtube-progress-bar">
            <div className="youtube-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="youtube-progress-text">{progress}%</span>
        </div>
      )}

      {error && <p className="youtube-error">{error}</p>}

      {result && !loading && (
        <div className="youtube-result">
          <p className="youtube-result-meta">
            <strong>{result.channelTitle || 'Channel'}</strong> — {result.videos?.length ?? 0} videos
          </p>
          <button type="button" className="youtube-download-json-btn" onClick={handleDownloadJson}>
            Download JSON file
          </button>
        </div>
      )}
    </div>
  );
}
