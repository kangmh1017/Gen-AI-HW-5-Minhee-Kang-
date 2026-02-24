/**
 * YouTube / channel JSON chat tools (Homework 5).
 * Required tool names: generateImage, plot_metric_vs_time, play_video, compute_stats_json
 */

// ── Tool declarations for Gemini function calling ───────────────────────────

export const YOUTUBE_TOOL_DECLARATIONS = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt and an optional anchor/reference image. ' +
      'Use when the user asks to create, generate, or draw an image (e.g. poster, thumbnail). ' +
      'If the user attached an image and asks for "this style" / "이 이미지 스타일로" / "앵커 이미지 스타일로" / "Veritasium 느낌의 썸네일", set use_anchor_image to true and put the full request in text_prompt.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text_prompt: {
          type: 'STRING',
          description: 'The text description of the image to generate (e.g. "Veritasium-style thumbnail, title: Why Does This Work?").',
        },
        use_anchor_image: {
          type: 'BOOLEAN',
          description: 'True if the user attached an image and asked to generate in that style; false if text-only.',
        },
      },
      required: ['text_prompt'],
    },
  },
  {
    name: 'plot_metric_vs_time',
    description:
      'Plot a numeric field (view_count, like_count, comment_count, or duration) vs time (published_at) for the loaded channel videos. ' +
      'Use when the user asks for a chart, graph, or trend over time (e.g. "views vs time 그려줘", "like_count를 시간에 따라 플롯해줘", "comment_count를 시간에 따라 플롯해줘"). ' +
      'Returns chart data to render as a React component with enlarge and download (CSV/SVG).',
    parameters: {
      type: 'OBJECT',
      properties: {
        metric_field: {
          type: 'STRING',
          description: 'Field name: view_count, like_count, comment_count, or duration.',
        },
      },
      required: ['metric_field'],
    },
  },
  {
    name: 'play_video',
    description:
      'Open or play a YouTube video from the loaded channel data. ' +
      'The user can specify which video by: title (e.g. "play the asbestos video"), ordinal (e.g. "first video", "첫 번째 영상 재생해줘" → selector "first"), or most viewed (e.g. "most viewed 영상 열어줘", "play the most viewed video" → selector "most_viewed"). ' +
      'Returns video_url, title, thumbnail_url for a clickable card that opens in a new tab.',
    parameters: {
      type: 'OBJECT',
      properties: {
        selector: {
          type: 'STRING',
          description:
            'How to pick the video: "first", "second", "third", ... (ordinal), "most_viewed", or a substring of the video title (e.g. "asbestos"). Use "first" for 첫 번째, "most_viewed" for most-viewed requests.',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'compute_stats_json',
    description:
      'Compute mean, median, std (standard deviation), min, and max for a numeric field in the channel JSON. ' +
      'Use when the user asks for 평균 (average), 통계 (statistics), 분포 (distribution), standard deviation, or summary of a numeric column. ' +
      'Examples: "view_count 통계 보여줘", "view_count에 대해 mean median std min max 계산해줘", "duration 통계 보여줘". ' +
      'Valid fields: view_count, like_count, comment_count, duration.',
    parameters: {
      type: 'OBJECT',
      properties: {
        field: {
          type: 'STRING',
          description: 'Numeric field: view_count, like_count, comment_count, or duration.',
        },
      },
      required: ['field'],
    },
  },
];

// ── Helpers for channel JSON ────────────────────────────────────────────────

const parseDuration = (dur) => {
  if (typeof dur !== 'string' || !dur) return null;
  const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const h = parseInt(match[1], 10) || 0;
  const m = parseInt(match[2], 10) || 0;
  const s = parseInt(match[3], 10) || 0;
  return h * 3600 + m * 60 + s;
};

// Coerce string numbers from JSON (view_count, like_count, comment_count often come as strings)
const toNumeric = (val) => {
  if (val == null) return null;
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val === 'string') {
    const n = Number(val);
    return n !== '' && !isNaN(n) ? n : null;
  }
  return null;
};

const getVideoId = (v) => {
  if (v?.video_id) return v.video_id;
  const url = v?.video_url || '';
  const m = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?&]+)/);
  return m ? m[1] : null;
};

const resolveNumericField = (videos, name) => {
  if (!videos?.length) return null;
  const first = videos[0];
  const keys = Object.keys(first);
  const lower = (n) => String(n).toLowerCase().replace(/[\s_]+/g, '');
  const target = lower(name);
  if (keys.some((k) => lower(k) === target)) return keys.find((k) => lower(k) === target);
  if (target === 'duration_seconds' || target === 'duration') {
    if (keys.some((k) => /duration/i.test(k))) return keys.find((k) => /duration/i.test(k));
  }
  return name;
};

const numericValues = (videos, field) => {
  if (!videos?.length) return [];
  const isDuration = /duration/i.test(field);
  return videos
    .map((v) => {
      let val = v[field];
      if (isDuration && typeof val === 'string') val = parseDuration(val);
      else if (!isDuration) val = toNumeric(val);
      return typeof val === 'number' && !isNaN(val) ? val : null;
    })
    .filter((v) => v !== null);
};

const median = (sorted) => {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

function makePlaceholderImage(prompt, errMsg = '') {
  const w = 400;
  const h = 300;
  const canvas = typeof document !== 'undefined' && document.createElement('canvas');
  if (canvas) {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#eee';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      const lines = (prompt || '').slice(0, 80).match(/.{1,30}/g) || [(prompt || '').slice(0, 30)];
      lines.forEach((line, i) => ctx.fillText(line, w / 2, h / 2 - 20 + i * 22));
      ctx.fillText(errMsg || '(Image generation placeholder)', w / 2, h / 2 + 40);
    }
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    return { _imageType: 'generated', mimeType: 'image/png', data: base64, prompt: prompt || 'Generated image' };
  }
  return { _imageType: 'generated', prompt: prompt || 'Generated image', error: errMsg || 'Canvas not available' };
}

// ── Executor (runs in browser; channelData = { videos } from loaded JSON) ───

export async function executeYouTubeTool(toolName, args, channelData, options = {}) {
  const videos = channelData?.videos || [];
  const anchorImageBase64 = options.anchorImageBase64 || null; // for generateImage

  switch (toolName) {
    case 'compute_stats_json': {
      const fieldArg = (args.field || '').trim();
      if (!fieldArg) return { error: 'Please specify a field. Use view_count, like_count, comment_count, or duration.' };
      let vals;
      if (/duration/i.test(fieldArg)) {
        vals = videos.map((v) => (typeof v.duration === 'number' ? v.duration : parseDuration(v.duration))).filter((n) => n != null);
      } else {
        const field = resolveNumericField(videos, fieldArg);
        if (!field) {
          return {
            error: `"${fieldArg}" is not a numeric field. For statistics use: view_count, like_count, comment_count, or duration.`,
          };
        }
        vals = numericValues(videos, field);
      }
      if (!vals.length) {
        return {
          error: `No numeric values found for "${fieldArg}". Make sure the channel data includes this field and has valid numbers.`,
        };
      }
      const sorted = [...vals].sort((a, b) => a - b);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      return {
        field: /duration/i.test(fieldArg) ? 'duration_seconds' : fieldArg,
        count: vals.length,
        mean: +(mean.toFixed(4)),
        median: +(median(sorted).toFixed(4)),
        std: +(Math.sqrt(variance).toFixed(4)),
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
    }

    case 'plot_metric_vs_time': {
      const metricArg = args.metric_field || 'view_count';
      const isDuration = /duration/i.test(metricArg);
      const field = resolveNumericField(videos, metricArg) || (isDuration ? 'duration' : 'view_count');
      const labels = videos.map((v, i) => v.title?.slice(0, 30) || `Video ${i + 1}`);
      const raw = videos.map((v, i) => {
        const date = v.published_at || v.publishedAt || '';
        let value = isDuration ? parseDuration(v.duration) : toNumeric(v[field]);
        if (value == null && isDuration) value = parseDuration(v.duration);
        if (value == null && !isDuration) value = toNumeric(v.view_count) ?? 0;
        return { date, value: value ?? 0, label: labels[i] };
      }).filter((d) => d.date || d.value !== undefined);
      raw.sort((a, b) => (a.date || '').localeCompare(b.date || '', undefined, { numeric: true }));
      return {
        _chartType: 'metric_vs_time',
        metricField: isDuration ? 'duration_seconds' : metricArg,
        data: raw,
        labels: raw.map((d) => d.label),
        values: raw.map((d) => d.value),
        dates: raw.map((d) => d.date),
      };
    }

    case 'play_video': {
      const sel = (args.selector || '').toLowerCase().trim();
      let index = 0;
      if (sel === 'most_viewed' || sel === 'most viewed') {
        const sorted = [...videos].sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0));
        const v = sorted[0];
        if (!v) return { error: 'No videos in channel data.' };
        const vid = getVideoId(v);
        const videoUrl = v.video_url || (vid ? `https://www.youtube.com/watch?v=${vid}` : '');
        const thumbUrl = v.thumbnail_url || (vid ? `https://img.youtube.com/vi/${vid}/mqdefault.jpg` : '');
        return { _cardType: 'play_video', video_url: videoUrl, title: v.title, thumbnail_url: thumbUrl };
      }
      const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
      const ordIndex = ordinals.indexOf(sel);
      if (ordIndex >= 0) index = ordIndex;
      else if (/^\d+$/.test(sel)) index = Math.max(0, parseInt(sel, 10) - 1);
      else {
        const titleMatch = videos.findIndex((v) => (v.title || '').toLowerCase().includes(sel));
        if (titleMatch >= 0) index = titleMatch;
        else return { error: `No video found for "${args.selector}". Try "first", "most_viewed", or part of a video title.` };
      }
      const video = videos[index];
      if (!video) return { error: `No video found for "${args.selector}".` };
      const vid = getVideoId(video);
      const videoUrl = video.video_url || (vid ? `https://www.youtube.com/watch?v=${vid}` : '');
      const thumbUrl = video.thumbnail_url || (vid ? `https://img.youtube.com/vi/${vid}/mqdefault.jpg` : '');
      return { _cardType: 'play_video', video_url: videoUrl, title: video.title, thumbnail_url: thumbUrl };
    }

    case 'generateImage': {
      const prompt = args.text_prompt || 'Generated image';
      try {
        const res = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            anchorImageBase64: anchorImageBase64 || undefined,
            anchorMimeType: options.anchorMimeType || 'image/png',
          }),
        });
        const data = await res.json();
        if (data.data && data.mimeType) {
          return { _imageType: 'generated', mimeType: data.mimeType, data: data.data, prompt: data.prompt || prompt };
        }
        if (data.error) {
          // API returned no image (e.g. model not available) — fallback to placeholder
          return makePlaceholderImage(prompt);
        }
        return makePlaceholderImage(prompt);
      } catch (err) {
        return makePlaceholderImage(prompt, err?.message || 'Request failed');
      }
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
