/**
 * One-time script to download 10 videos from Veritasium and save to public/veritasium-channel.json.
 * Run: YOUTUBE_API_KEY=your_key node scripts/download-veritasium.js
 */
const fs = require('fs');
const path = require('path');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;
const CHANNEL_URL = 'https://www.youtube.com/@veritasium';
const MAX_VIDEOS = 10;
const OUT_PATH = path.join(__dirname, '..', 'public', 'veritasium-channel.json');

function parseChannelIdOrHandle(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  const handleMatch = u.match(/youtube\.com\/@([^/?]+)/);
  if (handleMatch) return { type: 'handle', value: handleMatch[1] };
  const channelMatch = u.match(/youtube\.com\/channel\/([^/?]+)/);
  if (channelMatch) return { type: 'id', value: channelMatch[1] };
  return null;
}

async function main() {
  if (!YOUTUBE_API_KEY) {
    console.error('Set YOUTUBE_API_KEY or REACT_APP_YOUTUBE_API_KEY');
    process.exit(1);
  }
  const base = 'https://www.googleapis.com/youtube/v3';
  const parsed = parseChannelIdOrHandle(CHANNEL_URL);
  if (!parsed) throw new Error('Invalid channel URL');

  let channelId;
  if (parsed.type === 'handle') {
    const r = await fetch(
      `${base}/channels?part=id,snippet,contentDetails&forHandle=${encodeURIComponent(parsed.value)}&key=${YOUTUBE_API_KEY}`
    );
    const data = await r.json();
    if (!data.items?.length) throw new Error(`Channel @${parsed.value} not found`);
    channelId = data.items[0].id;
  } else {
    channelId = parsed.value;
  }

  const channelRes = await fetch(
    `${base}/channels?part=contentDetails,snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`
  );
  const channelData = await channelRes.json();
  const uploadsId = channelData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error('Uploads playlist not found');

  const playlistRes = await fetch(
    `${base}/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=${MAX_VIDEOS}&key=${YOUTUBE_API_KEY}`
  );
  const playlistData = await playlistRes.json();
  const videoIds = (playlistData.items || []).map((i) => i.snippet?.resourceId?.videoId).filter(Boolean);
  if (!videoIds.length) throw new Error('No videos found');

  const videosRes = await fetch(
    `${base}/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`
  );
  const videosData = await videosRes.json();
  const byId = (videosData.items || []).reduce((acc, v) => { acc[v.id] = v; return acc; }, {});

  const videos = videoIds.map((id) => {
    const v = byId[id];
    if (!v) return null;
    const sn = v.snippet || {};
    const stat = v.statistics || {};
    const content = v.contentDetails || {};
    return {
      video_id: id,
      title: sn.title || '',
      description: (sn.description || '').slice(0, 5000),
      duration: content.duration || '',
      published_at: sn.publishedAt || null,
      view_count: parseInt(stat.viewCount, 10) || 0,
      like_count: parseInt(stat.likeCount, 10) || 0,
      comment_count: parseInt(stat.commentCount, 10) || 0,
      video_url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail_url: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
      transcript: null,
    };
  }).filter(Boolean);

  const result = {
    channelId,
    channelTitle: playlistData?.items?.[0]?.snippet?.channelTitle || 'Veritasium',
    videos,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Wrote ${videos.length} videos to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
