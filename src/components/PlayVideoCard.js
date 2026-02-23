import './PlayVideoCard.css';

export default function PlayVideoCard({ video_url, title, thumbnail_url }) {
  const openVideo = (e) => {
    e.preventDefault();
    if (video_url) window.open(video_url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="play-video-card" onClick={openVideo} role="button" tabIndex={0}>
      <div className="play-video-card-thumb">
        {thumbnail_url ? (
          <img src={thumbnail_url} alt="" />
        ) : (
          <div className="play-video-card-thumb-placeholder">No thumbnail</div>
        )}
      </div>
      <div className="play-video-card-body">
        <span className="play-video-card-title">{title || 'Video'}</span>
        <span className="play-video-card-hint">Click to open in new tab</span>
      </div>
    </div>
  );
}
