import React, { useState, useEffect } from 'react';
import { storage } from '../utils/storageCompat';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Modal,
  Platform,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LanguageSelector } from '../components/LanguageSelector';
import { QRCodeDisplay } from '../components/QRCodeDisplay';
import { QRScanner } from '../components/QRScanner';
import { useWebSocket } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { useRef } from 'react';
import { Image } from 'react-native';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { WS_URL } from '../config';
import { colors, DESKTOP_BREAKPOINT } from '../theme';

interface HomeScreenProps {
  onSessionReady: (params: {
    sessionId: string;
    role: 'host' | 'guest';
    myLang: string;
    partnerLang: string;
  }) => void;
  onOpenProfile: () => void;
  onOpenConversation: (conversationId: string, myUserId: string) => void;
  onOpenRecordings: (conversationId: string, myUserId: string, myLang: string, partnerLang: string) => void;
}

interface RecentConversation {
  id: string;
  sessionId: string;
  myLang: string;
  partnerLang: string;
  startedAt: string;
  lastMessage: { text: string; sentAt: string; isMe: boolean } | null;
  messageCount: number;
}

export function HomeScreen({ onSessionReady, onOpenProfile, onOpenConversation, onOpenRecordings }: HomeScreenProps) {
  const { signOut } = useAuth();
  const { user } = useUser();
  // Voice profile from Clerk metadata — used for Gemini voice warm-up at session start
  const meta = user?.unsafeMetadata as any;
  const speakerGender: string | undefined = meta?.gender;
  const speakerAge: number | undefined = meta?.age !== undefined ? Number(meta.age) : undefined;
  const nativeLanguage: string | undefined = meta?.nativeLanguage;

  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;

  const [myLang, setMyLang] = useState('English');

  // Default to the user's native language (set in their profile) until they
  // explicitly pick a different language here — an explicit pick, once made,
  // persists and always wins over the native-language default afterward.
  const MY_LANG_KEY = 'shak_my_language';
  useEffect(() => {
    storage.getItem(MY_LANG_KEY)
      .then(saved => {
        if (saved) setMyLang(saved);
        else if (nativeLanguage) setMyLang(nativeLanguage);
      })
      .catch(() => {});
  }, [nativeLanguage]);

  const handleSetMyLang = (lang: string) => {
    setMyLang(lang);
    storage.setItem(MY_LANG_KEY, lang).catch(() => {});
  };
  const [showQR, setShowQR] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<RecentConversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const roleRef = useRef<'host' | 'guest' | null>(null);
  const userId = user?.id;

  // Helper to format timestamps
  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes || 1}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // Fetch recent conversations on mount
  useEffect(() => {
    if (!userId) return;
    const httpUrl = WS_URL.replace(/^ws(s)?:\/\//, 'http$1://');
    setLoadingConvs(true);
    fetch(`${httpUrl}/conversations?userId=${encodeURIComponent(userId)}`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setRecentConversations(data); })
      .catch(e => console.warn('[HomeScreen] Failed to load conversations:', e))
      .finally(() => setLoadingConvs(false));
  }, [userId]);

  const { status, sessionId, partnerLang, createSession, joinSession, endSession } = useWebSocket({
    onError: (msg) => setErrorMsg(msg),
    onTranslatedAudio: () => { },
    onPartnerDisconnected: () => { },
  });

  React.useEffect(() => {
    if (status === 'connected' && sessionId && partnerLang && roleRef.current) {
      onSessionReady({ sessionId, role: roleRef.current, myLang, partnerLang });
    }
  }, [status, sessionId, partnerLang]);

  const checkMicPermission = async (): Promise<boolean> => {
    if (Platform.OS === 'web') return true;
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setErrorMsg('Microphone permission is required to start or join calls.');
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[HomeScreen] Permission request error:', e);
      return true;
    }
  };

  const handleStartSession = async () => {
    setErrorMsg(null);
    const ok = await checkMicPermission();
    if (!ok) return;
    roleRef.current = 'host';
    await createSession(myLang, userId, speakerGender, speakerAge);
    setShowQR(true);
  };

  const handleScanned = async (scannedId: string) => {
    setShowScanner(false);
    const ok = await checkMicPermission();
    if (!ok) return;
    roleRef.current = 'guest';
    await joinSession(scannedId, myLang, userId, speakerGender, speakerAge);
  };

  const showRecent = loadingConvs || recentConversations.length > 0;

  return (
    <SafeAreaView style={styles.container}>
      {/* Background accents */}
      <View style={styles.topGlow} />
      <View style={styles.bottomGlow} />

      <ScrollView
        contentContainerStyle={[styles.scroll, isDesktop && styles.scrollDesktop]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.page, isDesktop && styles.pageDesktop]}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitleContainer}>
              <View style={styles.logoIcon}>
                <Feather name="globe" size={20} color={colors.ink} />
              </View>
              <Text style={styles.title}>
                Shak<Text style={styles.titleGreen}>Translate</Text>
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity onPress={onOpenProfile} style={styles.profileBtn}>
                {user?.imageUrl ? (
                  <Image source={{ uri: user.imageUrl }} style={styles.profileAvatar} />
                ) : (
                  <Feather name="user" size={18} color={colors.muted} />
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => signOut()} style={styles.signOutBtn}>
                <Feather name="log-out" size={18} color={colors.muted} />
              </TouchableOpacity>
            </View>
          </View>

          <Text style={styles.greetTitle}>Ready when you are</Text>
          <Text style={styles.subtitle}>Start a call and share the code, or join one.</Text>

          {/* Error */}
          {errorMsg && (
            <View style={styles.errorBox}>
              <Feather name="alert-circle" size={14} color={colors.danger} />
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          )}

          {/* Language Config */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>YOU'LL SPEAK</Text>
            <LanguageSelector label="" selected={myLang} onSelect={handleSetMyLang} />
          </View>

          {/* Actions */}
          <View style={[styles.actions, isDesktop && styles.actionsDesktop]}>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                isDesktop && styles.entryCard,
              ]}
              onPress={handleStartSession}
              disabled={status === 'connecting' || status === 'waiting'}
              activeOpacity={0.85}
            >
              <View style={[styles.entryIconWrap, isDesktop && styles.entryIconWrapDesktop]}>
                {status === 'connecting' ? (
                  <ActivityIndicator color={colors.ink} size="small" />
                ) : (
                  <Feather name="phone-call" size={isDesktop ? 22 : 20} color={colors.ink} />
                )}
              </View>
              <View style={isDesktop ? { alignItems: 'center' } : undefined}>
                <Text style={styles.primaryBtnText}>
                  {status === 'connecting' ? 'Connecting…' : 'Start a call'}
                </Text>
                {isDesktop && <Text style={styles.entryCardSub}>Get a code to share</Text>}
              </View>
            </TouchableOpacity>

            {!isDesktop && (
              <View style={styles.orRow}>
                <View style={styles.orLine} />
                <Text style={styles.orText}>or</Text>
                <View style={styles.orLine} />
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.secondaryBtn,
                isDesktop && styles.entryCard,
                isDesktop && styles.entryCardSecondary,
              ]}
              onPress={() => setShowScanner(true)}
              activeOpacity={0.85}
            >
              <View style={[styles.entryIconWrap, styles.entryIconWrapSecondary, isDesktop && styles.entryIconWrapDesktop]}>
                <Feather name="camera" size={isDesktop ? 22 : 20} color={colors.signal} />
              </View>
              <View style={isDesktop ? { alignItems: 'center' } : undefined}>
                <Text style={styles.secondaryBtnText}>Scan to join a call</Text>
                {isDesktop && <Text style={styles.entryCardSub}>Use the other device's code</Text>}
              </View>
            </TouchableOpacity>
          </View>

          {/* Recent Conversations — only shown once there's something to show */}
          {showRecent && (
            <View style={styles.recentSection}>
              <View style={styles.recentHeader}>
                <Feather name="message-square" size={13} color={colors.muted} />
                <Text style={styles.recentTitle}> RECENT CONVERSATIONS</Text>
              </View>
              {loadingConvs && <ActivityIndicator color={colors.signal} style={{ marginTop: 16 }} />}
              {recentConversations.map(conv => (
                <View key={conv.id} style={styles.convItemWrapper}>
                  {/* Chat transcript button */}
                  <TouchableOpacity
                    style={styles.convItem}
                    onPress={() => onOpenConversation(conv.id, userId || '')}
                    activeOpacity={0.75}
                  >
                    <View style={styles.convIcon}>
                      <Feather name="globe" size={16} color={colors.signal} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={styles.convLangs}>{conv.myLang} ↔ {conv.partnerLang || '...'}</Text>
                        <Text style={styles.convTime}>
                          {conv.lastMessage ? timeAgo(conv.lastMessage.sentAt) : timeAgo(conv.startedAt)}
                        </Text>
                      </View>
                      <Text style={styles.convPreview} numberOfLines={1}>
                        {conv.lastMessage
                          ? `${conv.lastMessage.isMe ? 'You: ' : ''}${conv.lastMessage.text}`
                          : `${conv.messageCount} messages`}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  {/* Recordings button */}
                  <TouchableOpacity
                    style={styles.recordingsBtn}
                    onPress={() => onOpenRecordings(conv.id, userId || '', conv.myLang, conv.partnerLang || '')}
                    activeOpacity={0.75}
                  >
                    <Feather name="headphones" size={15} color={colors.signal} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* QR Code Modal (Host) */}
      <Modal visible={showQR} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Waiting for them to join</Text>
            <Text style={styles.modalSubtitle}>Share the code, or have them scan this screen</Text>

            {sessionId ? (
              <QRCodeDisplay sessionId={sessionId} />
            ) : (
              <ActivityIndicator color={colors.signal} size="large" style={{ marginVertical: 40 }} />
            )}

            <StatusBadge status={status} role="host" />

            {status === 'connected' && (
              <Text style={styles.connectedMsg}>Partner connected! Starting call…</Text>
            )}

            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => {
                if (sessionId) {
                  endSession('host', sessionId);
                }
                setShowQR(false);
              }}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* QR Scanner Modal (Guest) */}
      <Modal visible={showScanner} animationType="slide">
        <QRScanner
          onScanned={handleScanned}
          onCancel={() => setShowScanner(false)}
        />
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  scroll: { padding: 24, paddingBottom: 48 },
  scrollDesktop: { alignItems: 'center', paddingTop: 56 },
  page: { width: '100%' },
  pageDesktop: { maxWidth: 640 },
  topGlow: {
    position: 'absolute', top: -80, right: -80,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: colors.signal, opacity: 0.06,
  },
  bottomGlow: {
    position: 'absolute', bottom: -80, left: -80,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: colors.signal, opacity: 0.06,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20,
    paddingTop: Platform.OS === 'android' ? 20 : 8,
  },
  headerTitleContainer: {
    flexDirection: 'row', alignItems: 'center',
  },
  logoIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: colors.signal,
    justifyContent: 'center', alignItems: 'center', marginRight: 10,
  },
  title: { color: colors.warm, fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  titleGreen: { color: colors.signal },
  signOutBtn: {
    padding: 8,
    backgroundColor: colors.surface2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.hair,
  },
  profileBtn: {
    padding: 6,
    backgroundColor: colors.surface2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.hair,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  greetTitle: { color: colors.warm, fontSize: 19, fontWeight: '600', marginBottom: 4 },
  subtitle: {
    color: colors.muted,
    fontSize: 13, marginBottom: 28,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(232,92,92,0.1)',
    borderWidth: 1, borderColor: 'rgba(232,92,92,0.25)',
    borderRadius: 12, padding: 12, marginBottom: 16,
  },
  errorText: { color: colors.danger, fontSize: 13, flex: 1 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1, borderColor: colors.hair,
    padding: 20,
    marginBottom: 28,
  },
  cardTitle: {
    color: colors.muted,
    fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 2, marginBottom: 18,
  },
  actions: { gap: 12 },
  actionsDesktop: { flexDirection: 'row', gap: 16, alignItems: 'stretch' },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.signal, borderRadius: 16,
    paddingVertical: 18, paddingHorizontal: 24,
    shadowColor: colors.signal, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
  },
  primaryBtnText: { color: colors.ink, fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  orLine: { flex: 1, height: 1, backgroundColor: colors.hair },
  orText: { color: colors.muted, fontSize: 12 },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.surface2,
    borderWidth: 1, borderColor: colors.hair,
    borderRadius: 16, paddingVertical: 18, paddingHorizontal: 24,
  },
  secondaryBtnText: { color: colors.warm, fontSize: 16, fontWeight: '700' },

  // Desktop: the two entries become equal-weight cards side by side instead
  // of a ranked primary button + secondary line, since there's room for both
  // to read as clear, deliberate choices rather than one being squeezed in.
  entryCard: {
    flex: 1, flexDirection: 'column', paddingVertical: 32, gap: 14,
    borderRadius: 20,
  },
  entryCardSecondary: {},
  entryCardSub: { color: 'rgba(10,13,12,0.55)', fontSize: 12.5, marginTop: 2 },
  entryIconWrap: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(10,13,12,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  entryIconWrapSecondary: { backgroundColor: colors.surface3 },
  entryIconWrapDesktop: { width: 52, height: 52, borderRadius: 26 },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderWidth: 1, borderColor: colors.hair,
    padding: 28, alignItems: 'center', paddingBottom: 48,
  },
  modalTitle: { color: colors.warm, fontSize: 20, fontWeight: '700', marginBottom: 4 },
  modalSubtitle: { color: colors.muted, fontSize: 13, marginBottom: 20, textAlign: 'center' },
  connectedMsg: {
    color: colors.signal, fontSize: 13, fontWeight: '600',
    marginTop: 16, textAlign: 'center',
  },
  cancelBtn: {
    marginTop: 24,
    paddingHorizontal: 32, paddingVertical: 12,
    borderRadius: 12, borderWidth: 1, borderColor: colors.hair,
  },
  cancelBtnText: { color: colors.muted, fontSize: 14 },

  // Recent Conversations
  recentSection: { marginTop: 32 },
  recentHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  recentTitle: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginLeft: 6 },
  convItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.hair,
  },
  convItemWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  recordingsBtn: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hair,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  convIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.surface2,
    justifyContent: 'center', alignItems: 'center',
    marginRight: 14,
  },
  convLangs: { color: colors.warm, fontSize: 14, fontWeight: '600' },
  convTime: { color: colors.muted, fontSize: 11 },
  convPreview: { color: colors.muted, fontSize: 13, marginTop: 4 },
});
