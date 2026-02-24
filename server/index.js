const path = require('path');
const fs = require('fs');

// Load .env from project root — try both paths so it works from npm start or node server/index.js
const envPaths = [
  path.join(__dirname, '..', '.env'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'chatapp_websearch_code', '.env'),
];
let envLoadedFrom = null;
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    envLoadedFrom = envPath;
    break;
  }
}
if (!envLoadedFrom) console.warn('No .env found in:', envPaths.map((p) => path.relative(process.cwd(), p) || p).join(', '));

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const URI = (process.env.REACT_APP_MONGODB_URI || process.env.MONGODB_URI || process.env.REACT_APP_MONGO_URI || '').trim();
const DB = 'chatapp';

// Log whether MongoDB URI is present (masked) so we can see if .env is read correctly
if (URI) {
  const masked = URI.replace(/:([^:@]+)@/, ':****@').slice(0, 55) + (URI.length > 55 ? '...' : '');
  console.log('MongoDB URI loaded:', masked);
} else {
  console.warn('MongoDB URI missing — set REACT_APP_MONGODB_URI or MONGODB_URI in .env');
}

let db;

function requireDb(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database not configured. Add REACT_APP_MONGODB_URI to .env (MongoDB Atlas).' });
  next();
}

async function connect() {
  if (!URI || URI.includes('your_') || URI === '') return Promise.reject(new Error('No MongoDB URI'));
  let uri = URI;
  if (!uri.includes('retryWrites=')) uri += (uri.includes('?') ? '&' : '?') + 'retryWrites=true&w=majority';
  const options = { serverSelectionTimeoutMS: 10000, autoSelectFamily: false };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const client = await MongoClient.connect(uri, options);
      db = client.db(DB);
      console.log('MongoDB connected');
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:2rem;background:#00356b;color:white;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0">
        <div style="text-align:center">
          <h1>Chat API Server</h1>
          <p>Backend is running. Use the React app at <a href="http://localhost:3000" style="color:#ffd700">localhost:3000</a></p>
          <p><a href="/api/status" style="color:#ffd700">Check DB status</a></p>
        </div>
      </body>
    </html>
  `);
});

app.get('/api/status', async (req, res) => {
  try {
    if (!db) return res.json({ usersCount: 0, sessionsCount: 0, connected: false });
    const usersCount = await db.collection('users').countDocuments();
    const sessionsCount = await db.collection('sessions').countDocuments();
    res.json({ usersCount, sessionsCount, connected: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', requireDb);

// ── Users ────────────────────────────────────────────────────────────────────

app.post('/api/users', async (req, res) => {
  try {
    const { username, password, email, firstName, lastName } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    const name = String(username).trim().toLowerCase();
    const existing = await db.collection('users').findOne({ username: name });
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hashed = await bcrypt.hash(password, 10);
    await db.collection('users').insertOne({
      username: name,
      password: hashed,
      email: email ? String(email).trim().toLowerCase() : null,
      firstName: firstName ? String(firstName).trim() : null,
      lastName: lastName ? String(lastName).trim() : null,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    const name = username.trim().toLowerCase();
    const user = await db.collection('users').findOne({ username: name });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    res.json({
      ok: true,
      username: name,
      firstName: user.firstName || null,
      lastName: user.lastName || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sessions ─────────────────────────────────────────────────────────────────

app.get('/api/sessions', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    const sessions = await db
      .collection('sessions')
      .find({ username })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(
      sessions.map((s) => ({
        id: s._id.toString(),
        agent: s.agent || null,
        title: s.title || null,
        createdAt: s.createdAt,
        messageCount: (s.messages || []).length,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { username, agent } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const { title } = req.body;
    const result = await db.collection('sessions').insertOne({
      username,
      agent: agent || null,
      title: title || null,
      createdAt: new Date().toISOString(),
      messages: [],
    });
    res.json({ id: result.insertedId.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start chat: create session + first assistant message in DB (for grading: first message persists on refresh)
app.post('/api/sessions/start', async (req, res) => {
  try {
    const { username, title, firstName, lastName, agent } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const displayName = [firstName, lastName].filter(Boolean).map((s) => String(s).trim()).join(' ') || username;
    const nameForGreeting = displayName || username;
    const firstMessageContent =
      `Hello ${nameForGreeting}! I'm your YouTube analysis assistant. You can share a YouTube channel JSON or ask me to analyze data, plot metrics, play videos, or generate images. How can I help?`;
    const result = await db.collection('sessions').insertOne({
      username,
      agent: agent || null,
      title: title || 'New Chat',
      createdAt: new Date().toISOString(),
      messages: [],
    });
    const sessionId = result.insertedId.toString();
    const msg = {
      role: 'model',
      content: firstMessageContent,
      timestamp: new Date().toISOString(),
    };
    await db.collection('sessions').updateOne(
      { _id: result.insertedId },
      { $push: { messages: msg } }
    );
    res.json({
      session: {
        id: sessionId,
        title: title || 'New Chat',
        createdAt: new Date().toISOString(),
        agent: agent || null,
        messageCount: 1,
      },
      message: {
        id: `${sessionId}-0`,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await db.collection('sessions').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/sessions/:id/title', async (req, res) => {
  try {
    const { title } = req.body;
    await db.collection('sessions').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { title } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Messages ─────────────────────────────────────────────────────────────────

app.post('/api/messages', async (req, res) => {
  try {
    const { session_id, role, content, imageData, charts, toolCalls } = req.body;
    if (!session_id || !role || content === undefined)
      return res.status(400).json({ error: 'session_id, role, content required' });
    const msg = {
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(imageData && {
        imageData: Array.isArray(imageData) ? imageData : [imageData],
      }),
      ...(charts?.length && { charts }),
      ...(toolCalls?.length && { toolCalls }),
    };
    await db.collection('sessions').updateOne(
      { _id: new ObjectId(session_id) },
      { $push: { messages: msg } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const doc = await db
      .collection('sessions')
      .findOne({ _id: new ObjectId(session_id) });
    const raw = doc?.messages || [];
    const msgs = raw.map((m, i) => {
      const arr = m.imageData
        ? Array.isArray(m.imageData)
          ? m.imageData
          : [m.imageData]
        : [];
      return {
        id: `${doc._id}-${i}`,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        images: arr.length
          ? arr.map((img) => ({ data: img.data, mimeType: img.mimeType }))
          : undefined,
        charts: m.charts?.length ? m.charts : undefined,
        toolCalls: m.toolCalls?.length ? m.toolCalls : undefined,
      };
    });
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── YouTube channel data (for Homework 5) ─────────────────────────────────────
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;

function parseChannelIdOrHandle(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  const handleMatch = u.match(/youtube\.com\/@([^/?]+)/);
  if (handleMatch) return { type: 'handle', value: handleMatch[1] };
  const channelMatch = u.match(/youtube\.com\/channel\/([^/?]+)/);
  if (channelMatch) return { type: 'id', value: channelMatch[1] };
  const shortHandle = u.replace(/^@/, '');
  if (shortHandle && !shortHandle.includes('/')) return { type: 'handle', value: shortHandle };
  return null;
}

async function fetchChannelDataWithProgress({ channelUrl, maxVideos = 10, onProgress = () => {} }) {
  const max = Math.min(100, Math.max(1, parseInt(maxVideos, 10) || 10));
  const parsed = parseChannelIdOrHandle(channelUrl);
  if (!parsed) throw new Error('Invalid channel URL. Use e.g. https://www.youtube.com/@veritasium');

  const base = 'https://www.googleapis.com/youtube/v3';
  let channelId;
  onProgress(5);

  if (parsed.type === 'handle') {
    const r = await fetch(
      `${base}/channels?part=id,snippet,contentDetails&forHandle=${encodeURIComponent(parsed.value)}&key=${YOUTUBE_API_KEY}`
    );
    const data = await r.json();
    if (!data.items || data.items.length === 0) throw new Error(`Channel @${parsed.value} not found`);
    channelId = data.items[0].id;
  } else {
    channelId = parsed.value;
  }
  onProgress(15);

  const channelRes = await fetch(
    `${base}/channels?part=contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`
  );
  const channelData = await channelRes.json();
  const uploadsId = channelData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error('Channel uploads playlist not found');

  const playlistRes = await fetch(
    `${base}/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=${max}&key=${YOUTUBE_API_KEY}`
  );
  const playlistData = await playlistRes.json();
  const videoIds = (playlistData.items || [])
    .map((i) => i.snippet?.resourceId?.videoId)
    .filter(Boolean);
  onProgress(35);

  if (videoIds.length === 0) {
    onProgress(100);
    return { channelId, channelTitle: playlistData?.items?.[0]?.snippet?.channelTitle || '', videos: [] };
  }

  const videosRes = await fetch(
    `${base}/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`
  );
  const videosData = await videosRes.json();
  const byId = (videosData.items || []).reduce((acc, v) => {
    acc[v.id] = v;
    return acc;
  }, {});

  const videos = videoIds.map((id) => {
    const v = byId[id];
    if (!v) return null;
    const sn = v.snippet || {};
    const stat = v.statistics || {};
    const content = v.contentDetails || {};
    const duration = content.duration || '';
    return {
      video_id: id,
      title: sn.title || '',
      description: (sn.description || '').slice(0, 5000),
      duration,
      published_at: sn.publishedAt || null,
      view_count: parseInt(stat.viewCount, 10) || 0,
      like_count: parseInt(stat.likeCount, 10) || 0,
      comment_count: parseInt(stat.commentCount, 10) || 0,
      video_url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail_url: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
      transcript: null,
    };
  }).filter(Boolean);
  onProgress(55);

  let YT;
  try {
    const mod = await import('youtube-transcript');
    YT = mod.YoutubeTranscript;
  } catch (_) {
    YT = null;
  }
  let finalVideos = videos;
  if (YT && videos.length) {
    const n = videos.length;
    finalVideos = [];
    for (let i = 0; i < videos.length; i++) {
      const vid = videos[i];
      let transcript = null;
      try {
        const chunks = await YT.fetchTranscript(vid.video_id);
        if (Array.isArray(chunks) && chunks.length) {
          transcript = chunks.map((c) => (c && c.text) || '').filter(Boolean).join('\n');
        }
      } catch (_) {}
      finalVideos.push({ ...vid, transcript });
      onProgress(55 + Math.round((40 * (i + 1)) / n));
    }
  }
  onProgress(100);
  return {
    channelId,
    channelTitle: playlistData?.items?.[0]?.snippet?.channelTitle || '',
    videos: finalVideos,
  };
}

app.post('/api/youtube/channel', async (req, res) => {
  if (!YOUTUBE_API_KEY) {
    return res.status(503).json({ error: 'YouTube API key not configured. Add YOUTUBE_API_KEY or REACT_APP_YOUTUBE_API_KEY to .env' });
  }
  try {
    const data = await fetchChannelDataWithProgress({ ...req.body, onProgress: () => {} });
    res.json(data);
  } catch (err) {
    console.error(err);
    const status = err.message?.includes('not found') ? 404 : err.message?.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message || 'YouTube API error' });
  }
});

app.post('/api/youtube/channel-stream', async (req, res) => {
  if (!YOUTUBE_API_KEY) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(503).json({ error: 'YouTube API key not configured' });
  }
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const data = await fetchChannelDataWithProgress({
      ...req.body,
      onProgress: (p) => res.write(JSON.stringify({ progress: p }) + '\n'),
    });
    res.write(JSON.stringify({ progress: 100, result: data }) + '\n');
  } catch (err) {
    res.write(JSON.stringify({ progress: 0, error: err.message }) + '\n');
  }
  res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// Image generation (Gemini 2.0 image-capable model)
const GEMINI_API_KEY = process.env.REACT_APP_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

app.post('/api/generate-image', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Gemini API key not configured. Add REACT_APP_GEMINI_API_KEY to .env' });
  }
  try {
    const { prompt: textPrompt, anchorImageBase64, anchorMimeType } = req.body || {};
    const prompt = (textPrompt || 'A simple image').trim();
    const parts = [{ text: prompt }];
    if (anchorImageBase64 && typeof anchorImageBase64 === 'string') {
      const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
      const mime = anchorMimeType && allowed.includes(anchorMimeType) ? anchorMimeType : 'image/png';
      parts.unshift({
        inlineData: { mimeType: mime, data: anchorImageBase64 },
      });
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        responseMimeType: 'text/plain',
      },
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      const errMsg = data?.error?.message || data?.error || JSON.stringify(data);
      return res.status(r.status >= 500 ? 502 : 400).json({ error: errMsg });
    }
    const candidates = data.candidates || [];
    const partsOut = (candidates[0] && candidates[0].content && candidates[0].content.parts) || [];
    const imagePart = partsOut.find((p) => p.inlineData && p.inlineData.data);
    if (imagePart && imagePart.inlineData) {
      return res.json({
        _imageType: 'generated',
        mimeType: imagePart.inlineData.mimeType || 'image/png',
        data: imagePart.inlineData.data,
        prompt,
      });
    }
    return res.json({
      _imageType: 'generated',
      prompt,
      error: 'Image generation model returned no image (e.g. not available in this region). Use placeholder.',
    });
  } catch (err) {
    console.error('[generate-image]', err);
    res.status(500).json({ error: err.message || 'Image generation failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

function startServer() {
  app.listen(PORT, () => {
    console.log(`Server on http://localhost:${PORT}`);
    if (!db) console.warn('MongoDB not connected — add valid REACT_APP_MONGODB_URI to .env for login/sessions');
  });
}

connect()
  .then(startServer)
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    if (err.message.includes('SSL') || err.message.includes('tls') || err.message.includes('alert')) {
      console.error('  → Atlas가 연결을 거부했습니다. Atlas 대시보드에서:');
      console.error('     1) Database Access → 해당 사용자 Edit → Edit Password → 새 비밀번호 설정 후 .env의 비밀번호와 동일하게');
      console.error('     2) Network Access → Add Current IP Address (또는 Allow from anywhere)');
      console.error('     3) Cluster0가 있는 프로젝트(ChatApp MGT Gen AI)에서 설정했는지 확인');
    }
    if (err.message.includes('auth') || err.message.includes('Authentication')) {
      console.error('  → Auth error: Atlas → Database Access → user password (reset and update .env).');
    }
    db = null;
    startServer();
  });
