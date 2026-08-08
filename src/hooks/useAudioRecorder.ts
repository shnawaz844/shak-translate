import { useEffect, useRef, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import { useAudioRecorder as useAudioStudioRecorder } from '@siteed/audio-studio';
import type { AudioDataEvent } from '@siteed/audio-studio';

// ═══════════════════════════════════════════════════════════════════════════════
// CONTINUOUS PCM STREAMING CAPTURE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Unlike the old file-based recorder (record whole sentence → stop → upload),
// this captures raw 16-bit PCM continuously for as long as the call is active
// and forwards every small buffer (~150ms of audio) to the caller immediately
// via onChunk. There is no client-side decision about where a "sentence"
// starts or ends anymore — that job now belongs to Gemini's own server-side
// automaticActivityDetection (see backend/geminiService.js), which is far more
// robust than a hand-tuned dB heuristic and doesn't force a multi-second
// silence wait before it will even consider a turn "done".
//
// On web this is a small, fully-owned getUserMedia + Web Audio capture — the
// same mic constraints (echoCancellation/noiseSuppression/autoGainControl)
// that were validated end-to-end by the plain WebRTC call prototype
// (useWebRTCCall.ts) before AI translation was layered back on. It
// deliberately does NOT go through @siteed/audio-studio's web implementation:
// that path already needed patching once for silently dropping Float32 data,
// and a later attempt to fix its effective sample rate caused a regression —
// a black box we don't control isn't worth the risk for the one piece (raw
// PCM capture) that's simple enough to own directly. Native (iOS/Android)
// keeps using @siteed/audio-studio below, unchanged.
//
// The energy meter below is intentionally simple: it only drives the local
// "SPEECH DETECTED" UI pulse and the waveform bars. It never gates or drops
// audio — every captured buffer is always forwarded, so it can't reintroduce
// the "sometimes it just doesn't hear you" failure mode.
// ═══════════════════════════════════════════════════════════════════════════════

// Sample rate Gemini Live expects for input audio (audio/pcm;rate=16000).
const SAMPLE_RATE = 16000;
// How often onAudioStream fires with a new buffer.
const STREAM_INTERVAL_MS = 150;
// Web capture buffer size in samples (must be a power of two for
// ScriptProcessorNode). 2048 samples @ 16kHz ≈ 128ms, close to the native
// STREAM_INTERVAL_MS cadence above.
const WEB_BUFFER_SIZE = 2048;

// Simple energy-based "is there sound" indicator — cosmetic only.
const ENERGY_EMA_ALPHA = 0.4;
const SPEAKING_ON_THRESHOLD = 0.08;
const SPEAKING_OFF_THRESHOLD = 0.035;

interface AudioRecorderOptions {
  /** Whether the mic stream should be capturing right now. */
  enabled: boolean;
  /** Fired for every captured buffer (~150ms of 16-bit PCM @ 16kHz mono, base64). */
  onChunk: (audioBase64: string, mimeType: string) => void;
}

/** Decodes a base64 string to raw bytes without relying on RN's global atob/Buffer shims. */
function base64Decode(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const val = chars.indexOf(clean[i]);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** Encodes a Uint8Array to base64 without relying on RN's global atob/Buffer shims. */
function base64Encode(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    result += chars[b0 >> 2];
    result += chars[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    result += b1 === undefined ? '=' : chars[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    result += b2 === undefined ? '=' : chars[b2 & 0x3f];
  }
  return result;
}

/**
 * Web delivers raw Float32 PCM samples (-1..1) — convert to the same 16-bit
 * PCM base64 wire format native platforms send.
 */
function float32ToBase64PCM16(float32: Float32Array): string {
  const bytes = new Uint8Array(float32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, Math.round(sample * 32767), true);
  }
  return base64Encode(bytes);
}

/** Quick RMS energy (0..1) over an int16 PCM buffer, for the UI meter only. */
function computeEnergy(bytes: Uint8Array): number {
  const sampleCount = Math.floor(bytes.length / 2);
  if (sampleCount === 0) return 0;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const norm = samples[i] / 32768;
    sumSquares += norm * norm;
  }
  return Math.min(1, Math.sqrt(sumSquares / samples.length) * 6); // *6 = rough gain so normal speech reads near 1.0
}

export function useAudioRecorder({ enabled, onChunk }: AudioRecorderOptions) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isWebActive, setIsWebActive] = useState(false);

  const energyEmaRef = useRef(0);
  const speakingRef = useRef(false);
  const onChunkRef = useRef(onChunk);

  useEffect(() => { onChunkRef.current = onChunk; }, [onChunk]);

  const emitChunk = useCallback((base64Data: string) => {
    onChunkRef.current(base64Data, `audio/pcm;rate=${SAMPLE_RATE}`);

    const bytes = base64Decode(base64Data);
    const energy = computeEnergy(bytes);
    energyEmaRef.current = ENERGY_EMA_ALPHA * energy + (1 - ENERGY_EMA_ALPHA) * energyEmaRef.current;
    setAudioLevel(energyEmaRef.current);

    if (!speakingRef.current && energyEmaRef.current > SPEAKING_ON_THRESHOLD) {
      speakingRef.current = true;
      setIsSpeaking(true);
      console.log(`[LATENCY][client] Local speech START at ${Date.now()}`);
    } else if (speakingRef.current && energyEmaRef.current < SPEAKING_OFF_THRESHOLD) {
      speakingRef.current = false;
      setIsSpeaking(false);
      console.log(`[LATENCY][client] Local speech END at ${Date.now()}`);
    }
  }, []);

  // ── Native capture (iOS/Android): @siteed/audio-studio, unchanged ─────────
  const { startRecording, stopRecording, isRecording } = useAudioStudioRecorder();

  const handleNativeAudioStream = useCallback(async (event: AudioDataEvent) => {
    const base64Data = typeof event.data === 'string'
      ? event.data
      : float32ToBase64PCM16(event.data as unknown as Float32Array);
    emitChunk(base64Data);
  }, [emitChunk]);

  // ── Web capture: direct getUserMedia + Web Audio, same mic constraints ────
  // validated by the WebRTC call prototype. Requesting the AudioContext at
  // exactly SAMPLE_RATE lets the browser's own (well-tested) resampler
  // handle converting from the mic's native rate, instead of us hand-rolling
  // resampling again.
  const webAudioContextRef = useRef<AudioContext | null>(null);
  const webStreamRef = useRef<MediaStream | null>(null);
  const webSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const webProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);

  const stopWebCapture = useCallback(() => {
    webProcessorNodeRef.current?.disconnect();
    webProcessorNodeRef.current = null;
    webSourceNodeRef.current?.disconnect();
    webSourceNodeRef.current = null;
    webStreamRef.current?.getTracks().forEach(t => t.stop());
    webStreamRef.current = null;
    if (webAudioContextRef.current) {
      webAudioContextRef.current.close().catch(() => {});
      webAudioContextRef.current = null;
    }
    setIsWebActive(false);
  }, []);

  const startWebCapture = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    webStreamRef.current = stream;

    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext: AudioContext = new AudioContextCtor({ sampleRate: SAMPLE_RATE });
    webAudioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    webSourceNodeRef.current = source;

    // ScriptProcessorNode is deprecated but universally supported and far
    // simpler to wire up reliably than an AudioWorklet module through
    // Metro's web bundler — reliability matters more than avoiding a
    // deprecation warning here.
    const processor = audioContext.createScriptProcessor(WEB_BUFFER_SIZE, 1, 1);
    webProcessorNodeRef.current = processor;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      emitChunk(float32ToBase64PCM16(input));
    };

    source.connect(processor);
    // ScriptProcessorNode only fires onaudioprocess while connected into the
    // graph's destination, even though we don't want it audible — mute via
    // gain instead of skipping the connection.
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    setIsWebActive(true);
  }, [emitChunk]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;

    if (enabled) {
      startWebCapture().then(() => {
        if (!cancelled) setError(null);
      }).catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Microphone error');
      });
    } else {
      stopWebCapture();
      energyEmaRef.current = 0;
      speakingRef.current = false;
      setIsSpeaking(false);
      setAudioLevel(0);
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    return () => { stopWebCapture(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Native start/stop, unchanged behavior ─────────────────────────────────
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;

    const manage = async () => {
      if (enabled) {
        try {
          if (!isRecording) {
            await startRecording({
              sampleRate: SAMPLE_RATE,
              channels: 1,
              encoding: 'pcm_16bit',
              interval: STREAM_INTERVAL_MS,
              // Streaming only — no local WAV file needed, the server persists
              // original/translated audio to Supabase per turn.
              output: { primary: { enabled: false } },
              ios: {
                audioSession: {
                  category: 'PlayAndRecord',
                  mode: 'VoiceChat',
                  categoryOptions: ['MixWithOthers', 'DefaultToSpeaker', 'AllowBluetooth'],
                },
              },
              android: { audioFocusStrategy: 'communication' },
              onAudioStream: handleNativeAudioStream,
            });
          }
          if (!cancelled) setError(null);
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Microphone error');
        }
      } else {
        if (isRecording) {
          try { await stopRecording(); } catch (_) {}
        }
        energyEmaRef.current = 0;
        speakingRef.current = false;
        setIsSpeaking(false);
        setAudioLevel(0);
      }
    };

    manage();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    return () => {
      if (isRecording) stopRecording().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isActive: Platform.OS === 'web' ? isWebActive : isRecording,
    isSpeaking,
    audioLevel,
    error,
  };
}
