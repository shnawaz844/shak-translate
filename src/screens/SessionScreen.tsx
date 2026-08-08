import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { Feather } from '@expo/vector-icons';
import Animated, {
  useSharedValue, useAnimatedStyle,
  withRepeat, withSequence, withTiming, Easing,
} from 'react-native-reanimated';

import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useWebSocket } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { Alert } from '../utils/alertCompat';

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

export function SessionScreen({
  sessionId,
  role,
  myLang,
  partnerLang,
  onEnd,
}: SessionScreenProps) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentSentText, setCurrentSentText] = useState<string | null>(null);
  const [currentReceivedText, setCurrentReceivedText] = useState<string | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [partnerSpeaking, setPartnerSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hasError, setHasError] = useState(false);

  const scrollRef = useRef<ScrollView>(null);

  // ── Audio Playback ──────────────────────────────────────────────────────────
  const audioQueueRef = useRef<{ base64: string; index: number; text: string }[]>([]);
  const isPlayingQueueRef = useRef(false);
  const currentSoundRef = useRef<AudioPlayer | null>(null); // native only
  const isBargedInRef = useRef(false); // true while partner is speaking (barge-in paused)

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
  const webPlaybackStateRef = useRef<{
    buffer: AudioBuffer;
    source: AudioBufferSourceNode | null; // null while paused
    startedAtCtxTime: number;
    offsetSec: number;
    resolve: () => void;
  } | null>(null);
  const webIntentionalStopRef = useRef(false);

  const getWebPlaybackContext = useCallback((): AudioContext => {
    if (!webPlaybackCtxRef.current) {
      const Ctor: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      webPlaybackCtxRef.current = new Ctor();
    }
    return webPlaybackCtxRef.current;
  }, []);

  const webPausePlayback = useCallback(() => {
    const state = webPlaybackStateRef.current;
    const ctx = webPlaybackCtxRef.current;
    if (!state || !state.source || !ctx) return;
    const elapsed = ctx.currentTime - state.startedAtCtxTime;
    webIntentionalStopRef.current = true;
    try { state.source.stop(); } catch (_) {}
    webPlaybackStateRef.current = { ...state, source: null, offsetSec: state.offsetSec + elapsed };
  }, []);

  const webResumePlayback = useCallback(() => {
    const state = webPlaybackStateRef.current;
    const ctx = webPlaybackCtxRef.current;
    if (!state || state.source || !ctx) return; // already playing, or nothing paused
    if (state.offsetSec >= state.buffer.duration) {
      webPlaybackStateRef.current = null;
      state.resolve();
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = state.buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (webIntentionalStopRef.current) { webIntentionalStopRef.current = false; return; }
      const cur = webPlaybackStateRef.current;
      if (cur?.source === source) {
        webPlaybackStateRef.current = null;
        cur.resolve();
      }
    };
    source.start(0, state.offsetSec);
    webPlaybackStateRef.current = { ...state, source, startedAtCtxTime: ctx.currentTime };
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

    while (audioQueueRef.current.length > 0) {
      // Wait while barged-in (user is speaking — sound is paused by handleBargeIn)
      while (isBargedInRef.current) {
        await new Promise(r => setTimeout(r, 80));
      }

      audioQueueRef.current.sort((a, b) => a.index - b.index);
      const chunk = audioQueueRef.current.shift();
      if (!chunk) continue;

      if (chunk.index === 0) {
        setCurrentReceivedText(chunk.text);
      } else {
        setCurrentReceivedText((prev) => (prev ? prev + ' ' + chunk.text : chunk.text));
      }

      if (!chunk.base64) continue;

      if (Platform.OS === 'web') {
        try {
          const ctx = getWebPlaybackContext();
          if (ctx.state === 'suspended') await ctx.resume();
          const audioBuffer = await ctx.decodeAudioData(base64ToArrayBuffer(chunk.base64));

          await new Promise<void>((resolve) => {
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.onended = () => {
              if (webIntentionalStopRef.current) { webIntentionalStopRef.current = false; return; }
              const cur = webPlaybackStateRef.current;
              if (cur?.source === source) {
                webPlaybackStateRef.current = null;
                resolve();
              }
            };
            webPlaybackStateRef.current = { buffer: audioBuffer, source, startedAtCtxTime: ctx.currentTime, offsetSec: 0, resolve };
            source.start(0);
          });
        } catch (e) {
          console.error('[SessionScreen] Web playback error:', e);
          webPlaybackStateRef.current = null;
        }
      } else {
        try {
          const player = createAudioPlayer({ uri: `data:audio/wav;base64,${chunk.base64}` });
          currentSoundRef.current = player;
          player.play();

          await new Promise<void>((resolve) => {
            const subscription = (player as any).addListener('playbackStatusUpdate', (s: any) => {
              if (s.didJustFinish) {
                subscription.remove();
                resolve();
              }
            });
          });

          player.remove();
          currentSoundRef.current = null;
        } catch (e) {
          console.error('[SessionScreen] Playback queue error:', e);
          currentSoundRef.current = null;
        }
      }
    }

    setIsPlayingAudio(false);
    isPlayingQueueRef.current = false;
  }, [getWebPlaybackContext]);

  const { status, isProcessing, sendAudioStreamChunk, sendPauseQueue, sendResumeQueue, endSession } = useWebSocket({
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

    onTranscript: useCallback((original: string, translated: string) => {
      if (!original.trim() && !translated.trim()) return;
      setCurrentSentText(`${original} → ${translated}`);
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

    // Server confirmed queue resumed — unpause local loop and resume sound
    onQueueResumed: useCallback(() => {
      isBargedInRef.current = false;
      if (Platform.OS === 'web') {
        webResumePlayback();
      } else if (currentSoundRef.current) {
        try { currentSoundRef.current.play(); } catch (_) {}
      }
    }, [webResumePlayback]),
  });

  const isBargeInDebounceRef = useRef(false);
  const partnerRole = role === 'host' ? 'guest' : 'host';

  // Called when VAD detects local speech during partner playback — pause, don't cancel
  const handleBargeIn = useCallback(async () => {
    if (isBargeInDebounceRef.current) return;
    isBargeInDebounceRef.current = true;
    setTimeout(() => { isBargeInDebounceRef.current = false; }, 300);

    if (!isPlayingAudio && !partnerSpeaking) return;

    isBargedInRef.current = true;

    // Pause the currently playing sound at its exact position
    if (Platform.OS === 'web') {
      webPausePlayback();
    } else if (currentSoundRef.current) {
      try { currentSoundRef.current.pause(); } catch (_) {}
    }

    // Tell server to pause the partner's drain loop (keeps queue intact)
    sendPauseQueue(partnerRole, sessionId);
  }, [isPlayingAudio, partnerSpeaking, partnerRole, sessionId, sendPauseQueue, webPausePlayback]);

  // Called when local speech silence is detected after a barge-in — resume partner
  const handleBargeInRelease = useCallback(() => {
    if (!isBargedInRef.current) return;
    // Tell server to resume draining — it will send queue_resumed when ready
    sendResumeQueue(partnerRole, sessionId);
    // Note: isBargedInRef.current is cleared in onQueueResumed callback
  }, [partnerRole, sessionId, sendResumeQueue]);

  // Continuous streaming: no more per-sentence stop/start. The mic stays live
  // for the whole call on both platforms — real full duplex now relies on the
  // platform's own echo cancellation rather than disabling recording during
  // playback — and every captured buffer is forwarded immediately.
  const canRecord = status === 'connected' && !isPaused && !hasError;

  const handleChunk = useCallback((audioBase64: string, mimeType: string) => {
    sendAudioStreamChunk(audioBase64, mimeType, role, sessionId);
  }, [sendAudioStreamChunk, role, sessionId]);

  const { isActive: isRecording, isSpeaking, audioLevel, error: micError } = useAudioRecorder({
    enabled: canRecord,
    onChunk: handleChunk,
  });

  useEffect(() => {
    if (micError) setHasError(true);
  }, [micError]);

  // Drive barge-in off isSpeaking transitions instead of VAD event callbacks —
  // turn-boundary detection now lives server-side in Gemini's own
  // automaticActivityDetection, this local signal is UI-only.
  const wasSpeakingRef = useRef(false);
  useEffect(() => {
    if (isSpeaking && !wasSpeakingRef.current) {
      if (isPlayingAudio || partnerSpeaking) handleBargeIn();
    } else if (!isSpeaking && wasSpeakingRef.current) {
      handleBargeInRelease();
    }
    wasSpeakingRef.current = isSpeaking;
  }, [isSpeaking, isPlayingAudio, partnerSpeaking, handleBargeIn, handleBargeInRelease]);


  // ── Pulse animation ─────────────────────────────────────────────────────────
  const pulseAnim = useSharedValue(1);
  useEffect(() => {
    if (isSpeaking) {
      pulseAnim.value = withRepeat(
        withSequence(
          withTiming(1.6, { duration: 600, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 600, easing: Easing.in(Easing.ease) })
        ),
        -1, false
      );
    } else {
      pulseAnim.value = withTiming(1, { duration: 300 });
    }
  }, [isSpeaking, pulseAnim]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseAnim.value }],
    opacity: isSpeaking ? 1 - (pulseAnim.value - 1) * 1.2 : 0,
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

  const barHeights = useMemo(() =>
    [...Array(6)].map((_, i) => {
      const phase = (i / 6) * Math.PI * 2;
      return 12 + Math.abs(Math.sin(phase + audioLevel * 10)) * audioLevel * 64;
    }),
    [audioLevel]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topGlow} />

      {/* Header */}
      <View style={styles.header}>
        <StatusBadge status={status} role={role} />
        <View style={styles.langPair}>
          <Text style={styles.langText}>{myLang}</Text>
          <Feather name="arrow-right" size={12} color="rgba(255,255,255,0.3)" />
          <Text style={styles.langText}>{partnerLang}</Text>
        </View>
        <TouchableOpacity onPress={handleEnd} style={styles.endBtn}>
          <Feather name="phone-off" size={16} color="#ef4444" />
        </TouchableOpacity>
      </View>

      {/* Main content */}
      <View style={styles.mainContent}>

        {/* Live status panel */}
        {isRecording && !partnerSpeaking && (
          <View style={styles.livePanel}>
            <View style={styles.barsRow}>
              {barHeights.map((h, i) => (
                <View
                  key={i}
                  style={[styles.audioBar, { height: h }, isSpeaking && styles.audioBarSpeaking]}
                />
              ))}
            </View>
            <Text style={[styles.listeningLabel, isSpeaking && { color: '#fff' }]}>
              {isSpeaking ? 'SPEECH DETECTED...' : 'LISTENING...'}
            </Text>
          </View>
        )}

        {partnerSpeaking && (
          <View style={[styles.livePanel, { borderColor: 'rgba(255,165,0,0.3)', backgroundColor: 'rgba(255,165,0,0.05)' }]}>
            <Feather name="user" size={24} color="orange" style={{ marginBottom: 8 }} />
            <Text style={[styles.listeningLabel, { color: 'orange' }]}>PARTNER IS SPEAKING...</Text>
          </View>
        )}

        {isProcessing && (
          <View style={styles.processingPanel}>
            <ActivityIndicator size="small" color="#39FF14" />
            <Text style={styles.processingLabel}>TRANSLATING...</Text>
          </View>
        )}

        {isPlayingAudio && (
          <View style={{ alignItems: 'center', marginBottom: 16 }}>
            <View style={[styles.processingPanel, { marginBottom: 4 }]}>
              <Feather name="volume-2" size={16} color="#39FF14" />
              <Text style={styles.processingLabel}>PLAYING...</Text>
            </View>
            <TouchableOpacity onPress={handleBargeIn} style={styles.interruptBtn}>
              <Feather name="mic" size={12} color="rgba(57,255,20,0.6)" />
              <Text style={styles.interruptText}>TAP OR SPEAK TO INTERRUPT</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Current translation preview */}
        {currentSentText && !isRecording && !isProcessing && (
          <View style={styles.previewCard}>
            <Text style={styles.previewLabel}>YOU SAID</Text>
            <Text style={styles.previewText}>{currentSentText}</Text>
          </View>
        )}

        {currentReceivedText && !isProcessing && (
          <View style={[styles.previewCard, styles.previewCardReceived]}>
            <Text style={[styles.previewLabel, { color: '#39FF14' }]}>PARTNER SAID</Text>
            <Text style={styles.previewText}>{currentReceivedText}</Text>
          </View>
        )}

        {/* Empty state */}
        {!isRecording && !isProcessing && !currentSentText && !currentReceivedText && !isPlayingAudio && !partnerSpeaking && !hasError && (
          <View style={styles.emptyState}>
            <Feather name={isPaused ? "mic-off" : "mic"} size={40} color="rgba(255,255,255,0.1)" />
            <Text style={styles.emptyTitle}>
              {status === 'connected'
                ? (isPaused ? 'Listening Paused' : 'Ready to speak')
                : 'Waiting for connection...'}
            </Text>
            <Text style={styles.emptySub}>
              {status === 'connected'
                ? (isPaused ? 'Tap to resume hands-free mode' : 'Hands-free mode active. Just speak!')
                : 'Make sure the other device has scanned the QR code.'}
            </Text>
          </View>
        )}

        {hasError && (
          <View style={styles.emptyState}>
            <Feather name="alert-circle" size={40} color="#ef4444" />
            <Text style={styles.emptyTitle}>Microphone Error</Text>
            <Text style={styles.emptySub}>Please tap the button below to retry.</Text>
          </View>
        )}

        {/* Transcript */}
        {transcript.length > 0 && (
          <View style={styles.transcriptSection}>
            <View style={styles.transcriptHeader}>
              <Feather name="message-square" size={12} color="rgba(255,255,255,0.3)" />
              <Text style={styles.transcriptHeaderText}> CONVERSATION HISTORY</Text>
              <TouchableOpacity onPress={() => setTranscript([])}>
                <Text style={styles.clearText}>Clear</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              ref={scrollRef}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 16 }}
            >
              {transcript.map((item) => (
                <View
                  key={item.id}
                  style={[
                    styles.transcriptBubble,
                    item.direction === 'sent' ? styles.bubbleSent : styles.bubbleReceived,
                  ]}
                >
                  <Text style={styles.bubbleOriginal}>{item.original}</Text>
                  <Text style={styles.bubbleTranslated}>{item.translated}</Text>
                  <Text style={styles.bubbleTime}>
                    {new Date(item.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        )}
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <View style={styles.micWrapper}>
          {isSpeaking && <Animated.View style={[styles.micPulseRing, pulseStyle]} />}
          <TouchableOpacity
            style={[
              styles.micBtn,
              isPaused && styles.micBtnPaused,
              (!isPaused && status !== 'connected' && !hasError) && styles.micBtnDisabled,
              hasError && styles.micBtnError,
            ]}
            onPress={() => {
              if (hasError) setHasError(false);
              else setIsPaused(!isPaused);
            }}
            disabled={status !== 'connected'}
            activeOpacity={0.8}
          >
            <Feather
              name={hasError ? 'refresh-cw' : isPaused ? 'mic-off' : 'mic'}
              size={32}
              color={isPaused || hasError ? '#fff' : status !== 'connected' ? 'rgba(0,0,0,0.4)' : '#000'}
            />
          </TouchableOpacity>
        </View>
        <Text style={styles.micHint}>
          {hasError ? 'Tap to Retry Microphone' : isPaused ? 'Tap to Resume Listening' : status === 'connected' ? 'Tap to Pause Listening' : 'Please wait...'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  topGlow: {
    position: 'absolute', top: -80, right: -80,
    width: 240, height: 240, borderRadius: 120,
    backgroundColor: '#39FF14', opacity: 0.04,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? 40 : 16, paddingBottom: 16,
    borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  langPair: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  langText: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '600' },
  endBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)',
    justifyContent: 'center', alignItems: 'center',
  },
  mainContent: { flex: 1, paddingHorizontal: 20, paddingTop: 20 },
  livePanel: {
    alignItems: 'center', paddingVertical: 24,
    backgroundColor: 'rgba(57,255,20,0.04)',
    borderRadius: 16, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(57,255,20,0.1)',
  },
  barsRow: {
    flexDirection: 'row', alignItems: 'center', height: 64, marginBottom: 12,
  },
  audioBar: {
    width: 5, backgroundColor: 'rgba(57,255,20,0.4)', borderRadius: 3, marginHorizontal: 3,
  },
  audioBarSpeaking: {
    backgroundColor: '#39FF14',
  },
  listeningLabel: {
    color: 'rgba(57,255,20,0.5)', fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 3,
  },
  processingPanel: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 16, marginBottom: 16,
  },
  processingLabel: {
    color: 'rgba(255,255,255,0.5)', fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 3,
  },
  previewCard: {
    backgroundColor: '#1A1A1A', borderRadius: 16, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  previewCardReceived: { borderColor: 'rgba(57,255,20,0.2)' },
  previewLabel: {
    color: 'rgba(255,255,255,0.3)', fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 1.5, marginBottom: 6,
  },
  previewText: { color: '#fff', fontSize: 15, fontWeight: '500', lineHeight: 22 },
  emptyState: {
    flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40, gap: 12,
  },
  emptyTitle: {
    color: 'rgba(255,255,255,0.35)', fontSize: 16, fontWeight: '500',
  },
  emptySub: {
    color: 'rgba(255,255,255,0.2)', fontSize: 13, textAlign: 'center', lineHeight: 18,
  },
  transcriptSection: { flex: 1 },
  transcriptHeader: {
    flexDirection: 'row', alignItems: 'center',
    marginBottom: 12,
  },
  transcriptHeaderText: {
    color: 'rgba(255,255,255,0.3)', fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 1.5, flex: 1,
  },
  clearText: { color: 'rgba(255,255,255,0.2)', fontSize: 11 },
  transcriptBubble: {
    borderRadius: 14, padding: 12, marginBottom: 8,
    borderWidth: 1,
  },
  bubbleSent: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(255,255,255,0.06)',
    marginLeft: 24,
  },
  bubbleReceived: {
    backgroundColor: 'rgba(57,255,20,0.04)',
    borderColor: 'rgba(57,255,20,0.1)',
    marginRight: 24,
  },
  bubbleOriginal: {
    color: 'rgba(255,255,255,0.45)', fontSize: 12, fontStyle: 'italic', marginBottom: 4,
  },
  bubbleTranslated: { color: '#fff', fontSize: 14, fontWeight: '500' },
  bubbleTime: {
    color: 'rgba(255,255,255,0.2)', fontSize: 10, marginTop: 6,
  },
  controls: {
    alignItems: 'center',
    paddingTop: 20, paddingBottom: Platform.OS === 'ios' ? 24 : 40,
    borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  micWrapper: {
    position: 'relative', justifyContent: 'center', alignItems: 'center', marginBottom: 12,
  },
  micPulseRing: {
    position: 'absolute', width: 90, height: 90, borderRadius: 45,
    backgroundColor: '#39FF14',
  },
  micBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4, shadowRadius: 12, elevation: 6,
  },
  micBtnPaused: { backgroundColor: '#ef4444', shadowColor: '#ef4444' },
  micBtnError: { backgroundColor: '#f97316', shadowColor: '#f97316' },
  micBtnDisabled: { backgroundColor: 'rgba(57,255,20,0.25)', shadowOpacity: 0 },
  micHint: {
    color: 'rgba(255,255,255,0.25)', fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 0.5,
  },
  queueBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 6, paddingHorizontal: 12,
    backgroundColor: 'rgba(255,200,0,0.06)',
    borderRadius: 20, borderWidth: 1,
    borderColor: 'rgba(255,200,0,0.18)',
    marginBottom: 10, alignSelf: 'center',
  },
  queueText: {
    color: 'rgba(255,200,0,0.7)', fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 1.5,
  },
  interruptBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 8, paddingHorizontal: 14,
    borderRadius: 20, borderWidth: 1,
    borderColor: 'rgba(57,255,20,0.2)',
    alignSelf: 'center', marginTop: 4,
  },
  interruptText: {
    color: 'rgba(57,255,20,0.5)', fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 2,
  },
});
