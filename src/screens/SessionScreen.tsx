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

interface ActiveSubtitle {
  speaker: 'self' | 'partner';
  originalText: string;
  translatedText: string;
  isFinal: boolean;
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
  const [activeSubtitle, setActiveSubtitle] = useState<ActiveSubtitle | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [partnerSpeaking, setPartnerSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(isPaused);
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);
  const [hasError, setHasError] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);

  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;

  const scrollRef = useRef<ScrollView>(null);

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
  const nativeAudioQueueRef = useRef<string[]>([]);
  const isPlayingNativeRef = useRef(false);

  // Echo cancellation & speaker bleed prevention:
  // Tracks active audio playback across both platforms so the mic can be silenced
  // while the loudspeaker is playing translated audio.
  const isPlayingAudioRef = useRef(false);
  const playbackEndTimeRef = useRef(0);

  // Audio mode (mic + speaker routing) is configured once by useAudioRecorder
  // itself when streaming starts — see src/hooks/useAudioRecorder.ts. Keeping
  // it in one place avoids two audio modules fighting over session config on
  // a screen where capture and playback run concurrently.

  // ── Web-only playback: Web Audio API buffer source, not expo-audio's
  // <audio>-element-backed AudioPlayer.
  const webPlaybackCtxRef = useRef<AudioContext | null>(null);
  const webPlaybackStateRef = useRef<{ source: AudioBufferSourceNode } | null>(null);
  const nextStartTimeRef = useRef(0);
  const pendingSourcesRef = useRef(0);
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

  // Web playback queue for streaming audio chunks
  const processWebAudioQueue = useCallback(async () => {
    if (isPlayingQueueRef.current || audioQueueRef.current.length === 0) return;

    isPlayingQueueRef.current = true;
    isPlayingAudioRef.current = true;
    setIsPlayingAudio(true);

    const ctx = getWebPlaybackContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (nextStartTimeRef.current < ctx.currentTime) nextStartTimeRef.current = ctx.currentTime;

    while (audioQueueRef.current.length > 0) {
      audioQueueRef.current.sort((a, b) => a.index - b.index);
      const chunk = audioQueueRef.current.shift();
      if (!chunk || !chunk.base64) continue;

      try {
        const audioBuffer = await ctx.decodeAudioData(base64ToArrayBuffer(chunk.base64));
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;

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
          if (pendingSourcesRef.current === 0) {
            isPlayingAudioRef.current = false;
            playbackEndTimeRef.current = Date.now();
            setIsPlayingAudio(false);
          }
        };
        webPlaybackStateRef.current = { source };
        source.start(startAt);
        nextStartTimeRef.current = endAt;
      } catch (e) {
        console.error('[SessionScreen] Web playback error:', e);
      }
    }

    isPlayingQueueRef.current = false;
  }, [getWebPlaybackContext]);

  // Native playback queue for complete sentence WAVs
  // Unlike feeding 150ms chunks into individual ExoPlayers (which leaks AudioTracks and
  // stutters), native plays the complete sentence WAV delivered by translated_audio_final.
  const processNativeAudioQueue = useCallback(async () => {
    if (isPlayingNativeRef.current || nativeAudioQueueRef.current.length === 0) return;

    isPlayingNativeRef.current = true;
    isPlayingAudioRef.current = true;
    setIsPlayingAudio(true);

    while (nativeAudioQueueRef.current.length > 0) {
      const base64 = nativeAudioQueueRef.current.shift();
      if (!base64) continue;

      let tempPath: string | null = null;
      let player: AudioPlayer | null = null;

      try {
        tempPath = `${FileSystem.cacheDirectory}audio_turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`;
        await FileSystem.writeAsStringAsync(tempPath, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });

        player = createAudioPlayer({ uri: tempPath });
        currentSoundRef.current = player;

        await new Promise<void>((resolve) => {
          let timeoutTimer: any = null;
          let settled = false;

          const finish = () => {
            if (settled) return;
            settled = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            try { sub?.remove(); } catch (_) {}
            resolve();
          };

          const sub = (player as any).addListener('playbackStatusUpdate', (s: any) => {
            if (!s) return;
            if (s.duration && s.duration > 0 && !timeoutTimer) {
              timeoutTimer = setTimeout(finish, Math.round(s.duration * 1000) + 1200);
            }
            if (s.didJustFinish) {
              finish();
            }
          });

          timeoutTimer = setTimeout(finish, 12000);

          try {
            player?.play();
          } catch (err) {
            console.warn('[SessionScreen] Native player.play error:', err);
            finish();
          }
        });
      } catch (e) {
        console.error('[SessionScreen] Native playback error:', e);
      } finally {
        if (player) {
          try { player.remove(); } catch (_) {}
        }
        currentSoundRef.current = null;
        if (tempPath) {
          FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
        }
      }
    }

    isPlayingNativeRef.current = false;
    isPlayingAudioRef.current = false;
    playbackEndTimeRef.current = Date.now();
    setIsPlayingAudio(false);
  }, []);

  const {
    status,
    isProcessing,
    sendAudioStreamChunk,
    sendPauseQueue,
    sendResumeQueue,
    endSession,
  } = useWebSocket({
    onLiveSubtitle: useCallback((payload: any) => {
      if (payload.speaker === 'partner') {
        setPartnerSpeaking(!payload.isFinal);
      }
      setActiveSubtitle(prev => {
        const orig = payload.originalText !== undefined ? payload.originalText : (prev && prev.speaker === payload.speaker ? prev.originalText : '');
        const trans = payload.translatedText !== undefined ? payload.translatedText : (prev && prev.speaker === payload.speaker ? prev.translatedText : '');
        return {
          speaker: payload.speaker,
          originalText: orig,
          translatedText: trans,
          isFinal: payload.isFinal ?? false,
          timestamp: Date.now(),
        };
      });
    }, []),

    onLiveSubtitleClear: useCallback(() => {
      setPartnerSpeaking(false);
    }, []),

    onTranslatedAudioChunk: useCallback((payload: any) => {
      if (payload.text?.trim()) {
        setActiveSubtitle(prev => ({
          speaker: 'partner',
          originalText: prev && prev.speaker === 'partner' ? prev.originalText : '',
          translatedText: payload.text.trim(),
          isFinal: false,
          timestamp: Date.now(),
        }));
      }
      if (Platform.OS === 'web') {
        if (!payload.audioBase64 && !payload.text?.trim()) return;
        audioQueueRef.current.push({ base64: payload.audioBase64, index: payload.index, text: payload.text });
        processWebAudioQueue();
      }
    }, [processWebAudioQueue]),

    onTranslatedAudioFinal: useCallback((original: string, translated: string, audioBase64?: string) => {
      setPartnerSpeaking(false);
      const cleanOrig = (original || '').trim();
      const cleanTrans = (translated || '').trim();
      if (cleanTrans.length >= 1 || cleanOrig.length >= 1) {
        setTranscript(prev => {
          if (prev.length > 0 && prev[0].direction === 'received' && (prev[0].translated === cleanTrans || prev[0].original === cleanOrig)) {
            return prev;
          }
          return [{ id: `recv-${Date.now()}`, direction: 'received', original: cleanOrig, translated: cleanTrans, timestamp: Date.now() }, ...prev];
        });
        setActiveSubtitle({
          speaker: 'partner',
          originalText: cleanOrig,
          translatedText: cleanTrans,
          isFinal: true,
          timestamp: Date.now(),
        });
      }
      if (Platform.OS !== 'web' && audioBase64) {
        nativeAudioQueueRef.current.push(audioBase64);
        processNativeAudioQueue();
      }
    }, [processNativeAudioQueue]),

    onTranscript: useCallback((original: string, translated: string) => {
      const cleanOrig = (original || '').trim();
      const cleanTrans = (translated || '').trim();
      if (cleanTrans.length >= 1 || cleanOrig.length >= 1) {
        setTranscript(prev => {
          if (prev.length > 0 && prev[0].direction === 'sent' && (prev[0].original === cleanOrig || prev[0].translated === cleanTrans)) {
            return prev;
          }
          return [{
            id: `sent-${Date.now()}`,
            direction: 'sent',
            original: cleanOrig,
            translated: cleanTrans,
            timestamp: Date.now(),
          }, ...prev];
        });
        setActiveSubtitle({
          speaker: 'self',
          originalText: cleanOrig,
          translatedText: cleanTrans,
          isFinal: true,
          timestamp: Date.now(),
        });
      }
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

  const handleToggleMute = useCallback(() => {
    if (hasError) {
      setHasError(false);
      return;
    }
    const nextPaused = !isPaused;
    setIsPaused(nextPaused);
    isPausedRef.current = nextPaused;

    if (nextPaused) {
      sendPauseQueue(role, sessionId);
    } else {
      sendResumeQueue(role, sessionId);
    }
  }, [hasError, isPaused, role, sessionId, sendPauseQueue, sendResumeQueue]);

  // Continuous streaming with Acoustic Echo Suppression:
  // When partner's translated speech is playing on the loudspeaker, we suppress
  // forwarding microphone buffers so the loudspeaker output doesn't get captured
  // and fed back into Gemini. A 500ms decay guard allows room reverberation to settle.
  const canRecord = status === 'connected' && !isPaused && !hasError;

  const handleChunk = useCallback((audioBase64: string, mimeType: string) => {
    if (isPausedRef.current) {
      return;
    }
    if (isPlayingAudioRef.current || Date.now() < playbackEndTimeRef.current + 500) {
      return;
    }
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
      nativeAudioQueueRef.current = [];
      isPlayingNativeRef.current = false;
      isPlayingAudioRef.current = false;
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
                <Text style={styles.statusSub}>
                  {partnerSpeaking ? 'Partner is speaking…' : isPlayingAudio ? 'Playing translation…' : statusLabel}
                </Text>

                {/* ── LIVE TEXT TRANSLATION (Real-time in-call subtitles) ── */}
                <View style={styles.liveSubtitleCard}>
                  {activeSubtitle && (activeSubtitle.translatedText || activeSubtitle.originalText) ? (
                    <>
                      <View style={styles.subtitleHeader}>
                        <View style={[
                          styles.speakerBadge,
                          activeSubtitle.speaker === 'self' ? styles.speakerBadgeSelf : styles.speakerBadgePartner,
                        ]}>
                          <View style={[
                            styles.badgeDot,
                            activeSubtitle.speaker === 'self' ? styles.badgeDotSelf : styles.badgeDotPartner,
                          ]} />
                          <Text style={[
                            styles.speakerBadgeText,
                            activeSubtitle.speaker === 'self' ? styles.speakerTextSelf : styles.speakerTextPartner,
                          ]}>
                            {activeSubtitle.speaker === 'self' ? 'You' : 'Partner'}
                          </Text>
                        </View>
                        {!activeSubtitle.isFinal && (
                          <Text style={styles.liveIndicatorText}>Translating live…</Text>
                        )}
                      </View>

                      {!!activeSubtitle.originalText && (
                        <Text style={styles.subtitleOriginal} numberOfLines={2}>
                          {activeSubtitle.originalText}
                        </Text>
                      )}

                      <Text style={styles.subtitleTranslated} numberOfLines={3}>
                        {activeSubtitle.translatedText || '…'}
                      </Text>
                    </>
                  ) : (
                    <View style={styles.subtitlePlaceholder}>
                      <Feather name="mic" size={14} color={colors.muted} />
                      <Text style={styles.placeholderText}>
                        Speak naturally — live translation appears here
                      </Text>
                    </View>
                  )}
                </View>
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
              onPress={handleToggleMute}
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

  // ── In-Call Live Subtitle Card ──────────────────────────────────────────
  liveSubtitleCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: 'rgba(22, 22, 26, 0.88)',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    marginTop: 8,
    minHeight: 100,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 4,
  },
  subtitleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  speakerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    gap: 6,
  },
  speakerBadgeSelf: {
    backgroundColor: 'rgba(47, 224, 168, 0.12)',
    borderColor: 'rgba(47, 224, 168, 0.28)',
    borderWidth: 1,
  },
  speakerBadgePartner: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderColor: 'rgba(56, 189, 248, 0.28)',
    borderWidth: 1,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeDotPulsing: {
    opacity: 0.85,
  },
  badgeDotSelf: {
    backgroundColor: colors.signal,
  },
  badgeDotPartner: {
    backgroundColor: '#38bdf8',
  },
  speakerBadgeText: {
    fontSize: 11.5,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  speakerTextSelf: {
    color: colors.signal,
  },
  speakerTextPartner: {
    color: '#38bdf8',
  },
  liveIndicatorText: {
    fontSize: 11,
    color: colors.muted,
    fontStyle: 'italic',
  },
  subtitleOriginal: {
    fontSize: 12,
    color: colors.muted,
    fontStyle: 'italic',
    marginBottom: 4,
    lineHeight: 16,
  },
  subtitleTranslated: {
    fontSize: 15.5,
    fontWeight: '500',
    color: colors.warm,
    lineHeight: 21,
  },
  subtitlePlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  placeholderText: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
  },
});
