import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Alert,
  GestureResponderEvent,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Audio } from 'expo-av';
import Animated, { useAnimatedStyle, withTiming, useSharedValue, interpolateColor } from 'react-native-reanimated';
import { WS_URL } from '../config';

interface AudioRecordingsScreenProps {
  conversationId: string;
  myUserId: string;
  myLang: string;
  partnerLang: string;
  onBack: () => void;
}

interface RecordingMessage {
  id: string;
  sender_user_id: string;
  role: string;
  original_text: string;
  translated_text: string;
  original_audio_url: string | null;
  translated_audio_url: string | null;
  original_audio_offset_ms?: number;
  sent_at: string;
}

interface PlaylistEntry {
  messageId: string;
  url: string;
  durationMs: number | null;
  skipMs: number;
  isMe: boolean;
}

const RecordingItem = React.memo(({ item, isMe, isActive }: { item: RecordingMessage; isMe: boolean; isActive: boolean }) => {
  const progress = useSharedValue(isActive ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(isActive ? 1 : 0, { duration: 350 });
  }, [isActive]);

  const animatedStyle = useAnimatedStyle(() => {
    const borderColor = interpolateColor(
      progress.value,
      [0, 1],
      ['rgba(255,255,255,0.05)', '#39FF14']
    );

    return {
      borderColor,
      backgroundColor: 'transparent',
      shadowOpacity: progress.value * 0.3,
    };
  });

  return (
    <Animated.View style={[styles.card, animatedStyle]}>
      <View style={styles.cardHeader}>
        <View style={[styles.speakerBadge, isMe ? styles.speakerBadgeMe : styles.speakerBadgePartner]}>
          <Feather name={isMe ? 'mic' : 'volume-2'} size={10} color={isMe ? '#000' : '#39FF14'} />
          <Text style={[styles.speakerBadgeText, isMe ? styles.speakerBadgeTextMe : {}]}>
            {isMe ? 'YOU' : 'PARTNER'}
          </Text>
        </View>
        <Text style={styles.timeText}>
          {new Date(item.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
      <View style={styles.cardContent}>
        <Text style={styles.originalText}>{item.original_text}</Text>
        <Text style={styles.translatedText}>{item.translated_text}</Text>
      </View>
    </Animated.View>
  );
});

export function AudioRecordingsScreen({
  conversationId,
  myUserId,
  myLang,
  partnerLang,
  onBack,
}: AudioRecordingsScreenProps) {
  const [messages, setMessages] = useState<RecordingMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMsgId, setCurrentMsgId] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [totalDurationMs, setTotalDurationMs] = useState(0);

  const playlistRef = useRef<PlaylistEntry[]>([]);
  const currentIndexRef = useRef<number>(-1);
  const currentSoundRef = useRef<Audio.Sound | null>(null);
  const nextSoundRef = useRef<Audio.Sound | null>(null);
  const nextIndexRef = useRef<number>(-1);
  const listRef = useRef<FlatList>(null);
  const scrubberWidthRef = useRef(1);

  // Track position updates
  const updatePositionIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false, // Keeping speaker for playback screen
    }).catch(() => {});

    return () => {
      stopPlayback();
    };
  }, []);

  useEffect(() => {
    const httpUrl = WS_URL.replace(/^ws(s)?:\/\//, 'http$1://');
    fetch(`${httpUrl}/conversations/${encodeURIComponent(conversationId)}/recordings`)
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error || `Server error (${r.status})`);
        }
        return r.json();
      })
      .then(data => {
        setMessages(data);
        buildPlaylist(data);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [conversationId]);

  const buildPlaylist = (data: RecordingMessage[]) => {
    const list: PlaylistEntry[] = [];
    data.forEach(msg => {
      const isMe = msg.sender_user_id === myUserId;
      const url = isMe ? msg.original_audio_url : msg.translated_audio_url;
      const skipMs = isMe ? (msg.original_audio_offset_ms || 0) : 0;
      if (url) {
        list.push({ messageId: msg.id, url, durationMs: null, skipMs, isMe });
      }
    });
    playlistRef.current = list;
    // We don't know total duration yet. We will load it lazily.
  };

  const stopPlayback = async () => {
    if (updatePositionIntervalRef.current) clearInterval(updatePositionIntervalRef.current);
    if (currentSoundRef.current) {
      try {
        await currentSoundRef.current.stopAsync();
        await currentSoundRef.current.unloadAsync();
      } catch (_) {}
      currentSoundRef.current = null;
    }
    if (nextSoundRef.current) {
      try {
        await nextSoundRef.current.unloadAsync();
      } catch (_) {}
      nextSoundRef.current = null;
      nextIndexRef.current = -1;
    }
    setIsPlaying(false);
  };

  const updateDuration = (entry: PlaylistEntry, status: any) => {
    if (status.isLoaded && status.durationMillis) {
      if (!entry.durationMs) {
        entry.durationMs = status.durationMillis - entry.skipMs;
        const total = playlistRef.current.reduce((acc, curr) => acc + (curr.durationMs || 0), 0);
        setTotalDurationMs(total);
      }
    }
  };

  const setupSoundListeners = (sound: Audio.Sound, entry: PlaylistEntry, index: number) => {
    sound.setOnPlaybackStatusUpdate(stat => {
      if (stat.isLoaded) {
        if (stat.didJustFinish) {
          playFrom(index + 1);
        } else if (stat.isPlaying) {
          const prevDuration = playlistRef.current.slice(0, index).reduce((acc, curr) => acc + (curr.durationMs || 0), 0);
          setPositionMs(prevDuration + (stat.positionMillis - entry.skipMs));
        }
      }
    });
  };

  const preloadNext = async (index: number) => {
    if (index >= playlistRef.current.length) return;
    if (nextSoundRef.current) {
      try { await nextSoundRef.current.unloadAsync(); } catch (_) {}
      nextSoundRef.current = null;
    }
    const entry = playlistRef.current[index];
    nextIndexRef.current = index;
    try {
      const { sound, status } = await Audio.Sound.createAsync(
        { uri: entry.url },
        { shouldPlay: false, positionMillis: entry.skipMs }
      );
      nextSoundRef.current = sound;
      updateDuration(entry, status);
    } catch (e) {
      console.warn('Preload error', e);
      nextIndexRef.current = -1;
    }
  };

  const playFrom = async (index: number) => {
    if (index < 0 || index >= playlistRef.current.length) {
      await stopPlayback();
      currentIndexRef.current = -1;
      setCurrentMsgId(null);
      setPositionMs(totalDurationMs);
      return;
    }

    const entry = playlistRef.current[index];
    setCurrentMsgId(entry.messageId);

    // Scroll list to item
    const msgIndex = messages.findIndex(m => m.id === entry.messageId);
    if (msgIndex >= 0 && listRef.current) {
      listRef.current.scrollToIndex({ index: msgIndex, animated: true, viewPosition: 0.5 });
    }

    if (nextIndexRef.current === index && nextSoundRef.current) {
      if (currentSoundRef.current) {
        try { await currentSoundRef.current.unloadAsync(); } catch (_) {}
      }
      currentSoundRef.current = nextSoundRef.current;
      currentIndexRef.current = index;
      nextSoundRef.current = null;
      nextIndexRef.current = -1;
      
      try {
        await currentSoundRef.current.playAsync();
        setIsPlaying(true);
        setupSoundListeners(currentSoundRef.current, entry, index);
        preloadNext(index + 1);
      } catch (e) {
        console.warn('Preloaded playback error', e);
        playFrom(index + 1);
      }
      return;
    }

    await stopPlayback();
    currentIndexRef.current = index;

    try {
      const { sound, status } = await Audio.Sound.createAsync(
        { uri: entry.url },
        { shouldPlay: true, positionMillis: entry.skipMs }
      );
      currentSoundRef.current = sound;
      setIsPlaying(true);
      updateDuration(entry, status);
      setupSoundListeners(sound, entry, index);
      preloadNext(index + 1);
    } catch (e) {
      console.warn('Playback error', e);
      playFrom(index + 1);
    }
  };

  const handlePlayPause = () => {
    if (isPlaying) {
      if (currentSoundRef.current) currentSoundRef.current.pauseAsync();
      setIsPlaying(false);
    } else {
      if (currentSoundRef.current) {
        currentSoundRef.current.playAsync();
        setIsPlaying(true);
      } else {
        // Start from beginning or current position
        if (currentIndexRef.current === -1 || positionMs >= totalDurationMs) {
          playFrom(0);
        } else {
          playFrom(currentIndexRef.current);
        }
      }
    }
  };

  const handlePrev = () => {
    if (currentIndexRef.current > 0) playFrom(currentIndexRef.current - 1);
  };

  const handleNext = () => {
    if (currentIndexRef.current < playlistRef.current.length - 1) playFrom(currentIndexRef.current + 1);
  };

  const handleScrubberTap = (evt: GestureResponderEvent) => {
    const fraction = evt.nativeEvent.locationX / scrubberWidthRef.current;
    if (fraction < 0 || fraction > 1 || !totalDurationMs) return;
    
    const targetMs = fraction * totalDurationMs;
    
    let accumulatedMs = 0;
    for (let i = 0; i < playlistRef.current.length; i++) {
      const entry = playlistRef.current[i];
      const duration = entry.durationMs || 0; // fallback if not loaded
      if (accumulatedMs + duration >= targetMs || i === playlistRef.current.length - 1) {
        // Seek here
        const offsetWithinClip = targetMs - accumulatedMs;
        if (currentIndexRef.current === i && currentSoundRef.current) {
           currentSoundRef.current.setPositionAsync(entry.skipMs + offsetWithinClip);
        } else {
           // We'd need to playFrom(i) and seek, but playFrom currently starts at skipMs.
           // Modifying playFrom to accept an offset is slightly complex, so we just restart the clip.
           playFrom(i);
        }
        break;
      }
      accumulatedMs += duration;
    }
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const renderItem = ({ item }: { item: RecordingMessage }) => {
    const isMe = item.sender_user_id === myUserId;
    const isActive = currentMsgId === item.id;
    return <RecordingItem item={item} isMe={isMe} isActive={isActive} />;
  };

  const scrubberFraction = totalDurationMs > 0 ? Math.min(1, positionMs / totalDurationMs) : 0;

  return (
    <View style={styles.container}>
      <LinearGradient colors={['#0f172a', '#020617']} style={StyleSheet.absoluteFillObject} />
      <SafeAreaView style={styles.safeArea}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => { stopPlayback(); onBack(); }} style={styles.backBtn}>
            <Feather name="arrow-left" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Recordings</Text>
            <Text style={styles.headerSub}>{myLang} ↔ {partnerLang}</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>

        {/* Content */}
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color="#39FF14" size="large" />
            <Text style={styles.loadingText}>Loading recordings...</Text>
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Feather name="alert-circle" size={40} color="#ef4444" style={{ marginBottom: 16 }} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            onScrollToIndexFailed={info => {
              const wait = new Promise(resolve => setTimeout(resolve, 500));
              wait.then(() => {
                if (listRef.current) {
                  listRef.current.scrollToIndex({ index: info.index, animated: true });
                }
              });
            }}
            ListEmptyComponent={
              <View style={styles.center}>
                <Feather name="mic-off" size={40} color="rgba(255,255,255,0.1)" style={{ marginBottom: 16 }} />
                <Text style={styles.emptyText}>No recordings saved for this session.</Text>
              </View>
            }
          />
        )}

        {/* Unified Player Bar */}
        {messages.length > 0 && (
          <BlurView intensity={60} tint="dark" style={styles.playerBar}>
            <View 
              style={styles.scrubberContainer}
              onLayout={(e) => scrubberWidthRef.current = e.nativeEvent.layout.width}
              onStartShouldSetResponder={() => true}
              onResponderRelease={handleScrubberTap}
            >
              <View style={styles.scrubberTrack}>
                <View style={[styles.scrubberFill, { width: `${scrubberFraction * 100}%` }]} />
                <View style={[styles.scrubberHandle, { left: `${scrubberFraction * 100}%` }]} />
              </View>
            </View>
            
            <View style={styles.timeRow}>
              <Text style={styles.timeDisplay}>{formatTime(positionMs)}</Text>
              <Text style={styles.timeDisplay}>{totalDurationMs > 0 ? formatTime(totalDurationMs) : '--:--'}</Text>
            </View>
            
            <View style={styles.playerControls}>
              <View style={styles.btnRow}>
                <TouchableOpacity onPress={handlePrev} style={styles.ctrlBtn}>
                  <Feather name="skip-back" size={24} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={handlePlayPause} style={styles.playPauseBtn}>
                  <Feather name={isPlaying ? 'pause' : 'play'} size={28} color="#000" />
                </TouchableOpacity>
                <TouchableOpacity onPress={handleNext} style={styles.ctrlBtn}>
                  <Feather name="skip-forward" size={24} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          </BlurView>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617' },
  safeArea: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 20 : 10,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  backBtn: { padding: 8, marginLeft: -8 },
  headerCenter: { alignItems: 'center' },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerSub: { color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 4 },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  loadingText: { color: 'rgba(255,255,255,0.5)', marginTop: 16, fontSize: 15 },
  errorText: { color: '#ef4444', textAlign: 'center', fontSize: 15 },
  emptyText: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8, textAlign: 'center' },

  listContent: { padding: 20, paddingBottom: 160 },

  card: {
    padding: 16,
    borderRadius: 20,
    marginBottom: 16,
    borderWidth: 1,
    // shadowColor: '#39FF14',
    // shadowOffset: { width: 0, height: 0 },
    // shadowRadius: 10,
    // elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  speakerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  speakerBadgeMe: { backgroundColor: '#39FF14' },
  speakerBadgePartner: { backgroundColor: 'rgba(57,255,20,0.1)' },
  speakerBadgeText: { fontSize: 11, fontWeight: '700', marginLeft: 4, color: '#39FF14', letterSpacing: 0.5 },
  speakerBadgeTextMe: { color: '#000' },
  timeText: { color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: '500' },
  cardContent: {
    marginTop: 4,
  },
  originalText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    fontStyle: 'italic',
    marginBottom: 6,
  },
  translatedText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
    lineHeight: 22,
  },

  playerBar: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 24 : 16,
    left: 16,
    right: 16,
    borderRadius: 30,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingBottom: 16,
    paddingTop: 8,
  },
  scrubberContainer: {
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 8,
  },
  scrubberTrack: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2,
    position: 'relative',
  },
  scrubberFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#39FF14',
    borderRadius: 2,
  },
  scrubberHandle: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#39FF14',
    top: -4,
    marginLeft: -6,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginTop: 6,
  },
  timeDisplay: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontVariant: ['tabular-nums'] },
  playerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 4,
  },
  btnRow: { flexDirection: 'row', alignItems: 'center' },
  ctrlBtn: { padding: 12 },
  playPauseBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#39FF14',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 16,
  },
});
