import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Platform, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { Feather } from '@expo/vector-icons';
import Animated, {
  useSharedValue, useAnimatedStyle,
  withRepeat, withSequence, withTiming, Easing,
} from 'react-native-reanimated';

import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useWebSocket } from '../hooks/useWebSocket';
import { Alert } from '../utils/alertCompat';
import { colors, DESKTOP_BREAKPOINT } from '../theme';

const KEEP_AWAKE_TAG = 'shaktranslate-call';

interface SessionScreenProps {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
  onEnd: () => void;
}

interface TranscriptEntry {
  id: string;
  direction: 'sent' | 'received';
  original: string;
  translated: string;
  timestamp: number;
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function SessionScreen({
  sessionId,
  role,
  myLang,
  partnerLang,
  onEnd,
}: SessionScreenProps) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [partnerSpeaking, setPartnerSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);

  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;

  const scrollRef = useRef<ScrollView>(null);

  // Configure native audio mode for call: loudspeaker output, mixing, and background playback
  useEffect(() => {
    if (Platform.OS !== 'web') {
      setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'duckOthers',
        shouldRouteThroughEarpiece: false,
      }).catch((e) => console.warn('[SessionScreen] setAudioModeAsync error:', e));
    }
  }, []);

  const toggleSpeaker = async () => {
    const next = !isSpeakerOn;
    setIsSpeakerOn(next);
    if (Platform.OS !== 'web') {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'duckOthers',
        shouldRouteThroughEarpiece: !next,
      }).catch((e) => console.warn('[SessionScreen] toggleSpeaker error:', e));
    }
  };

  // ── Audio Playback ──────────────────────────────────────────────────────────
  const audioQueueRef = useRef<{ base64: string; index: number; text: string }[]>([]);
  const isPlayingQueueRef = useRef(false);
  const currentSoundRef = useRef<AudioPlayer | null>(null); // native only

  // Audio mode (mic + speaker routing) is configured once by useAudioRecorder
  // itself when streaming starts — see src/hooks/useAudioRecorder.ts. Keeping
  // it in one place avoids two audio modules fighting over session config on
  // a screen where capture and playback run concurrently.

  // ── Web-only playback: Web Audio API buffer source, not expo-audio's
  // <audio>-element-backed AudioPlayer. iOS Safari has a long-standing bug
  // where an active getUserMedia mic stream silences ALL HTMLMediaElement
  // ("<audio>"/"<video>") playback on the page. Our mic stays live for the
  // whole call (see useAudioRecorder.ts), so on iPhone that bug silenced
  // every translated reply for the entire call — the sender could be heard
  // fine (their audio leaves via the mic, unaffected), but the listener
  // never heard anything back even though the transcript kept updating.
  // Web Audio buffer playback doesn't touch the <audio> element code path
  // at all, which avoids the conflict.
  const webPlaybackCtxRef = useRef<AudioContext | null>(null);
  const webPlaybackStateRef = useRef<{ source: AudioBufferSourceNode } | null>(null);
  // AudioContext-clock cursor for gapless playback: each chunk is scheduled
  // to start exactly when the previous one ends, rather than waiting for the
  // previous chunk to actually finish playing before even starting to decode
  // the next one. That old sequential await-then-decode pattern inserted a
  // real, audible silence between every chunk of the same sentence — decode
  // time isn't free, so there was always a small gap where nothing played
  // even though the next chunk had already arrived. A real call never does
  // that. Chunks are now pipelined: decode happens as soon as a chunk is
  // dequeued, and playback is scheduled on the AudioContext's own clock, so
  // consecutive chunks butt up against each other with zero gap regardless
  // of how long decoding takes.
  const nextStartTimeRef = useRef(0);
  const pendingSourcesRef = useRef(0);
  // Shared compressor so loudness is consistent across chunks/turns instead
  // of each independently-generated chunk playing at its own volume — the
  // same kind of leveling a real phone call's audio path applies.
  const webCompressorRef = useRef<DynamicsCompressorNode | null>(null);

  const getWebPlaybackContext = useCallback((): AudioContext => {
    if (!webPlaybackCtxRef.current) {
      const Ctor: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctor();
      webPlaybackCtxRef.current = ctx;
      const compressor = ctx.createDynamicsCompressor();
      compressor.connect(ctx.destination);
      webCompressorRef.current = compressor;
    }
    return webPlaybackCtxRef.current;
  }, []);

  function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  const processAudioQueue = useCallback(async () => {
    if (isPlayingQueueRef.current || audioQueueRef.current.length === 0) return;

    isPlayingQueueRef.current = true;
    setIsPlayingAudio(true);

    if (Platform.OS === 'web') {
      const ctx = getWebPlaybackContext();
      if (ctx.state === 'suspended') await ctx.resume();
      // If playback has fully drained since the last chunk (cursor is in the
      // past), restart the schedule from "now" instead of from a stale time.
      if (nextStartTimeRef.current < ctx.currentTime) nextStartTimeRef.current = ctx.currentTime;
    }

    while (audioQueueRef.current.length > 0) {
      audioQueueRef.current.sort((a, b) => a.index - b.index);
      const chunk = audioQueueRef.current.shift();
      if (!chunk) continue;

      if (!chunk.base64) continue;

      if (Platform.OS === 'web') {
        try {
          const ctx = getWebPlaybackContext();
          const audioBuffer = await ctx.decodeAudioData(base64ToArrayBuffer(chunk.base64));

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          // A brief gain ramp at each chunk's edges avoids an audible click
          // where one independently-generated chunk's waveform doesn't quite
          // meet the next one at zero amplitude.
          const fadeGain = ctx.createGain();
          const FADE_S = 0.004;
          const startAt = Math.max(nextStartTimeRef.current, ctx.currentTime);
          const endAt = startAt + audioBuffer.duration;
          fadeGain.gain.setValueAtTime(0, startAt);
          fadeGain.gain.linearRampToValueAtTime(1, startAt + FADE_S);
          fadeGain.gain.setValueAtTime(1, Math.max(startAt + FADE_S, endAt - FADE_S));
          fadeGain.gain.linearRampToValueAtTime(0, endAt);
          source.connect(fadeGain);
          fadeGain.connect(webCompressorRef.current ?? ctx.destination);

          pendingSourcesRef.current += 1;
          source.onended = () => {
            pendingSourcesRef.current = Math.max(0, pendingSourcesRef.current - 1);
            if (webPlaybackStateRef.current?.source === source) webPlaybackStateRef.current = null;
            if (pendingSourcesRef.current === 0) setIsPlayingAudio(false);
          };
          webPlaybackStateRef.current = { source };
          source.start(startAt);
          nextStartTimeRef.current = endAt;
        } catch (e) {
          console.error('[SessionScreen] Web playback error:', e);
        }
      } else {
        // expo-audio on Android cannot play data: URIs — write the base64
        // audio to a temp file in the cache directory and play from its path.
        let tempPath: string | null = null;
        try {
          tempPath = `${FileSystem.cacheDirectory}audio_chunk_${Date.now()}_${chunk.index}.wav`;
          await FileSystem.writeAsStringAsync(tempPath, chunk.base64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          const player = createAudioPlayer({ uri: tempPath });
          currentSoundRef.current = player;

          await new Promise<void>((resolve) => {
            let timer: any = null;
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              if (timer) clearTimeout(timer);
              try { subscription.remove(); } catch (_) {}
              resolve();
            };
            const subscription = (player as any).addListener('playbackStatusUpdate', (s: any) => {
              if (s?.didJustFinish || s?.isLoaded === false) {
                finish();
              }
            });
            timer = setTimeout(finish, 8000);
            try {
              player.play();
            } catch (err) {
              console.warn('[SessionScreen] player.play error:', err);
              finish();
            }
          });

          try { player.remove(); } catch (_) {}
          currentSoundRef.current = null;
        } catch (e) {
          console.error('[SessionScreen] Playback queue error:', e);
          currentSoundRef.current = null;
        } finally {
          // Clean up temp file
          if (tempPath) {
            FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
          }
        }
      }
    }

    // On web, chunks are scheduled ahead on the AudioContext clock rather
    // than awaited to completion above, so playback continues after this
    // loop exits — isPlayingAudio is cleared from the last source's onended
    // instead (see pendingSourcesRef). Native's expo-audio path still awaits
    // each chunk to actual completion, so clearing it here is correct there.
    if (Platform.OS !== 'web') setIsPlayingAudio(false);
    isPlayingQueueRef.current = false;
  }, [getWebPlaybackContext]);

  const { status, isProcessing, sendAudioStreamChunk, endSession } = useWebSocket({
    onTranslatedAudioChunk: useCallback((payload: any) => {
      setPartnerSpeaking(false);
      if (!payload.audioBase64 && !payload.text?.trim()) return;
      audioQueueRef.current.push({ base64: payload.audioBase64, index: payload.index, text: payload.text });
      processAudioQueue();
    }, [processAudioQueue]),

    onTranslatedAudioFinal: useCallback((original: string, translated: string) => {
      setPartnerSpeaking(false);
      if (translated.trim().length < 2) return;
      setTranscript(prev => {
        if (prev.length > 0 && prev[0].translated === translated) return prev;
        return [{ id: `recv-${Date.now()}`, direction: 'received', original, translated, timestamp: Date.now() }, ...prev];
      });
    }, []),

    onPartnerDisconnected: useCallback(() => {
      setPartnerSpeaking(false);
      Alert.alert('Partner Disconnected', 'Your partner has left the session.', [{ text: 'OK', onPress: onEnd }]);
    }, [onEnd]),

    onError: useCallback((msg: string) => {
      setPartnerSpeaking(false);
      Alert.alert('Error', msg);
    }, []),

    onPartnerSpeaking: useCallback(() => { setPartnerSpeaking(true); }, []),
    onLockReleased: useCallback(() => { setPartnerSpeaking(false); }, []),
    onTurnRejected: useCallback(() => {}, []),
  });

  // Continuous streaming: no more per-sentence stop/start. The mic stays live
  // for the whole call on both platforms — real full duplex now relies on the
  // platform's own echo cancellation rather than disabling recording during
  // playback — and every captured buffer is forwarded immediately.
  const canRecord = status === 'connected' && !isPaused && !hasError;

  const handleChunk = useCallback((audioBase64: string, mimeType: string) => {
    sendAudioStreamChunk(audioBase64, mimeType, role, sessionId);
  }, [sendAudioStreamChunk, role, sessionId]);

  const { error: micError } = useAudioRecorder({
    enabled: canRecord,
    onChunk: handleChunk,
  });

  useEffect(() => {
    if (micError) {
      setHasError(true);
      Alert.alert('Microphone Error', micError, [
        { text: 'Retry', onPress: () => setHasError(false) },
        { text: 'OK' },
      ]);
    }
  }, [micError]);

  // NOTE: this used to auto-pause partner playback the instant the local
  // energy-based VAD saw any sound while listening (barge-in). That meant
  // recording and playback could never truly run in parallel like a real
  // call: any ambient noise (a TV, loud background sound) or the speaker
  // just resuming their next sentence would stop playback and wait, instead
  // of letting both directions run independently and simultaneously, which
  // is what they're actually designed to do — each direction is already its
  // own independent Gemini session (see geminiService.js). Removed entirely;
  // recording and playback no longer affect each other at all.

  // Keep the screen awake for the whole call — this is a hands-free calling
  // screen, and the mic's own speech detection stops working the moment the
  // OS suspends the tab/screen on an idle timeout. expo-keep-awake covers
  // native (iOS/Android) as well as web, unlike the old hand-rolled
  // navigator.wakeLock call which was a no-op on native — that's why the
  // screen kept turning off there even after the web fix. Web's underlying
  // Wake Lock API still auto-releases when the tab is hidden (e.g. the user
  // briefly switches apps) and never re-acquires itself, so keep the
  // visibility-based reacquire for that platform.
  useEffect(() => {
    if (status !== 'connected') return;

    const acquire = () => {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch((e) => {
        console.warn('[SessionScreen] Keep awake request failed:', e);
      });
    };
    acquire();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', handleVisibility);
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [status]);

  // Call duration timer — starts counting the moment the call connects and
  // runs continuously regardless of who's talking or playing back, same as
  // any real phone call's timer.
  const callStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (status !== 'connected') return;
    if (callStartRef.current === null) callStartRef.current = Date.now();
    const interval = setInterval(() => {
      setDurationSec(Math.floor((Date.now() - (callStartRef.current as number)) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  // ── Ambient breathing animation ──────────────────────────────────────────
  // Runs continuously at a constant, gentle pace — it never reacts to who is
  // speaking or whether translation is playing back. The call screen must
  // look and feel identical throughout the call regardless of turn-taking;
  // this is the one piece of motion on the screen, present purely to signal
  // "this call is live," not as a status indicator.
  const breathe = useSharedValue(0);
  useEffect(() => {
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2250, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 2250, easing: Easing.inOut(Easing.ease) })
      ),
      -1, false
    );
  }, [breathe]);

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breathe.value * 0.035 }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.94 + breathe.value * 0.12 }],
    opacity: 0.35 + breathe.value * 0.35,
  }));

  // ── End Session ─────────────────────────────────────────────────────────────
  const handleEnd = () => {
    Alert.alert('End Session', 'Are you sure you want to end this conversation?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End',
        style: 'destructive',
        onPress: () => {
          endSession(role, sessionId);
          onEnd();
        },
      },
    ]);
  };

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [transcript]);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (currentSoundRef.current) {
        try { currentSoundRef.current.remove(); } catch (_) {}
      }
      if (webPlaybackStateRef.current?.source) {
        try { webPlaybackStateRef.current.source.stop(); } catch (_) {}
      }
      if (webPlaybackCtxRef.current) {
        webPlaybackCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const partnerInitial = (partnerLang || '?').trim().charAt(0).toUpperCase();
  const isConnected = status === 'connected';
  const statusLabel = hasError ? 'Microphone error' : isConnected ? 'In call' : 'Connecting…';

  // isProcessing / isPlayingAudio / partnerSpeaking are intentionally not
  // wired into the stage UI below — the call screen stays one continuous
  // state no matter who's talking. They still drive the transcript and the
  // audio pipeline above.
  void isProcessing; void isPlayingAudio; void partnerSpeaking;

  const transcriptPanel = (
    <View style={[styles.panelInner, !isDesktop && { flex: 1 }]}>
      <View style={styles.panelHead}>
        <Text style={styles.panelTitle}>Conversation</Text>
        {!isDesktop && (
          <TouchableOpacity onPress={() => setShowTranscript(false)} style={styles.sheetClose}>
            <Feather name="x" size={15} color={colors.muted} />
          </TouchableOpacity>
        )}
      </View>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.logContent}
        showsVerticalScrollIndicator={false}
      >
        {transcript.length === 0 ? (
          <Text style={styles.logEmpty}>Nothing said yet.</Text>
        ) : (
          [...transcript].reverse().map((item) => (
            <View
              key={item.id}
              style={[
                styles.bubble,
                item.direction === 'sent' ? styles.bubbleYou : styles.bubbleThem,
              ]}
            >
              <Text style={styles.bubbleOriginal}>{item.original}</Text>
              <Text style={styles.bubbleTranslated}>{item.translated}</Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topGlow} />

      <View style={[styles.body, isDesktop && styles.bodyDesktop]}>
        <View style={styles.stageColumn}>
          {hasError ? (
            <View style={styles.errorState}>
              <Feather name="alert-circle" size={40} color={colors.danger} />
              <Text style={styles.errorTitle}>Microphone error</Text>
              <Text style={styles.errorSub}>Tap the mic button below to retry.</Text>
            </View>
          ) : (
            <>
              <View style={styles.topbar}>
                <View style={styles.langPill}>
                  <Text style={styles.langPillText}>{myLang}</Text>
                  <Feather name="arrow-right" size={12} color={colors.muted} />
                  <Text style={styles.langPillText}>{partnerLang}</Text>
                </View>
                <Text style={styles.timer}>{formatDuration(durationSec)}</Text>
              </View>

              <View style={styles.stageMid}>
                <View style={styles.orbWrap}>
                  <Animated.View style={[styles.ring, ringStyle, !isConnected && styles.ringIdle]} />
                  <Animated.View style={[styles.orb, orbStyle, !isConnected && styles.orbIdle]}>
                    <Text style={styles.orbLetter}>{partnerInitial}</Text>
                  </Animated.View>
                </View>
                <Text style={styles.statusSub}>{statusLabel}</Text>
              </View>
            </>
          )}

          <View style={styles.controls}>
            {/* Mic / Mute */}
            <TouchableOpacity
              style={[
                styles.ctrl,
                isPaused && !hasError && styles.ctrlMuteActive,
                hasError && styles.ctrlError,
              ]}
              onPress={() => {
                if (hasError) setHasError(false);
                else setIsPaused(!isPaused);
              }}
              activeOpacity={0.8}
            >
              <Feather
                name={hasError ? 'refresh-cw' : isPaused ? 'mic-off' : 'mic'}
                size={22}
                color={isPaused && !hasError ? colors.ink : colors.warm}
              />
            </TouchableOpacity>

            {/* Speaker / Earpiece toggle (native only) */}
            {Platform.OS !== 'web' && (
              <TouchableOpacity
                style={[styles.ctrl, isSpeakerOn && styles.ctrlSpeakerActive]}
                onPress={toggleSpeaker}
                activeOpacity={0.8}
              >
                <Feather
                  name={isSpeakerOn ? 'volume-2' : 'volume-1'}
                  size={22}
                  color={isSpeakerOn ? colors.signal : colors.warm}
                />
              </TouchableOpacity>
            )}

            {/* End Call */}
            <TouchableOpacity style={[styles.ctrl, styles.ctrlEnd]} onPress={handleEnd} activeOpacity={0.85}>
              <Feather name="phone-off" size={24} color={colors.ink} />
            </TouchableOpacity>

            {!isDesktop && (
              <TouchableOpacity
                style={[styles.ctrl, showTranscript && styles.ctrlTranscriptActive]}
                onPress={() => setShowTranscript(true)}
                activeOpacity={0.8}
              >
                <Feather name="message-square" size={20} color={showTranscript ? colors.signal : colors.warm} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {isDesktop && <View style={styles.desktopPanel}>{transcriptPanel}</View>}
      </View>

      {!isDesktop && (
        <View
          pointerEvents={showTranscript ? 'auto' : 'none'}
          style={[styles.sheet, showTranscript && styles.sheetOpen]}
        >
          {transcriptPanel}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  topGlow: {
    position: 'absolute', top: -80, right: -80,
    width: 240, height: 240, borderRadius: 120,
    backgroundColor: colors.signal, opacity: 0.06,
  },
  body: { flex: 1, flexDirection: 'column' },
  bodyDesktop: { flexDirection: 'row' },
  stageColumn: { flex: 1, flexDirection: 'column' },

  topbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24, paddingTop: 12,
  },
  langPill: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  langPillText: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  timer: {
    color: colors.muted, fontSize: 12.5,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontVariant: ['tabular-nums'],
  },

  stageMid: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 28 },
  orbWrap: { width: 148, height: 148, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute', width: 148, height: 148, borderRadius: 74,
    borderWidth: 1, borderColor: colors.signalDim,
  },
  ringIdle: { borderColor: colors.hair },
  orb: {
    width: 104, height: 104, borderRadius: 52,
    backgroundColor: colors.signal,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.signal, shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4, shadowRadius: 20, elevation: 8,
  },
  orbIdle: { backgroundColor: colors.surface3, shadowOpacity: 0 },
  orbLetter: { fontSize: 30, fontWeight: '600', color: colors.signalOnDark },
  statusSub: { fontSize: 15, fontWeight: '600', color: colors.warm, textAlign: 'center' },

  errorState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  errorTitle: { fontSize: 17, fontWeight: '600', color: colors.warm },
  errorSub: { fontSize: 13, color: colors.muted, textAlign: 'center' },

  controls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20,
    paddingTop: 20, paddingBottom: Platform.OS === 'ios' ? 24 : 32,
  },
  ctrl: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.hair,
  },
  ctrlMuteActive: { backgroundColor: colors.warm, borderColor: colors.warm },
  ctrlError: { backgroundColor: colors.danger, borderColor: colors.danger },
  ctrlSpeakerActive: { backgroundColor: colors.surface3, borderColor: colors.signalDim },
  ctrlTranscriptActive: { backgroundColor: colors.surface3, borderColor: colors.signalDim },
  ctrlEnd: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: colors.danger, borderColor: colors.danger,
  },

  // ── Mobile transcript sheet ──────────────────────────────────────────────
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, top: '38%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderWidth: 1, borderColor: colors.hair,
    opacity: 0, transform: [{ translateY: 24 }],
  },
  sheetOpen: { opacity: 1, transform: [{ translateY: 0 }] },

  // ── Desktop persistent panel ─────────────────────────────────────────────
  desktopPanel: {
    width: 300, borderLeftWidth: 1, borderColor: colors.hair,
    backgroundColor: 'rgba(0,0,0,0.12)',
  },

  panelInner: { flex: 1 },
  panelHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12,
    borderBottomWidth: 1, borderColor: colors.hair,
  },
  panelTitle: { fontSize: 13, fontWeight: '600', color: colors.warm },
  sheetClose: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.surface2,
    alignItems: 'center', justifyContent: 'center',
  },
  logContent: { padding: 16, gap: 10 },
  logEmpty: { color: colors.muted, fontSize: 13, textAlign: 'center', marginTop: 24 },
  bubble: {
    borderRadius: 14, padding: 10, marginBottom: 10, maxWidth: '86%',
    borderWidth: 1, borderColor: colors.hair,
  },
  bubbleThem: { backgroundColor: colors.surface2, alignSelf: 'flex-start' },
  bubbleYou: { backgroundColor: 'rgba(47,224,168,0.08)', borderColor: 'rgba(47,224,168,0.18)', alignSelf: 'flex-end' },
  bubbleOriginal: { color: colors.muted, fontSize: 11.5, fontStyle: 'italic', marginBottom: 3 },
  bubbleTranslated: { color: colors.warm, fontSize: 13.5, lineHeight: 18 },
});
