const API = process.env.REACT_APP_API_URL || '';

/** GET /api/status — { connected: boolean, usersCount?, sessionsCount? } */
export const getDbStatus = async () => {
  const res = await fetch(`${API}/api/status`);
  const data = await res.json().catch(() => ({}));
  return data;
};

const api = async (path, options = {}) => {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return text ? JSON.parse(text) : {};
};

// ── Users ────────────────────────────────────────────────────────────────────

export const createUser = async (username, password, email = '', firstName = '', lastName = '') => {
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, email, firstName, lastName }),
  });
};

export const findUser = async (username, password) => {
  const data = await api('/api/users/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  return data.ok
    ? {
        username: data.username,
        firstName: data.firstName || '',
        lastName: data.lastName || '',
      }
    : null;
};

// ── Sessions ─────────────────────────────────────────────────────────────────

export const getSessions = async (username) => {
  return api(`/api/sessions?username=${encodeURIComponent(username)}`);
};

export const createSession = async (username, agent = null, title = null) => {
  return api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ username, agent, title }),
  });
};

/** Start chat: create session + first assistant message in DB. Returns { session, message }. */
export const startSession = async (username, options = {}) => {
  const { title, firstName, lastName, agent } = options;
  return api('/api/sessions/start', {
    method: 'POST',
    body: JSON.stringify({ username, title, firstName, lastName, agent }),
  });
};

export const deleteSession = async (sessionId) => {
  return api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
};

export const updateSessionTitle = async (sessionId, title) => {
  return api(`/api/sessions/${sessionId}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
};

// ── Messages ─────────────────────────────────────────────────────────────────

export const saveMessage = async (sessionId, role, content, imageData = null, charts = null, toolCalls = null) => {
  return api('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, role, content, imageData, charts, toolCalls }),
  });
};

export const loadMessages = async (sessionId) => {
  return api(`/api/messages?session_id=${encodeURIComponent(sessionId)}`);
};

// ── YouTube channel data (Homework 5) ────────────────────────────────────────

export const fetchYouTubeChannelData = async (channelUrl, maxVideos) => {
  return api('/api/youtube/channel', {
    method: 'POST',
    body: JSON.stringify({ channelUrl, maxVideos }),
  });
};

/** Stream download with real progress (NDJSON). Calls onProgress(0–100). Returns final result. */
export const fetchYouTubeChannelDataStream = async (channelUrl, maxVideos, { onProgress = () => {} } = {}) => {
  const base = process.env.REACT_APP_API_URL || '';
  const res = await fetch(`${base}/api/youtube/channel-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelUrl, maxVideos }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.progress === 'number') onProgress(obj.progress);
        if (obj.result) result = obj.result;
        if (obj.error) throw new Error(obj.error);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer);
      if (typeof obj.progress === 'number') onProgress(obj.progress);
      if (obj.result) result = obj.result;
      if (obj.error) throw new Error(obj.error);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  if (!result) throw new Error('No result from stream');
  return result;
};
