import { useEffect, useRef, useState, useCallback } from 'react';
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
// Note: expo-audio's own recorder is file-based only (no raw streaming
// callback), so capture goes through @siteed/audio-studio, which is built
// specifically for this. Playback of translated replies still goes through
// expo-audio's AudioPlayer (see SessionScreen.tsx) — that part of expo-audio
// is real and verified against the installed package.
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
 * Web delivers raw Float32 PCM samples (-1..1) instead of a base64 string —
 * convert to the same 16-bit PCM base64 wire format native platforms send.
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

  const energyEmaRef = useRef(0);
  const speakingRef = useRef(false);
  const onChunkRef = useRef(onChunk);

  useEffect(() => { onChunkRef.current = onChunk; }, [onChunk]);

  const { startRecording, stopRecording, isRecording } = useAudioStudioRecorder();

  const handleAudioStream = useCallback(async (event: AudioDataEvent) => {
    // Native delivers a base64 PCM string directly; web delivers a raw
    // Float32Array of samples that needs converting to the same wire format.
    const base64Data = typeof event.data === 'string'
      ? event.data
      : float32ToBase64PCM16(event.data as unknown as Float32Array);

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

  useEffect(() => {
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
              onAudioStream: handleAudioStream,
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
    return () => {
      if (isRecording) stopRecording().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isActive: isRecording,
    isSpeaking,
    audioLevel,
    error,
  };
}
