require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { warmupSession, feedAudioChunk, closeSession } = require('./geminiService');
const { supabase } = require('./supabaseClient');
const { uploadAudio } = require('./storageService');
const { APP_NAME } = require('./app-config');

const PORT = process.env.PORT || 8080;
const LATEST_ANDROID_APK_URL = process.env.LATEST_ANDROID_APK_URL || 'https://expo.dev/accounts/shahahmad/projects/shak-translate/builds/bb9de5af-858f-4444-948e-8a1a54ca988f';

// The plain WebRTC call (src/hooks/useWebRTCCall.ts) validated that call
// quality/latency is solid without Gemini in the loop. AI translation is
// back on for real: audio_stream_chunk now feeds Gemini as before.
const AI_TRANSLATION_ENABLED = true;

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  console.error('[server] CLERK_SECRET_KEY is not set — /clerk/update-profile will not work.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function verifyClerkToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed JWT — expected 3 parts');
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    if (!payload.sub) throw new Error('JWT has no sub claim');
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) throw new Error('Token has expired');
    return payload.sub;
  } catch (err) {
    throw new Error('Invalid token: ' + err.message);
  }
}

async function updateClerkMetadata(userId, metadata) {
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ public_metadata: metadata }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.errors?.[0]?.message ?? `Metadata update failed (${res.status})`);
  }
  return res.json();
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /clerk/update-profile ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/clerk/update-profile') {
    try {
      if (!CLERK_SECRET_KEY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CLERK_SECRET_KEY not configured on server.' }));
        return;
      }
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
      const { age, gender } = body;
      if (!age || !gender) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'age and gender are required.' }));
        return;
      }
      const authHeader = req.headers['authorization'] ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing Authorization header.' }));
        return;
      }
      const userId = await verifyClerkToken(token);
      await updateClerkMetadata(userId, { age: Number(age), gender, onboardingComplete: true });
      console.log(`[server] Updated Clerk metadata for user ${userId}: age=${age}, gender=${gender}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('[server] /clerk/update-profile error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /conversations?userId=... ──────────────────────────────────────────
  if (req.method === 'GET' && req.url?.match(/^\/conversations(\?.*)?$/)) {
    try {
      const url = new URL(req.url, `http://localhost`);
      const userId = url.searchParams.get('userId');
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'userId is required' }));
        return;
      }

      const { data: conversations, error } = await supabase
        .from('conversations')
        .select(`
          id, session_id, host_user_id, guest_user_id, host_lang, guest_lang, started_at, ended_at,
          messages(id, sender_user_id, role, original_text, translated_text, sent_at)
        `)
        .or(`host_user_id.eq.${userId},guest_user_id.eq.${userId}`)
        .order('started_at', { ascending: false })
        .limit(20);

      if (error) throw error;

      const result = (conversations || []).map(conv => {
        const msgs = (conv.messages || []).sort((a, b) =>
          new Date(a.sent_at) - new Date(b.sent_at)
        );
        const lastMsg = msgs[msgs.length - 1] || null;
        const partnerRole = conv.host_user_id === userId ? 'guest' : 'host';
        const partnerLang = partnerRole === 'guest' ? conv.guest_lang : conv.host_lang;
        const myLang = partnerRole === 'guest' ? conv.host_lang : conv.guest_lang;
        return {
          id: conv.id,
          sessionId: conv.session_id,
          myLang,
          partnerLang,
          startedAt: conv.started_at,
          endedAt: conv.ended_at,
          lastMessage: lastMsg ? {
            text: lastMsg.sender_user_id === userId ? lastMsg.original_text : lastMsg.translated_text,
            sentAt: lastMsg.sent_at,
            isMe: lastMsg.sender_user_id === userId,
          } : null,
          messageCount: msgs.length,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[server] /conversations error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /conversations/:id/messages ───────────────────────────────────────
  if (req.method === 'GET' && /^\/conversations\/[^/]+\/messages$/.test(req.url)) {
    try {
      const convId = req.url.split('/')[2];
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', convId)
        .order('sent_at', { ascending: true });

      if (error) throw error;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages || []));
    } catch (err) {
      console.error('[server] /conversations/:id/messages error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /conversations/:id/recordings ─────────────────────────────────────
  if (req.method === 'GET' && /^\/conversations\/[^/]+\/recordings$/.test(req.url)) {
    try {
      const convId = req.url.split('/')[2];
      const { data: messages, error } = await supabase
        .from('messages')
        .select('id, sender_user_id, role, original_text, translated_text, original_audio_url, translated_audio_url, original_audio_offset_ms, sent_at')
        .eq('conversation_id', convId)
        .order('sent_at', { ascending: true });

      if (error) throw error;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages || []));
    } catch (err) {
      console.error('[server] /conversations/:id/recordings error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /health ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); res.end('OK'); return; }

  // ── GET /gemini-test ───────────────────────────────────────────────────────
  // Quick connectivity check: tries to open a Gemini Live session and
  // immediately closes it, reporting success or the exact error.
  if (req.method === 'GET' && req.url === '/gemini-test') {
    const { warmupSession, closeSession } = require('./geminiService');
    const testId = 'health-check-' + Date.now();
    try {
      await warmupSession(testId, 'host', 'English', 'Hindi', {}, {
        onAudioChunk: () => {},
        onTurnComplete: () => {},
        onInterrupted: () => {},
        onError: (e) => { console.error('[gemini-test] Error:', e.message); },
      });
      closeSession(testId, 'host');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Gemini Live connection successful' }));
    } catch (err) {
      console.error('[gemini-test] Failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ── GET /apk or /download/apk ───────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/apk' || req.url === '/download/apk')) {
    res.writeHead(302, { Location: LATEST_ANDROID_APK_URL });
    res.end();
    return;
  }

  // ── GET /join/:sessionId ───────────────────────────────────────────────────
  if (req.method === 'GET' && /^\/join\/[^/]+$/.test(req.url)) {
    const sessionId = req.url.split('/')[2];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Join ${APP_NAME} Call</title>
  <style>
    * { box-sizing: border-box; }
    body {
      background: #0A0D0C;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px 16px;
      text-align: center;
    }
    .card {
      background: #141917;
      border: 1px solid rgba(47, 224, 168, 0.25);
      border-radius: 24px;
      padding: 36px 24px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 16px 40px rgba(0,0,0,0.6);
    }
    .badge {
      display: inline-block;
      background: rgba(47, 224, 168, 0.12);
      color: #2FE0A8;
      border: 1px solid rgba(47, 224, 168, 0.3);
      font-size: 12px;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 999px;
      margin-bottom: 16px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    h1 {
      color: #fff;
      font-size: 24px;
      margin: 0 0 8px 0;
      font-weight: 800;
    }
    h1 span { color: #2FE0A8; }
    #statusText {
      color: #9BA8A4;
      font-size: 15px;
      margin: 0 0 24px 0;
      line-height: 1.5;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font-weight: 700;
      font-size: 16px;
      padding: 16px 20px;
      border-radius: 14px;
      text-decoration: none;
      width: 100%;
      margin-bottom: 12px;
      transition: all 0.2s ease;
      cursor: pointer;
    }
    .btn-primary {
      background: #2FE0A8;
      color: #0A0D0C;
      border: none;
    }
    .btn-primary:active { transform: scale(0.98); }
    .btn-secondary {
      background: #1C2421;
      color: #2FE0A8;
      border: 1px solid rgba(47, 224, 168, 0.4);
    }
    .divider {
      height: 1px;
      background: rgba(255,255,255,0.08);
      margin: 20px 0;
    }
    .session-box {
      background: #0D1210;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .session-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #7C8985;
      font-size: 12px;
      word-break: break-all;
      text-align: left;
    }
    .copy-btn {
      background: #24302C;
      color: #E2ECE8;
      border: none;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .instructions {
      color: #63726E;
      font-size: 13px;
      margin-top: 16px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🌐 Live Call Invite</div>
    <h1>Join <span>${APP_NAME}</span></h1>
    <p id="statusText">Opening your live translation call…</p>
    
    <a href="shaktalk://join/${sessionId}" id="openAppBtn" class="btn btn-primary">
      <span>📞</span> Open Call in ${APP_NAME}
    </a>

    <div id="downloadSection">
      <a href="${LATEST_ANDROID_APK_URL}" id="downloadBtn" class="btn btn-secondary">
        <span>🤖</span> Download Android App (APK)
      </a>
    </div>

    <div class="divider"></div>

    <div class="session-box">
      <div class="session-code" id="codeText">${sessionId}</div>
      <button class="copy-btn" id="copyBtn" onclick="copySessionCode()">Copy Code</button>
    </div>
    
    <div class="instructions">
      If you just installed the app, open it & tap <strong>"Enter code"</strong> or scan the host's QR code.
    </div>
  </div>

  <script>
    var sessionId = "${sessionId}";
    var apkUrl = "${LATEST_ANDROID_APK_URL}";
    var isAndroid = /Android/i.test(navigator.userAgent);

    function copySessionCode() {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(sessionId).then(function() {
          var btn = document.getElementById("copyBtn");
          btn.innerText = "Copied! ✓";
          btn.style.color = "#2FE0A8";
          setTimeout(function() { btn.innerText = "Copy Code"; btn.style.color = "#E2ECE8"; }, 2000);
        });
      }
    }

    // Attempt to open native app
    window.location.href = "shaktalk://join/" + sessionId;
    setTimeout(function() {
      window.location.href = "shaktranslate://join/" + sessionId;
    }, 400);

    // Check if app opened
    var appOpened = false;
    document.addEventListener("visibilitychange", function() {
      if (document.hidden) appOpened = true;
    });
    window.addEventListener("blur", function() {
      appOpened = true;
    });

    // If app didn't open after 2 seconds
    setTimeout(function() {
      if (!appOpened && !document.hidden) {
        var statusEl = document.getElementById("statusText");
        if (statusEl) {
          statusEl.innerHTML = "Don't have <strong>${APP_NAME}</strong> installed yet?<br>Download the Android APK below to join:";
        }
        var dlBtn = document.getElementById("downloadBtn");
        if (dlBtn && isAndroid) {
          dlBtn.className = "btn btn-primary";
          dlBtn.style.boxShadow = "0 4px 20px rgba(47, 224, 168, 0.4)";
        }
      }
    }, 2000);
  </script>
</body>
</html>`);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

/**
 * ARCHITECTURE: Continuous streaming, not per-sentence request/response.
 *
 * Each role has a persistent Gemini Live session (see geminiService.js) that
 * stays open for the whole call. Audio the client streams in via
 * audio_stream_chunk is forwarded to Gemini immediately; Gemini's own
 * automaticActivityDetection decides turn boundaries; translated audio is
 * streamed back to the partner chunk-by-chunk as it's generated instead of
 * being buffered until the whole reply is done.
 *
 * `paused` still supports barge-in: when a listener starts talking over
 * the partner's playback, the client asks the server to stop *delivering*
 * that partner's in-flight translation (Gemini keeps generating — we just
 * don't forward it) until the listener releases the floor again.
 */

const sessions = new Map();

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function getPartnerSocket(session, role) {
  return role === 'host' ? session.guest : session.host;
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function dbCreateConversation(sessionId, hostUserId, hostLang) {
  const { error } = await supabase.from('conversations').insert({
    session_id: sessionId,
    host_user_id: hostUserId,
    host_lang: hostLang,
  });
  if (error) console.error('[db] createConversation error:', error.message);
}

async function dbUpdateConversationGuest(sessionId, guestUserId, guestLang) {
  const { error } = await supabase.from('conversations')
    .update({ guest_user_id: guestUserId, guest_lang: guestLang })
    .eq('session_id', sessionId);
  if (error) console.error('[db] updateConversationGuest error:', error.message);
}

async function dbEndConversation(sessionId) {
  const { error } = await supabase.from('conversations')
    .update({ ended_at: new Date().toISOString() })
    .eq('session_id', sessionId);
  if (error) console.error('[db] endConversation error:', error.message);
}

async function dbInsertMessage(sessionId, senderUserId, role, originalText, translatedText, originalAudioUrl, translatedAudioUrl) {
  if (!originalText && !translatedText) {
    console.log('[db] Skipping insertMessage: both originalText and translatedText are empty');
    return;
  }

  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('session_id', sessionId)
    .single();

  if (!conv) return;

  const { error } = await supabase.from('messages').insert({
    conversation_id: conv.id,
    sender_user_id: senderUserId,
    role,
    original_text: originalText || '',
    translated_text: translatedText || '',
    original_audio_url: originalAudioUrl || null,
    translated_audio_url: translatedAudioUrl || null,
    original_audio_offset_ms: 0,
  });
  if (error) console.error('[db] insertMessage error:', error.message);
}

// ── Per-role Gemini session callbacks ─────────────────────────────────────────

function makeSessionCallbacks(session, sessionId, role) {
  const rs = session.roleState[role];
  const senderSocket = () => role === 'host' ? session.host : session.guest;
  const partnerSocket = () => getPartnerSocket(session, role);

  return {
    onAudioChunk(chunk) {
      if (!sessions.has(sessionId)) return;

      if (!rs.turnActive) {
        rs.turnActive = true;
        rs.turnStartedAt = Date.now();
        console.log(`[LATENCY][server] Turn ${chunk.turnId} (${role}): relaying first chunk to partner at ${rs.turnStartedAt}`);
        send(partnerSocket(), { type: 'partner_speaking', turnId: chunk.turnId });
        send(senderSocket(), { type: 'processing_started', turnId: chunk.turnId });
      }

      if (!rs.paused) {
        send(partnerSocket(), {
          type: 'translated_audio_chunk',
          audioBase64: chunk.audioBase64,
          mimeType: 'audio/wav',
          index: chunk.index,
          text: chunk.text,
          turnId: chunk.turnId,
        });

        if (chunk.text) {
          send(partnerSocket(), {
            type: 'live_subtitle',
            speaker: 'partner',
            translatedText: chunk.text,
            turnId: chunk.turnId,
            isFinal: false,
          });
        }
      }
    },

    onTranscriptionChunk(data) {
      if (!sessions.has(sessionId) || rs.paused) return;

      send(senderSocket(), {
        type: 'live_subtitle',
        speaker: 'self',
        originalText: data.originalText,
        translatedText: data.translatedText,
        turnId: data.turnId,
        isFinal: false,
      });

      send(partnerSocket(), {
        type: 'live_subtitle',
        speaker: 'partner',
        originalText: data.originalText,
        translatedText: data.translatedText,
        turnId: data.turnId,
        isFinal: false,
      });
    },

    onTurnComplete(result) {
      if (!sessions.has(sessionId)) return;
      rs.turnActive = false;
      const relayMs = rs.turnStartedAt ? Date.now() - rs.turnStartedAt : null;
      console.log(`[LATENCY][server] Turn ${result.turnId} (${role}): fully relayed, ${relayMs}ms from first chunk relayed to turn complete`);

      send(senderSocket(), { type: 'processing_done', turnId: result.turnId });

      if (rs.paused) {
        console.log(`[server] Turn ${result.turnId} (${role}) completed while muted — suppressing delivery.`);
        send(partnerSocket(), { type: 'lock_released' });
        return;
      }

      send(senderSocket(), {
        type: 'transcript',
        originalText: result.originalText,
        translatedText: result.translatedText,
        turnId: result.turnId,
      });
      send(partnerSocket(), {
        type: 'translated_audio_final',
        originalText: result.originalText,
        translatedText: result.translatedText,
        audioBase64: result.translatedAudioBase64,
        turnId: result.turnId,
      });
      send(partnerSocket(), { type: 'lock_released' });

      // Finalize live subtitles on both clients
      send(senderSocket(), {
        type: 'live_subtitle',
        speaker: 'self',
        originalText: result.originalText,
        translatedText: result.translatedText,
        turnId: result.turnId,
        isFinal: true,
      });
      send(partnerSocket(), {
        type: 'live_subtitle',
        speaker: 'partner',
        originalText: result.originalText,
        translatedText: result.translatedText,
        turnId: result.turnId,
        isFinal: true,
      });

      const senderUserId = role === 'host' ? session.hostUserId : session.guestUserId;
      if (senderUserId && (result.originalText || result.translatedText)) {
        const messageId = `${sessionId}-${role}-${Date.now()}`;

        Promise.all([
          uploadAudio(sessionId, messageId, 'original', result.originalAudioBase64),
          uploadAudio(sessionId, messageId, 'translated', result.translatedAudioBase64),
        ]).then(([originalAudioUrl, translatedAudioUrl]) => {
          return dbInsertMessage(
            sessionId, senderUserId, role,
            result.originalText, result.translatedText,
            originalAudioUrl, translatedAudioUrl
          );
        }).catch(e => console.error('[db] insertMessage+upload failed:', e.message));
      }
    },

    onInterrupted({ turnId }) {
      if (!sessions.has(sessionId)) return;
      rs.turnActive = false;
      console.log(`[LATENCY][server] Turn ${turnId} (${role}): interrupted, resetting turn state`);

      send(senderSocket(), { type: 'processing_done', turnId });
      send(partnerSocket(), { type: 'lock_released' });
      send(senderSocket(), { type: 'live_subtitle_clear', turnId });
      send(partnerSocket(), { type: 'live_subtitle_clear', turnId });
    },

    onError(err) {
      if (!sessions.has(sessionId)) return;
      rs.turnActive = false;
      console.error(`[server] Gemini error for ${role} in ${sessionId}:`, err.message);
      send(senderSocket(), { type: 'error', message: 'AI processing failed: ' + err.message });
      send(partnerSocket(), { type: 'lock_released' });
    },
  };
}

function cleanupSession(sessionId, disconnectedRole) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.roleState.host.paused = false;
  session.roleState.guest.paused = false;

  const partnerSocket = getPartnerSocket(session, disconnectedRole);
  send(partnerSocket, {
    type: 'partner_disconnected',
    message: `${disconnectedRole === 'host' ? 'Host' : 'Guest'} has disconnected.`,
  });

  if (partnerSocket && partnerSocket.readyState === partnerSocket.OPEN) {
    partnerSocket.close();
  }

  closeSession(sessionId, 'host');
  closeSession(sessionId, 'guest');

  dbEndConversation(sessionId).catch(e => console.error('[db] endConversation failed:', e.message));
  sessions.delete(sessionId);
  console.log(`[server] Session ${sessionId} cleaned up (${disconnectedRole} disconnected).`);
}

// ── WebSocket message handler ─────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('[server] New WebSocket connection');
  let currentSessionId = null;
  let currentRole = null;

  ws.on('message', async (data) => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch (e) { send(ws, { type: 'error', message: 'Invalid JSON message.' }); return; }

    const { type } = message;

    // ── CREATE SESSION (Host) ────────────────────────────────────────────────
    if (type === 'create_session') {
      const { lang, userId, speakerGender, speakerAge } = message;
      const sessionId = uuidv4();
      sessions.set(sessionId, {
        host: ws, hostLang: lang, hostUserId: userId || null,
        hostVoiceProfile: { gender: speakerGender, age: speakerAge },
        guest: null, guestLang: null, guestUserId: null,
        guestVoiceProfile: {},
        roleState: {
          host: { paused: false, turnActive: false },
          guest: { paused: false, turnActive: false },
        },
      });
      currentSessionId = sessionId;
      currentRole = 'host';
      console.log(`[server] Session created: ${sessionId} (Host lang: ${lang}, userId: ${userId}, gender: ${speakerGender})`);
      send(ws, { type: 'session_created', sessionId });

      if (userId) {
        dbCreateConversation(sessionId, userId, lang)
          .catch(e => console.error('[db] createConversation failed:', e.message));
      }
      return;
    }

    // ── JOIN SESSION (Guest) ─────────────────────────────────────────────────
    if (type === 'join_session') {
      const { sessionId, lang, userId, speakerGender, speakerAge } = message;
      const session = sessions.get(sessionId);

      if (!session) { send(ws, { type: 'error', message: `Session "${sessionId}" not found.` }); return; }
      if (session.host === ws) { send(ws, { type: 'error', message: `Cannot join your own session as guest on the same connection.` }); return; }
      if (session.guest) { send(ws, { type: 'error', message: `Session "${sessionId}" already has a guest.` }); return; }

      session.guest = ws;
      session.guestLang = lang;
      session.guestUserId = userId || null;
      session.guestVoiceProfile = { gender: speakerGender, age: speakerAge };
      currentSessionId = sessionId;
      currentRole = 'guest';
      console.log(`[server] Guest joined session: ${sessionId} (Guest lang: ${lang}, userId: ${userId}, gender: ${speakerGender})`);

      send(session.host, { type: 'session_ready', role: 'host', sessionId, partnerLang: session.guestLang });
      send(session.guest, { type: 'session_ready', role: 'guest', sessionId, partnerLang: session.hostLang });

      // Open persistent Gemini Live sessions for BOTH directions in parallel now
      // that both voice profiles are known. We await both before sending gemini_ready
      // so clients know exactly when the AI pipeline is open and audio won't be dropped.
      if (AI_TRANSLATION_ENABLED) {
        const warmupTimeout = new Promise((resolve) => setTimeout(resolve, 5000));
        Promise.race([
          Promise.all([
            warmupSession(
              sessionId, 'host', session.hostLang, session.guestLang,
              session.hostVoiceProfile || {}, makeSessionCallbacks(session, sessionId, 'host')
            ),
            warmupSession(
              sessionId, 'guest', session.guestLang, session.hostLang,
              session.guestVoiceProfile || {}, makeSessionCallbacks(session, sessionId, 'guest')
            ),
          ]),
          warmupTimeout,
        ]).then(() => {
          // Gemini sessions are initialized (or fast timeout reached) — unblock recording on both clients
          console.log(`[server] Gemini ready for ${sessionId} — sending gemini_ready`);
          send(session.host, { type: 'gemini_ready' });
          send(session.guest, { type: 'gemini_ready' });
        }).catch((err) => {
          console.error(`[server] Gemini warmup failed for ${sessionId}:`, err.message);
          send(session.host, { type: 'gemini_ready' });
          send(session.guest, { type: 'gemini_ready' });
        });
      } else {
        // AI disabled — ready immediately
        send(session.host, { type: 'gemini_ready' });
        send(session.guest, { type: 'gemini_ready' });
      }

      if (userId) {
        dbUpdateConversationGuest(sessionId, userId, lang)
          .catch(e => console.error('[db] updateConversationGuest failed:', e.message));
      }
      return;
    }

    // ── FLOOR CONTROL (no-op) ────────────────────────────────────────────────
    if (type === 'claim_turn' || type === 'release_turn') return;

    // ── PAUSE QUEUE (mute / barge-in) ──────────────────────────────────────
    if (type === 'pause_queue') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      const senderRole = ws === session.host ? 'host' : (ws === session.guest ? 'guest' : role);
      if (session.roleState[senderRole]) {
        session.roleState[senderRole].paused = true;
        console.log(`[server] Paused/muted for ${senderRole} in ${sessionId}`);
      }
      return;
    }

    // ── RESUME QUEUE (unmute) ──────────────────────────────────────────────
    if (type === 'resume_queue') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      const senderRole = ws === session.host ? 'host' : (ws === session.guest ? 'guest' : role);
      const rs = session.roleState[senderRole];
      if (rs) {
        rs.paused = false;
        console.log(`[server] Resumed/unmuted for ${senderRole} in ${sessionId}`);
        const partnerSocket = getPartnerSocket(session, senderRole);
        send(partnerSocket, { type: 'queue_resumed' });
      }
      return;
    }

    // ── CANCEL QUEUE (backward compat — kept as alias for clear+resume) ──────
    if (type === 'cancel_queue') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) return;
      const senderRole = ws === session.host ? 'host' : (ws === session.guest ? 'guest' : role);
      if (session.roleState[senderRole]) {
        session.roleState[senderRole].paused = false;
        send(ws, { type: 'queue_cancelled' });
      }
      return;
    }

    // ── STREAMED AUDIO CHUNK (continuous, ~100-250ms of raw PCM) ────────────
    if (type === 'audio_stream_chunk') {
      if (!AI_TRANSLATION_ENABLED) return;
      const { sessionId, role, audioBase64, mimeType } = message;
      const session = sessions.get(sessionId);

      if (!session) { send(ws, { type: 'error', message: 'Session not found.' }); return; }
      if (!session.host || !session.guest) return; // not fully connected yet — drop silently

      // Authoritative socket-based role resolution:
      const senderRole = ws === session.host ? 'host' : (ws === session.guest ? 'guest' : role);
      if (!senderRole) return;

      // When sender is muted/paused, drop all audio chunks immediately — never feed into Gemini!
      if (session.roleState[senderRole]?.paused) return;

      feedAudioChunk(sessionId, senderRole, audioBase64, mimeType);
      return;
    }

    // ── WEBRTC SIGNALING (pure relay — server never touches the audio) ──────
    if (type === 'webrtc_offer' || type === 'webrtc_answer' || type === 'webrtc_ice_candidate' || type === 'webrtc_ready') {
      const { sessionId, role } = message;
      const session = sessions.get(sessionId);
      if (!session) { console.log(`[webrtc] ${type} from ${role}: no session ${sessionId}`); return; }
      const partnerSocket = getPartnerSocket(session, role);
      console.log(`[webrtc] ${type} from ${role} in ${sessionId}: partner socket ${partnerSocket ? 'found' : 'MISSING'}`);
      if (partnerSocket) send(partnerSocket, message);
      return;
    }

    // ── END SESSION ──────────────────────────────────────────────────────────
    if (type === 'end_session') {
      const { sessionId, role } = message;
      cleanupSession(sessionId, role);
      return;
    }

    send(ws, { type: 'error', message: `Unknown message type: ${type}` });
  });

  ws.on('close', () => {
    console.log(`[server] Connection closed. Role: ${currentRole}, Session: ${currentSessionId}`);
    if (currentSessionId && currentRole) cleanupSession(currentSessionId, currentRole);
  });

  ws.on('error', (err) => { console.error('[server] WebSocket error:', err.message); });
});

console.log(`[server] ${APP_NAME} server starting on port ${PORT}`);
httpServer.listen(PORT, () => {
  console.log(`[server] HTTP + WebSocket server listening on port ${PORT}`);
});
