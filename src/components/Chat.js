import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat, chatWithCsvTools, chatWithYouTubeTools, CODE_KEYWORDS } from '../services/gemini';
import { parseCsvToRows, executeTool, computeDatasetSummary, enrichWithEngagement, buildSlimCsv } from '../services/csvTools';
import { executeYouTubeTool } from '../services/youtubeTools';
import {
  getSessions,
  createSession,
  startSession,
  deleteSession,
  saveMessage,
  loadMessages,
} from '../services/mongoApi';
import EngagementChart from './EngagementChart';
import YouTubeChannelDownload from './YouTubeChannelDownload';
import MetricVsTimeChart from './MetricVsTimeChart';
import PlayVideoCard from './PlayVideoCard';
import GeneratedImage from './GeneratedImage';
import StatsResult, { StatsError } from './StatsResult';
import './Chat.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

const chatTitle = () => {
  const d = new Date();
  return `Chat · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

// Encode a string to base64 safely (handles unicode/emoji in tweet text etc.)
const toBase64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const CHANNEL_JSON_STORAGE_KEY = 'channelJson_';

const parseCSV = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rowCount = lines.length - 1;

  // Short human-readable preview (header + first 5 rows) for context
  const preview = lines.slice(0, 6).join('\n');

  // Full CSV as base64 — avoids ALL string-escaping issues in Python code execution
  // (tweet text with quotes, apostrophes, emojis, etc. all break triple-quoted strings)
  const raw = text.length > 500000 ? text.slice(0, 500000) : text;
  const base64 = toBase64(raw);
  const truncated = text.length > 500000;

  return { headers, rowCount, preview, base64, truncated };
};

// Extract plain text from a message (for history only — never returns base64)
const messageText = (m) => {
  if (m.parts) return m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return m.content || '';
};

// ── Structured part renderer (code execution responses) ───────────────────────

function StructuredParts({ parts }) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text' && part.text?.trim()) {
          return (
            <div key={i} className="part-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.type === 'code') {
          return (
            <div key={i} className="part-code">
              <div className="part-code-header">
                <span className="part-code-lang">
                  {part.language === 'PYTHON' ? 'Python' : part.language}
                </span>
              </div>
              <pre className="part-code-body">
                <code>{part.code}</code>
              </pre>
            </div>
          );
        }
        if (part.type === 'result') {
          const ok = part.outcome === 'OUTCOME_OK';
          return (
            <div key={i} className="part-result">
              <div className="part-result-header">
                <span className={`part-result-badge ${ok ? 'ok' : 'err'}`}>
                  {ok ? '✓ Output' : '✗ Error'}
                </span>
              </div>
              <pre className="part-result-body">{part.output}</pre>
            </div>
          );
        }
        if (part.type === 'image') {
          return (
            <img
              key={i}
              src={`data:${part.mimeType};base64,${part.data}`}
              alt="Generated plot"
              className="part-image"
            />
          );
        }
        return null;
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const userDisplayName = (user) => {
  if (!user) return '';
  const first = user.firstName || '';
  const last = user.lastName || '';
  return [first, last].filter(Boolean).join(' ') || user.username || '';
};

export default function Chat({ user, onLogout }) {
  const username = user?.username ?? '';
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(() => (user ? 'new' : null));
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [images, setImages] = useState([]);
  const [csvContext, setCsvContext] = useState(null);     // pending attachment chip
  const [sessionCsvRows, setSessionCsvRows] = useState(null);    // parsed rows for JS tools
  const [sessionCsvHeaders, setSessionCsvHeaders] = useState(null); // headers for tool routing
  const [csvDataSummary, setCsvDataSummary] = useState(null);    // auto-computed column stats summary
  const [sessionSlimCsv, setSessionSlimCsv] = useState(null);   // key-columns CSV string sent directly to Gemini
  const [jsonContext, setJsonContext] = useState(null);         // pending JSON attachment chip
  const [sessionChannelJson, setSessionChannelJson] = useState(null); // parsed channel JSON for YouTube tools
  const [storageQuotaExceeded, setStorageQuotaExceeded] = useState(false); // localStorage 5MB limit
  const [streaming, setStreaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' | 'youtube'

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(false);
  const fileInputRef = useRef(null);
  const handleDropRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  // Set to true immediately before setActiveSessionId() is called during a send
  // so the messages useEffect knows to skip the reload (streaming is in progress).
  const justCreatedSessionRef = useRef(false);
  const startChatRequestedRef = useRef(false);

  // On login: set 'new' immediately so first message can load right away; load session list in background
  useEffect(() => {
    if (!username) return;
    setActiveSessionId('new');
    getSessions(username).then(setSessions);
  }, [username]);

  const FIRST_GREETING =
    "I'm your YouTube analysis assistant. You can share a channel JSON or ask me to analyze data, plot metrics, play videos, or generate images. How can I help?";

  // New empty chat: show first greeting immediately (client), then persist session in background
  useEffect(() => {
    if (activeSessionId !== 'new' || messages.length !== 0 || !username) return;
    if (startChatRequestedRef.current) return;
    startChatRequestedRef.current = true;
    const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || username;
    const clientFirst = {
      id: 'first-greeting',
      role: 'model',
      content: `Hello ${displayName || 'there'}! ${FIRST_GREETING}`,
      timestamp: new Date().toISOString(),
    };
    setMessages([clientFirst]);
    startSession(username, {
      title: 'New Chat',
      firstName: user?.firstName,
      lastName: user?.lastName,
      agent: 'lisa',
    })
      .then(({ session, message }) => {
        justCreatedSessionRef.current = true;
        setActiveSessionId(session.id);
        setMessages([{ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp }]);
        setSessions((prev) => [{ id: session.id, title: session.title, createdAt: session.createdAt, agent: session.agent, messageCount: session.messageCount ?? 1 }, ...prev]);
      })
      .catch(() => {
        startChatRequestedRef.current = false;
      });
  }, [activeSessionId, messages.length, username, user]);

  useEffect(() => {
    if (!activeSessionId || activeSessionId === 'new') {
      return;
    }
    // If a session was just created during an active send, messages are already
    // in state and streaming is in progress — don't wipe them.
    if (justCreatedSessionRef.current) {
      justCreatedSessionRef.current = false;
      return;
    }
    setMessages([]);
    loadMessages(activeSessionId).then((msgs) => {
      setMessages(msgs);
      const stored = localStorage.getItem(CHANNEL_JSON_STORAGE_KEY + activeSessionId);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed?.videos) setSessionChannelJson(parsed);
        } catch (_) {}
      }
    });
  }, [activeSessionId]);

  // Persist channel JSON per session so it survives refresh and tools can run on it later
  useEffect(() => {
    if (!activeSessionId || activeSessionId === 'new' || !sessionChannelJson?.videos) return;
    const key = CHANNEL_JSON_STORAGE_KEY + activeSessionId;
    const raw = JSON.stringify(sessionChannelJson);
    try {
      localStorage.setItem(key, raw);
      setStorageQuotaExceeded(false);
    } catch (e) {
      if (e?.name === 'QuotaExceededError' || e?.code === 22) {
        try {
          const keys = Object.keys(localStorage).filter((k) => k.startsWith(CHANNEL_JSON_STORAGE_KEY) && k !== key);
          for (const k of keys.slice(0, 3)) localStorage.removeItem(k);
          localStorage.setItem(key, raw);
          setStorageQuotaExceeded(false);
        } catch (_) {
          console.warn('localStorage quota exceeded, channel JSON not cached:', e);
          setStorageQuotaExceeded(true);
        }
      } else {
        console.warn('localStorage save failed, channel JSON not cached:', e);
      }
    }
  }, [activeSessionId, sessionChannelJson]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openMenuId]);

  // ── Session management ──────────────────────────────────────────────────────

  const handleNewChat = () => {
    startChatRequestedRef.current = false;
    setActiveSessionId('new');
    setMessages([]);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
    setJsonContext(null);
    setSessionChannelJson(null);
  };

  const handleSelectSession = (sessionId) => {
    if (sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
    setJsonContext(null);
    setSessionChannelJson(null);
  };

  const handleDeleteSession = async (sessionId, e) => {
    e.stopPropagation();
    setOpenMenuId(null);
    await deleteSession(sessionId);
    const remaining = sessions.filter((s) => s.id !== sessionId);
    setSessions(remaining);
    if (activeSessionId === sessionId) {
      setActiveSessionId(remaining.length > 0 ? remaining[0].id : 'new');
      setMessages([]);
    }
  };

  // ── File handling ───────────────────────────────────────────────────────────

  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  const fileToText = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsText(file);
    });

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const jsonFiles = files.filter((f) => f.name.endsWith('.json') || f.type === 'application/json' || f.type === 'text/json');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (jsonFiles.length > 0) {
      const text = await fileToText(jsonFiles[0]);
      try {
        const data = JSON.parse(text);
        const videos = data.videos || [];
        setJsonContext({ name: jsonFiles[0].name, videoCount: videos.length });
        setSessionChannelJson(data);
      } catch {
        setJsonContext(null);
        setSessionChannelJson(null);
      }
    }

    if (csvFiles.length > 0) {
      const file = csvFiles[0];
      const text = await fileToText(file);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: file.name, ...parsed });
        // Parse rows, add computed engagement col, build summary + slim CSV
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }

    if (imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }

    // Fallback: OS drag often leaves file.type empty; try first file by extension
    if (jsonFiles.length === 0 && csvFiles.length === 0 && imageFiles.length === 0 && files.length > 0) {
      const f = files[0];
      const name = (f.name || '').toLowerCase();
      if (name.endsWith('.json')) {
        try {
          const text = await fileToText(f);
          const data = JSON.parse(text);
          const videos = data.videos || [];
          setJsonContext({ name: f.name, videoCount: videos.length });
          setSessionChannelJson(data);
        } catch {
          setJsonContext(null);
          setSessionChannelJson(null);
        }
      } else if (name.endsWith('.csv')) {
        const text = await fileToText(f);
        const parsed = parseCSV(text);
        if (parsed) {
          setCsvContext({ name: f.name, ...parsed });
          const raw = parseCsvToRows(text);
          const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
          setSessionCsvHeaders(headers);
          setSessionCsvRows(rows);
          setCsvDataSummary(computeDatasetSummary(rows, headers));
          setSessionSlimCsv(buildSlimCsv(rows, headers));
        }
      }
    }
  };
  handleDropRef.current = handleDrop;

  // Document-level drag/drop so file drop works anywhere on the Chat tab
  useEffect(() => {
    if (activeTab !== 'chat') return;
    const hasFiles = (e) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      if (types.includes?.('Files')) return true;
      if (typeof types.contains === 'function' && types.contains('Files')) return true;
      if (e.dataTransfer?.items?.length > 0 && e.dataTransfer.items[0]?.kind === 'file') return true;
      return false;
    };
    const onDragOver = (e) => {
      if (hasFiles(e)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }
    };
    const onDrop = (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      handleDropRef.current?.(e);
    };
    const onDragLeave = (e) => {
      if (!e.relatedTarget || !document.documentElement.contains(e.relatedTarget)) {
        setDragOver(false);
      }
    };
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragleave', onDragLeave, true);
    return () => {
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragleave', onDragLeave, true);
    };
  }, [activeTab]);

  const handleFileSelect = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const jsonFiles = files.filter((f) => f.name.endsWith('.json') || f.type === 'application/json');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (jsonFiles.length > 0) {
      const text = await fileToText(jsonFiles[0]);
      try {
        const data = JSON.parse(text);
        const videos = data.videos || [];
        setJsonContext({ name: jsonFiles[0].name, videoCount: videos.length });
        setSessionChannelJson(data);
      } catch {
        setJsonContext(null);
        setSessionChannelJson(null);
      }
    }
    if (csvFiles.length > 0) {
      const text = await fileToText(csvFiles[0]);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: csvFiles[0].name, ...parsed });
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }
    if (imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  // ── Stop generation ─────────────────────────────────────────────────────────

  const handlePaste = async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    const newImages = await Promise.all(
      imageItems.map(
        (item) =>
          new Promise((resolve) => {
            const file = item.getAsFile();
            if (!file) return resolve(null);
            const reader = new FileReader();
            reader.onload = () =>
              resolve({ data: reader.result.split(',')[1], mimeType: file.type, name: 'pasted-image' });
            reader.readAsDataURL(file);
          })
      )
    );
    setImages((prev) => [...prev, ...newImages.filter(Boolean)]);
  };

  const handleStop = () => {
    abortRef.current = true;
  };

  // ── Send message ────────────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && !images.length && !csvContext && !jsonContext) || streaming || !activeSessionId) return;

    // Lazily create the session in DB on the very first message
    let sessionId = activeSessionId;
    if (sessionId === 'new') {
      const title = chatTitle();
      const { id } = await createSession(username, 'lisa', title);
      sessionId = id;
      justCreatedSessionRef.current = true; // tell useEffect to skip the reload
      setActiveSessionId(id);
      setSessions((prev) => [{ id, agent: 'lisa', title, createdAt: new Date().toISOString(), messageCount: 0 }, ...prev]);
    }

    // ── Routing intent (computed first so we know whether Python/base64 is needed) ──
    // PYTHON_ONLY = things the client tools genuinely cannot produce
    const PYTHON_ONLY_KEYWORDS = /\b(regression|scatter|histogram|seaborn|matplotlib|numpy|time.?series|heatmap|box.?plot|violin|distribut|linear.?model|logistic|forecast|trend.?line)\b/i;
    const wantPythonOnly = PYTHON_ONLY_KEYWORDS.test(text);
    const wantCode = CODE_KEYWORDS.test(text) && !sessionCsvRows;
    const capturedCsv = csvContext;
    const hasCsvInSession = !!sessionCsvRows || !!capturedCsv;
    // Base64 is only worth sending when Gemini will actually run Python
    const needsBase64 = !!capturedCsv && wantPythonOnly;
    // Mode selection:
    //   useYouTubeTools — Channel JSON loaded → YouTube tools (generateImage, plot_metric_vs_time, play_video, compute_stats_json)
    //   useTools        — CSV loaded + no Python needed → client-side JS tools (free, fast)
    //   useCodeExecution — Python explicitly needed (regression, histogram, etc.)
    //   else            — Google Search streaming
    const useYouTubeTools = !!sessionChannelJson?.videos?.length && !wantPythonOnly && !wantCode;
    const useTools = !!sessionCsvRows && !wantPythonOnly && !wantCode && !capturedCsv && !useYouTubeTools;
    const useCodeExecution = wantPythonOnly || wantCode;

    // When user asks for plot/play/stats but no channel JSON is loaded, hint so the model asks to load JSON instead of "unable to access tool"
    const WANTS_YOUTUBE_TOOLS = /\b(plot|play\s*(the\s*)?(video|영상)|view_count|like_count|comment_count|duration|통계|플롯|영상\s*열어|영상\s*재생|most\s*viewed|first\s*video|view\s*count|like\s*count|comment\s*count|그려줘|보여줘)\b/i;
    const wantsYouTubeButNoJson = !sessionChannelJson?.videos?.length && WANTS_YOUTUBE_TOOLS.test(text || '');

    // ── Build prompt ─────────────────────────────────────────────────────────
    // sessionSummary: auto-computed column stats, included with every message
    const sessionSummary = csvDataSummary || '';
    // slimCsv: key columns only (text, type, metrics, engagement) as plain readable CSV
    // ~6-10k tokens — Gemini reads it directly so it can answer from context or call tools
    const slimCsvBlock = sessionSlimCsv
      ? `\n\nFull dataset (key columns):\n\`\`\`csv\n${sessionSlimCsv}\n\`\`\``
      : '';

    const csvPrefix = capturedCsv
      ? needsBase64
        // Python path: send base64 so Gemini can load it with pandas
        ? `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

IMPORTANT — to load the full data in Python use this exact pattern:
\`\`\`python
import pandas as pd, io, base64
df = pd.read_csv(io.BytesIO(base64.b64decode("${capturedCsv.base64}")))
\`\`\`

---

`
        // Standard path: plain CSV text — no encoding needed
        : `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

---

`
      : sessionSummary
      ? `[CSV columns: ${sessionCsvHeaders?.join(', ')}]\n\n${sessionSummary}\n\n---\n\n`
      : '';

    // JSON context for YouTube tools
    const channelJsonContext = sessionChannelJson
      ? { videoCount: sessionChannelJson.videos?.length ?? 0 }
      : null;
    const jsonPrefix = channelJsonContext
      ? `[Channel JSON loaded: ${channelJsonContext.videoCount} videos. Fields: title, description, duration, published_at, view_count, like_count, comment_count, video_url, thumbnail_url.]\n\n`
      : '';

    // userContent  — displayed in bubble and stored in MongoDB (never contains base64)
    // promptForGemini — sent to the Gemini API (may contain the full prefix)
    const userContent = text || (images.length ? '(Image)' : csvContext ? '(CSV attached)' : jsonContext ? '(JSON attached)' : '');
    const defaultPrompt = images.length ? 'What do you see in this image?' : jsonContext ? 'Please analyze this channel data.' : csvContext ? 'Please analyze this CSV data.' : '';
    let promptForGemini = csvPrefix + jsonPrefix + (text || defaultPrompt);
    if (wantsYouTubeButNoJson) {
      promptForGemini =
        '[IMPORTANT: No channel JSON is loaded in this chat. The plot_metric_vs_time, play_video, and compute_stats_json tools are only available after the user drags and drops a channel JSON file into the chat. Do NOT say you cannot access the tool. Instead, briefly ask the user to load a channel JSON file first by dragging it into the chat.]\n\n' +
        promptForGemini;
    }

    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      images: [...images],
      csvName: capturedCsv?.name || null,
      jsonName: jsonContext?.name || null,
    };

    setMessages((m) => [...m, userMsg]);
    setInput('');
    const capturedImages = [...images];
    const capturedChannelJson = sessionChannelJson ? { ...sessionChannelJson } : null;
    setImages([]);
    setCsvContext(null);
    setJsonContext(null);
    setStreaming(true);

    // Store display text only — base64 is never persisted
    await saveMessage(sessionId, 'user', userContent, capturedImages.length ? capturedImages : null);

    const imageParts = capturedImages.map((img) => ({ mimeType: img.mimeType, data: img.data }));

    // History: plain display text only — session summary handles CSV context on every message
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'model')
      .map((m) => ({ role: m.role, content: m.content || messageText(m) }));

    const assistantId = `a-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: assistantId, role: 'model', content: '', timestamp: new Date().toISOString() },
    ]);

    abortRef.current = false;

    let fullContent = '';
    let groundingData = null;
    let structuredParts = null;
    let toolCharts = [];
    let toolCalls = [];

    try {
      if (useYouTubeTools && capturedChannelJson) {
        const executeYt = async (toolName, args) =>
          executeYouTubeTool(toolName, args, capturedChannelJson, {
            anchorImageBase64: capturedImages.length ? capturedImages[0].data : null,
          });
        const imagePartsForApi = capturedImages.map((img) => ({ mimeType: img.mimeType, data: img.data }));
        const { text: answer, charts: returnedCharts, toolCalls: returnedCalls, images: returnedImages, videoCards: returnedVideoCards } = await chatWithYouTubeTools(
          history,
          promptForGemini,
          channelJsonContext,
          executeYt,
          userDisplayName(user),
          imagePartsForApi
        );
        fullContent = answer;
        toolCharts = returnedCharts || [];
        toolCalls = returnedCalls || [];
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: toolCharts.length ? toolCharts : undefined,
                  toolCalls: toolCalls.length ? toolCalls : undefined,
                  youtubeImages: returnedImages?.length ? returnedImages : undefined,
                  youtubeVideoCards: returnedVideoCards?.length ? returnedVideoCards : undefined,
                }
              : msg
          )
        );
      } else if (useTools) {
        // ── Function-calling path: Gemini picks tool + args, JS executes ──────
        console.log('[Chat] useTools=true | rows:', sessionCsvRows.length, '| headers:', sessionCsvHeaders);
        const { text: answer, charts: returnedCharts, toolCalls: returnedCalls } = await chatWithCsvTools(
          history,
          promptForGemini,
          sessionCsvHeaders,
          (toolName, args) => executeTool(toolName, args, sessionCsvRows),
          userDisplayName(user)
        );
        fullContent = answer;
        toolCharts = returnedCharts || [];
        toolCalls = returnedCalls || [];
        console.log('[Chat] returnedCharts:', JSON.stringify(toolCharts));
        console.log('[Chat] toolCalls:', toolCalls.map((t) => t.name));
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: toolCharts.length ? toolCharts : undefined,
                  toolCalls: toolCalls.length ? toolCalls : undefined,
                }
              : msg
          )
        );
      } else {
        // ── Streaming path: code execution or search ─────────────────────────
        for await (const chunk of streamChat(history, promptForGemini, imageParts, useCodeExecution, userDisplayName(user))) {
          if (abortRef.current) break;
          if (chunk.type === 'text') {
            fullContent += chunk.text;
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantId ? { ...msg, content: fullContent } : msg))
            );
          } else if (chunk.type === 'fullResponse') {
            structuredParts = chunk.parts;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, content: '', parts: structuredParts } : msg
              )
            );
          } else if (chunk.type === 'grounding') {
            groundingData = chunk.data;
          }
        }
      }
    } catch (err) {
      const errText = `Error: ${err.message}`;
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, content: errText } : msg))
      );
      fullContent = errText;
    }

    if (groundingData) {
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, grounding: groundingData } : msg))
      );
    }

    // Save plain text + any tool charts to DB
    const savedContent = structuredParts
      ? structuredParts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      : fullContent;
    await saveMessage(
      sessionId,
      'model',
      savedContent,
      null,
      toolCharts.length ? toolCharts : null,
      toolCalls.length ? toolCalls : null
    );

    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, messageCount: s.messageCount + 2 } : s))
    );

    setStreaming(false);
    inputRef.current?.focus();
  };

  const removeImage = (i) => setImages((prev) => prev.filter((_, idx) => idx !== i));

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const diffDays = Math.floor((Date.now() - d) / 86400000);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Today · ${time}`;
    if (diffDays === 1) return `Yesterday · ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="chat-layout">
      {/* ── Sidebar ──────────────────────────────── */}
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <h1 className="sidebar-title">Chat</h1>
          <button className="new-chat-btn" onClick={handleNewChat}>
            + New Chat
          </button>
        </div>

        <div className="sidebar-sessions">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`sidebar-session${session.id === activeSessionId ? ' active' : ''}`}
              onClick={() => handleSelectSession(session.id)}
            >
              <div className="sidebar-session-info">
                <span className="sidebar-session-title">{session.title}</span>
                <span className="sidebar-session-date">{formatDate(session.createdAt)}</span>
              </div>
              <div
                className="sidebar-session-menu"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === session.id ? null : session.id);
                }}
              >
                <span className="three-dots">⋮</span>
                {openMenuId === session.id && (
                  <div className="session-dropdown">
                    <button
                      className="session-delete-btn"
                      onClick={(e) => handleDeleteSession(session.id, e)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <span className="sidebar-username">{userDisplayName(user) || username}</span>
          <button onClick={onLogout} className="sidebar-logout">
            Log out
          </button>
        </div>
      </aside>

      {/* ── Main chat area ───────────────────────── */}
      <div className="chat-main">
        <>
        <div className="chat-tabs">
          <button
            type="button"
            className={`chat-tab ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            className={`chat-tab ${activeTab === 'youtube' ? 'active' : ''}`}
            onClick={() => setActiveTab('youtube')}
          >
            YouTube Channel Download
          </button>
        </div>

        {activeTab === 'youtube' ? (
          <YouTubeChannelDownload />
        ) : (
          <>
        <div
          className="chat-drop-zone"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); }}
          onDragLeave={(e) => {
            if (e.relatedTarget != null && e.currentTarget.contains(e.relatedTarget)) return;
            setDragOver(false);
          }}
          onDrop={handleDrop}
        >
        <header className="chat-header">
          <h2 className="chat-header-title">{activeSession?.title ?? 'New Chat'}</h2>
        </header>

        <div className={`chat-messages${dragOver ? ' drag-over' : ''}`}>
          {activeSessionId === 'new' && messages.length === 0 && (
            <div className="chat-msg model">
              <div className="chat-msg-meta">
                <span className="chat-msg-role">Lisa</span>
                <span className="chat-msg-time">
                  {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="chat-msg-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {`Hello ${[user?.firstName, user?.lastName].filter(Boolean).join(' ') || username || 'there'}! ${FIRST_GREETING}`}
                </ReactMarkdown>
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <div className="chat-msg-meta">
                <span className="chat-msg-role">{m.role === 'user' ? (userDisplayName(user) || username) : 'Lisa'}</span>
                <span className="chat-msg-time">
                  {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {/* CSV / JSON badge on user messages */}
              {(m.csvName || m.jsonName) && (
                <div className="msg-csv-badge">
                  📄 {m.csvName || m.jsonName}
                </div>
              )}

              {/* Image attachments */}
              {m.images?.length > 0 && (
                <div className="chat-msg-images">
                  {m.images.map((img, i) => (
                    <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" className="chat-msg-thumb" />
                  ))}
                </div>
              )}

              {/* Message body */}
              <div className="chat-msg-content">
                {m.role === 'model' ? (
                  m.parts ? (
                    <StructuredParts parts={m.parts} />
                  ) : m.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  ) : (
                    <span className="thinking-dots">
                      <span /><span /><span />
                    </span>
                  )
                ) : (
                  m.content
                )}
              </div>

              {/* Tool calls log */}
              {m.toolCalls?.length > 0 && (
                <details className="tool-calls-details">
                  <summary className="tool-calls-summary">
                    🔧 {m.toolCalls.length} tool{m.toolCalls.length > 1 ? 's' : ''} used
                  </summary>
                  <div className="tool-calls-list">
                    {m.toolCalls.map((tc, i) => (
                      <div key={i} className="tool-call-item">
                        <span className="tool-call-name">{tc.name}</span>
                        <span className="tool-call-args">{JSON.stringify(tc.args)}</span>
                        {tc.result && !tc.result._chartType && !tc.result._cardType && !tc.result._imageType && tc.name !== 'compute_stats_json' && (
                          <span className="tool-call-result">
                            → {JSON.stringify(tc.result).slice(0, 200)}
                            {JSON.stringify(tc.result).length > 200 ? '…' : ''}
                          </span>
                        )}
                        {tc.result?._chartType && (
                          <span className="tool-call-result">→ rendered chart</span>
                        )}
                        {tc.name === 'compute_stats_json' && tc.result && !tc.result.error && (
                          <span className="tool-call-result">→ stats below</span>
                        )}
                        {tc.name === 'compute_stats_json' && tc.result?.error && (
                          <span className="tool-call-result tool-call-error">→ {tc.result.error}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Charts from tool calls: engagement (CSV) or metric_vs_time (YouTube) */}
              {m.charts?.map((chart, ci) =>
                chart._chartType === 'engagement' ? (
                  <EngagementChart
                    key={ci}
                    data={chart.data}
                    metricColumn={chart.metricColumn}
                  />
                ) : chart._chartType === 'metric_vs_time' ? (
                  <MetricVsTimeChart
                    key={ci}
                    data={chart.data}
                    metricField={chart.metricField}
                  />
                ) : null
              )}
              {/* Play video cards (YouTube tool) */}
              {(m.youtubeVideoCards || m.toolCalls?.filter((tc) => tc.result?._cardType === 'play_video').map((tc) => tc.result) || []).map((card, ci) => (
                <PlayVideoCard
                  key={ci}
                  video_url={card.video_url}
                  title={card.title}
                  thumbnail_url={card.thumbnail_url}
                />
              ))}
              {/* Stats from compute_stats_json (YouTube tool) */}
              {m.toolCalls?.filter((tc) => tc.name === 'compute_stats_json' && tc.result).map((tc, ci) =>
                tc.result.error ? (
                  <StatsError key={ci} message={tc.result.error} />
                ) : (
                  <StatsResult key={ci} result={tc.result} />
                )
              )}
              {/* Generated images (YouTube tool) */}
              {(m.youtubeImages || m.toolCalls?.filter((tc) => tc.result?._imageType === 'generated').map((tc) => tc.result) || []).map((img, ci) => (
                <GeneratedImage
                  key={ci}
                  data={img.data}
                  mimeType={img.mimeType}
                  prompt={img.prompt}
                />
              ))}

              {/* Search sources */}
              {m.grounding?.groundingChunks?.length > 0 && (
                <div className="chat-msg-sources">
                  <span className="sources-label">Sources</span>
                  <div className="sources-list">
                    {m.grounding.groundingChunks.map((chunk, i) =>
                      chunk.web ? (
                        <a key={i} href={chunk.web.uri} target="_blank" rel="noreferrer" className="source-link">
                          {chunk.web.title || chunk.web.uri}
                        </a>
                      ) : null
                    )}
                  </div>
                  {m.grounding.webSearchQueries?.length > 0 && (
                    <div className="sources-queries">
                      Searched: {m.grounding.webSearchQueries.join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {dragOver && (
          <div
            className="chat-drop-overlay"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDrop={handleDrop}
          >
            Drop CSV, JSON, or images here
          </div>
        )}
        </div>

        {/* ── Input area ── */}
        <div className="chat-input-area">
          {/* CSV chip */}
          {csvContext && (
            <div className="csv-chip">
              <span className="csv-chip-icon">📄</span>
              <span className="csv-chip-name">{csvContext.name}</span>
              <span className="csv-chip-meta">
                {csvContext.rowCount} rows · {csvContext.headers.length} cols
              </span>
              <button className="csv-chip-remove" onClick={() => setCsvContext(null)} aria-label="Remove CSV">×</button>
            </div>
          )}
          {/* JSON chip (channel data) — show when just dropped (jsonContext) or already in session (sessionChannelJson) */}
          {(jsonContext || sessionChannelJson?.videos?.length) && (
            <>
              <div className="csv-chip">
                <span className="csv-chip-icon">📋</span>
                <span className="csv-chip-name">{jsonContext?.name || 'Channel JSON'}</span>
                <span className="csv-chip-meta">{sessionChannelJson?.videos?.length ?? jsonContext?.videoCount ?? 0} videos · plot, play, stats</span>
                <button className="csv-chip-remove" onClick={() => { setJsonContext(null); setSessionChannelJson(null); setStorageQuotaExceeded(false); }} aria-label="Remove JSON">×</button>
              </div>
              {storageQuotaExceeded && (
                <p className="chat-storage-warning">Channel data could not be saved to this device (storage limit ~5MB). It will still work in this session.</p>
              )}
            </>
          )}

          {/* Image previews */}
          {images.length > 0 && (
            <div className="chat-image-previews">
              {images.map((img, i) => (
                <div key={i} className="chat-img-preview">
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                  <button type="button" onClick={() => removeImage(i)} aria-label="Remove">×</button>
                </div>
              ))}
            </div>
          )}

          {/* Hidden file picker */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.csv,text/csv,.json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />

          <div className="chat-input-row">
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              title="Attach image, CSV, or JSON"
            >
              📎
            </button>
            <input
              ref={inputRef}
              type="text"
              placeholder="Ask a question, request analysis, or write & run code…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              onPaste={handlePaste}
              disabled={streaming}
            />
            {streaming ? (
              <button onClick={handleStop} className="stop-btn">
                ■ Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() && !images.length && !csvContext && !jsonContext && !sessionChannelJson?.videos?.length}
              >
                Send
              </button>
            )}
          </div>
        </div>
          </>
        )}
        </>
      </div>
    </div>
  );
}
