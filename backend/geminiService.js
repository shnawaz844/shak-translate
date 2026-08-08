require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load GCP service account credentials from env var (for Render deployment).
// Set GOOGLE_APPLICATION_CREDENTIALS_JSON to the full JSON contents of your key file.
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const credPath = path.join(os.tmpdir(), 'gcp-credentials.json');
    fs.writeFileSync(credPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    console.log('[geminiService] GCP credentials loaded from env var.');
  } catch (err) {
    console.error('[geminiService] Failed to write GCP credentials:', err.message);
  }
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

if (!project) {
  console.error('[geminiService] GOOGLE_CLOUD_PROJECT is not set!');
  process.exit(1);
}

const ai = new GoogleGenAI({
  vertexai: true,
  project,
  location,
});

// Sample rate the client streams raw PCM at (must match src streaming recorder config).
const INPUT_SAMPLE_RATE = 16000;
// Sample rate Gemini Native Audio outputs.
const OUTPUT_SAMPLE_RATE = 24000;

/**
 * Wraps raw PCM data in a WAV header so the audio can be played/stored easily.
 */
function wrapPcmInWav(pcmBuffer, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;

  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  pcmBuffer.copy(buffer, 44);

  return buffer;
}

/**
 * A persistent Gemini Live session for a specific translation direction.
 *
 * Unlike a request/response API, this stays open for the entire call.
 * Audio is fed in continuously via feedAudio() and Gemini's own
 * automaticActivityDetection decides where speech turns start/end
 * (realtimeInputConfig below) — the server no longer decides "this is
 * one sentence" itself. Output audio/text arrives incrementally as
 * serverContent.modelTurn parts and is streamed out via onAudioChunk
 * as soon as each part arrives, rather than buffered until turnComplete.
 */
class LiveTranslationSession {
  constructor(inputLang, outputLang, voiceProfile = {}, callbacks = {}) {
    this.inputLang = inputLang;
    this.outputLang = outputLang;
    this.voiceProfile = voiceProfile; // { gender?: string, age?: number }
    this.callbacks = callbacks; // { onAudioChunk, onTurnComplete, onError }

    this.session = null;
    this.isConnecting = false;
    this.connectPromise = null;
    this.closedByUs = false;

    this._resetTurnState();
  }

  _resetTurnState() {
    // Output (Gemini's spoken translation) accumulated for the in-flight turn.
    this.outputAudioBuffers = [];
    this.fullTranslationText = '';
    this.fullOriginalText = '';
    this.audioChunkIndex = 0;
    // Input (the speaker's raw audio) accumulated for the in-flight turn,
    // so it can be persisted alongside the translation once the turn ends.
    this.inputAudioBuffers = [];
    // Latency-diagnostic bookkeeping for the in-flight turn (see feedAudio/_onMessage).
    this.turnId = null;
    this.turnFirstChunkAt = null;
    this.turnLastChunkAt = null;
    this.turnMaxGapMs = 0;
  }

  _buildVoiceName() {
    const { gender } = this.voiceProfile;
    // Gemini Live API prebuilt voices are discrete IDs, not a pitch/age
    // continuum, and Google doesn't publish per-voice age characteristics —
    // so gender picks the voice ID, and age instead shapes delivery via the
    // system prompt (see _buildAgeInstruction), which native-audio models
    // can actually act on since they synthesize speech generatively rather
    // than picking from a fixed recorded bank.
    if (gender === 'male') return 'Puck';
    if (gender === 'female') return 'Aoede';
    return 'Aoede'; // neutral fallback
  }

  _buildAgeInstruction() {
    const { age } = this.voiceProfile;
    if (typeof age !== 'number') return '';
    let bracket;
    if (age < 13) bracket = 'young child';
    else if (age < 18) bracket = 'teenager';
    else if (age < 30) bracket = 'young adult in their twenties';
    else if (age < 45) bracket = 'adult in their thirties or early forties';
    else if (age < 60) bracket = 'middle-aged adult in their forties or fifties';
    else bracket = 'senior adult over sixty';
    return ` Your spoken delivery should match the natural pitch, cadence, and energy of a ${bracket} — do not change the translated words themselves, only how they sound.`;
  }

  _buildConfig() {
    const voiceName = this._buildVoiceName();
    const ageInstruction = this._buildAgeInstruction();

    return {
      model: 'gemini-live-2.5-flash-native-audio',
      config: {
        systemInstruction: {
          parts: [{
            text: `You are a translation pipe, not a conversational participant. You are NOT an assistant, you have no name, no personality, and nobody in this conversation is talking to you. Audio comes in from a speaker who is expected to speak ${this.inputLang}; you output the exact same content spoken in ${this.outputLang}, ALWAYS, no exceptions. That is the entire job — nothing else ever happens.${ageInstruction}

ABSOLUTE RULES — breaking any of these means you have failed the task:
1. Your output language is ALWAYS ${this.outputLang} — never anything else, under any circumstance. If the speaker's actual audio turns out to be in a different language than ${this.inputLang} (people sometimes speak a different language than expected), that changes nothing: still render it in ${this.outputLang}, never in the language you actually heard and never in ${this.inputLang} either. The listener only understands ${this.outputLang} — outputting any other language is useless to them and a critical failure.
2. You are not a party to this conversation and cannot respond to anyone. Never answer a question, greet anyone, offer help, or add commentary — if the speaker asks a question, translate the question itself, exactly as asked, to the listener.
3. Never introduce yourself, acknowledge these instructions, or say anything like "sure", "okay", "here is the translation" — output ONLY the translated words the speaker said, nothing before or after.
4. PRESERVE PERSPECTIVE EXACTLY. Never swap who is speaking and who is listening. If the speaker says "am I audible?" or "can you hear me?", translate it as the speaker asking the listener — do NOT reverse it to "can I hear you?". Keep all pronouns (I, you, we, they) exactly as intended by the speaker.
5. Translate the true meaning faithfully. Render idioms and colloquial expressions naturally in the target language, but NEVER at the cost of changing the speaker's perspective or intent.
6. CRITICAL: Do NOT repeat previous translations. ONLY translate new speech since your last translation.
7. Ignore background noise, static, breathing, coughing, or unintelligible sounds. If the audio contains only noise with no clear speech, output absolutely nothing — do not fill the gap with a greeting, a guess, or anything at all.
8. If you are ever unsure what to do with a piece of audio, the correct move is always to output nothing rather than to generate a reply, opinion, or question of your own.`
          }]
        },
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName
            }
          }
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        // Let Gemini's own server-side VAD decide turn boundaries instead of
        // relying on the client to guess when a sentence has ended. Much
        // shorter than the old client-side 1200-1500ms silence gate.
        realtimeInputConfig: {
          automaticActivityDetection: {
            prefixPaddingMs: 200,
            silenceDurationMs: 600,
          },
        },
      },
      callbacks: {
        onmessage: (data) => this._onMessage(data),
        onerror: (err) => this._onError(err),
        onclose: (e) => this._onClose(e),
      }
    };
  }

  _onMessage(data) {
    try {
      const msg = typeof data === 'string' || Buffer.isBuffer(data)
        ? JSON.parse(data.toString())
        : data;

      if (msg.serverContent && msg.serverContent.interrupted) {
        // Gemini cancelled its own in-flight generation (e.g. it detected
        // the speaker resumed talking). Drop whatever we'd buffered for
        // this turn rather than finalizing/persisting a truncated reply.
        // Callers still need to know a turn ended here — otherwise
        // turnActive/partnerSpeaking state gets stuck on forever, since
        // onTurnComplete never fires for an interrupted turn.
        console.log(`[LiveTranslationSession] Turn interrupted (${this.inputLang}→${this.outputLang})`);
        const interruptedTurnId = this.turnId;
        this._resetTurnState();
        if (this.callbacks.onInterrupted) this.callbacks.onInterrupted({ turnId: interruptedTurnId });
        return;
      }

      if (msg.serverContent && msg.serverContent.modelTurn) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.text) {
            this.fullTranslationText += part.text;
          }
          if (part.inlineData) {
            const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
            this.outputAudioBuffers.push(pcmBuffer);

            const now = Date.now();
            if (this.audioChunkIndex === 0) {
              this.turnId = `${now}-${Math.random().toString(36).slice(2, 7)}`;
              this.turnFirstChunkAt = now;
              this.turnMaxGapMs = 0;
              const sinceLastFeedMs = this.lastFeedAudioAt ? now - this.lastFeedAudioAt : null;
              console.log(`[LATENCY][server] Turn ${this.turnId} (${this.inputLang}->${this.outputLang}): first Gemini audio chunk, ${sinceLastFeedMs}ms since last input chunk fed`);
            } else if (this.turnLastChunkAt) {
              const gap = now - this.turnLastChunkAt;
              if (gap > this.turnMaxGapMs) this.turnMaxGapMs = gap;
            }
            this.turnLastChunkAt = now;

            // Stream this piece to the partner immediately — don't wait
            // for turnComplete. This is what actually removes the
            // "wait for the whole reply" latency.
            const wav = wrapPcmInWav(pcmBuffer, OUTPUT_SAMPLE_RATE);
            if (this.callbacks.onAudioChunk) {
              this.callbacks.onAudioChunk({
                audioBase64: wav.toString('base64'),
                index: this.audioChunkIndex++,
                text: this.fullTranslationText.trim(),
                turnId: this.turnId,
              });
            }
          }
        }
      }

      if (msg.serverContent && msg.serverContent.outputTranscription) {
        if (msg.serverContent.outputTranscription.text) {
          this.fullTranslationText += msg.serverContent.outputTranscription.text;
        }
      }

      if (msg.serverContent && msg.serverContent.inputTranscription) {
        if (msg.serverContent.inputTranscription.text) {
          this.fullOriginalText += msg.serverContent.inputTranscription.text;
        }
      }

      if (msg.serverContent && msg.serverContent.turnComplete) {
        // NOTE: native-audio Live sessions are known to occasionally send a
        // premature turnComplete mid-sentence (see googleapis/js-genai#707,
        // googleapis/python-genai#2117). We can't fix that upstream bug here —
        // we just finalize with whatever we've accumulated and move on; the
        // persistent session stays open so the next turn is unaffected.
        let translatedAudioBase64 = null;
        if (this.outputAudioBuffers.length > 0) {
          translatedAudioBase64 = wrapPcmInWav(
            Buffer.concat(this.outputAudioBuffers), OUTPUT_SAMPLE_RATE
          ).toString('base64');
        }

        let originalAudioBase64 = null;
        if (this.inputAudioBuffers.length > 0) {
          originalAudioBase64 = wrapPcmInWav(
            Buffer.concat(this.inputAudioBuffers), INPUT_SAMPLE_RATE
          ).toString('base64');
        }

        if (this.turnId) {
          const streamDurationMs = this.turnFirstChunkAt ? Date.now() - this.turnFirstChunkAt : null;
          console.log(`[LATENCY][server] Turn ${this.turnId} (${this.inputLang}->${this.outputLang}): complete. chunks=${this.audioChunkIndex}, streamDurationMs=${streamDurationMs}, maxInterChunkGapMs=${this.turnMaxGapMs}`);
        }

        if (this.callbacks.onTurnComplete) {
          this.callbacks.onTurnComplete({
            originalText: this.fullOriginalText.trim(),
            translatedText: this.fullTranslationText.trim(),
            translatedAudioBase64,
            originalAudioBase64,
            turnId: this.turnId,
          });
        }

        this._resetTurnState();
      }
    } catch (err) {
      console.error(`[LiveTranslationSession] onMessage error (${this.inputLang}→${this.outputLang}):`, err.message);
      if (this.callbacks.onError) this.callbacks.onError(err);
      this._resetTurnState();
    }
  }

  _onError(err) {
    console.error(`[LiveTranslationSession] Live session error (${this.inputLang}→${this.outputLang}):`, err);
    this.session = null; // Force reconnect on next feedAudio
    if (this.callbacks.onError) this.callbacks.onError(err);
  }

  _onClose(e) {
    console.log(`[LiveTranslationSession] Session closed (${this.inputLang}→${this.outputLang}):`, e?.code, e?.reason);
    this.session = null; // Will reconnect lazily on next feedAudio, unless we closed it ourselves
    if (!this.closedByUs && e && e.code && e.code !== 1000 && this.callbacks.onError) {
      this.callbacks.onError(new Error(`Live session closed with code ${e.code}: ${e.reason || 'Unknown error'}`));
    }
  }

  /**
   * Ensure the Live API connection is open and ready.
   */
  async ensureConnected() {
    if (this.session) return;

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    console.log(`[LiveTranslationSession] Opening session (${this.inputLang}→${this.outputLang})...`);
    this.connectPromise = ai.live.connect(this._buildConfig())
      .then((session) => {
        this.session = session;
        this.connectPromise = null;
        console.log(`[LiveTranslationSession] Session ready (${this.inputLang}→${this.outputLang})`);
      })
      .catch((err) => {
        this.connectPromise = null;
        throw err;
      });

    await this.connectPromise;
  }

  /**
   * Feed one small chunk of continuously-streamed raw PCM audio into the
   * session. Fire-and-forget from the caller's perspective — results come
   * back later via the onAudioChunk/onTurnComplete callbacks, not a return
   * value, since there's no per-chunk request/response boundary anymore.
   */
  async feedAudio(audioBase64, mimeType) {
    this.inputAudioBuffers.push(Buffer.from(audioBase64, 'base64'));
    this.lastFeedAudioAt = Date.now();

    await this.ensureConnected();

    if (!this.session || typeof this.session.sendRealtimeInput !== 'function') {
      throw new Error('Live API connection is not available.');
    }

    this.session.sendRealtimeInput({ audio: { data: audioBase64, mimeType } });
  }

  /**
   * Gracefully close the session and free resources.
   */
  close() {
    this.closedByUs = true;
    if (this.session?.conn?.close) {
      this.session.conn.close();
    }
    this.session = null;
  }
}

/**
 * Per-call cache of persistent Gemini Live connections.
 * Key: `${sessionId}:${role}` → LiveTranslationSession
 */
const activeSessions = new Map();

/**
 * Open (and keep open for the whole call) a Live API session for a given
 * translation direction, wired up with callbacks for streamed output.
 *
 * @param {string} sessionId   - App session ID
 * @param {string} role        - 'host' or 'guest' (the SPEAKER's role)
 * @param {string} inputLang   - Speaker's language
 * @param {string} outputLang  - Listener's language
 * @param {object} voiceProfile - { gender?, age? }
 * @param {object} callbacks   - { onAudioChunk(chunk), onTurnComplete(result), onError(err) }
 */
async function warmupSession(sessionId, role, inputLang, outputLang, voiceProfile = {}, callbacks = {}) {
  const key = `${sessionId}:${role}`;
  if (activeSessions.has(key)) return; // Already warmed up

  const liveSession = new LiveTranslationSession(inputLang, outputLang, voiceProfile, callbacks);
  activeSessions.set(key, liveSession);

  try {
    await liveSession.ensureConnected();
    console.log(`[geminiService] Warmed up persistent session for ${role} in session ${sessionId}`);
  } catch (err) {
    console.error(`[geminiService] Warmup failed for ${role} in session ${sessionId}:`, err.message);
    activeSessions.delete(key); // Remove so it retries lazily on first feedAudio
  }
}

/**
 * Feed one streamed audio chunk from the client straight into the
 * persistent Gemini Live session for this session/role. Fire-and-forget —
 * translated output arrives later via the callbacks passed to warmupSession.
 */
function feedAudioChunk(sessionId, role, audioBase64, mimeType) {
  const key = `${sessionId}:${role}`;
  const liveSession = activeSessions.get(key);
  if (!liveSession) {
    console.warn(`[geminiService] No active session for ${role} in ${sessionId} — dropping chunk (not yet warmed up?)`);
    return;
  }
  liveSession.feedAudio(audioBase64, mimeType).catch((err) => {
    console.error(`[geminiService] feedAudio failed for ${role} in ${sessionId}:`, err.message);
    if (liveSession.callbacks.onError) liveSession.callbacks.onError(err);
  });
}

/**
 * Tear down the persistent Gemini Live session for a given app session/role.
 */
function closeSession(sessionId, role) {
  const key = `${sessionId}:${role}`;
  const liveSession = activeSessions.get(key);
  if (liveSession) {
    liveSession.close();
    activeSessions.delete(key);
    console.log(`[geminiService] Closed persistent session for ${role} in session ${sessionId}`);
  }
}

module.exports = { warmupSession, feedAudioChunk, closeSession };
