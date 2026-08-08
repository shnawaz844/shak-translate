import React, { useState, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
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
  FlatList,
  TextInput,
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
import { WS_URL } from '../config';

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
  const [myLang, setMyLang] = useState('English');

  // Persist the user's chosen language so it survives session end / remounts
  const MY_LANG_KEY = 'shak_my_language';
  useEffect(() => {
    SecureStore.getItemAsync(MY_LANG_KEY)
      .then(saved => { if (saved) setMyLang(saved); })
      .catch(() => {});
  }, []);

  const handleSetMyLang = (lang: string) => {
    setMyLang(lang);
    SecureStore.setItemAsync(MY_LANG_KEY, lang).catch(() => {});
  };
  const [showQR, setShowQR] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<RecentConversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const roleRef = useRef<'host' | 'guest' | null>(null);
  const userId = user?.id;
  // Voice profile from Clerk metadata — used for Gemini voice warm-up at session start
  const meta = user?.unsafeMetadata as any;
  const speakerGender: string | undefined = meta?.gender;
  const speakerAge: number | undefined = meta?.age !== undefined ? Number(meta.age) : undefined;

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

  const handleStartSession = async () => {
    setErrorMsg(null);
    roleRef.current = 'host';
    await createSession(myLang, userId, speakerGender, speakerAge);
    setShowQR(true);
  };

  const handleScanned = async (scannedId: string) => {
    setShowScanner(false);
    roleRef.current = 'guest';
    await joinSession(scannedId, myLang, userId, speakerGender, speakerAge);
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Background accents */}
      <View style={styles.topGlow} />
      <View style={styles.bottomGlow} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTitleContainer}>
            <View style={styles.logoIcon}>
              <Feather name="globe" size={20} color="#000" />
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
                <Feather name="user" size={18} color="rgba(255,255,255,0.6)" />
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => signOut()} style={styles.signOutBtn}>
              <Feather name="log-out" size={18} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          </View>
        </View>

        <Text style={styles.subtitle}>Real-time two-way conversation translation</Text>

        {/* Error */}
        {errorMsg && (
          <View style={styles.errorBox}>
            <Feather name="alert-circle" size={14} color="#ef4444" />
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        )}

        {/* Language Config */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>MY LANGUAGE</Text>
          <LanguageSelector label="" selected={myLang} onSelect={handleSetMyLang} />
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          {/* Start Session */}
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleStartSession}
            disabled={status === 'connecting' || status === 'waiting'}
            activeOpacity={0.8}
          >
            {status === 'connecting' ? (
              <ActivityIndicator color="#000" size="small" />
            ) : (
              <Feather name="plus-circle" size={20} color="#000" />
            )}
            <Text style={styles.primaryBtnText}>
              {status === 'connecting' ? 'Connecting...' : 'Start Session'}
            </Text>
          </TouchableOpacity>

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>OR</Text>
            <View style={styles.orLine} />
          </View>

          {/* Join Session */}
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => setShowScanner(true)}
            activeOpacity={0.8}
          >
            <Feather name="camera" size={20} color="#39FF14" />
            <Text style={styles.secondaryBtnText}>Join Session (Scan QR)</Text>
          </TouchableOpacity>

          {/* Fallback for when camera scanning isn't available/working */}
          <View style={styles.manualJoinRow}>
            <TextInput
              style={styles.manualJoinInput}
              placeholder="Or paste session code"
              placeholderTextColor="rgba(255,255,255,0.3)"
              value={manualCode}
              onChangeText={setManualCode}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[styles.manualJoinBtn, !manualCode.trim() && styles.manualJoinBtnDisabled]}
              disabled={!manualCode.trim()}
              onPress={() => handleScanned(manualCode.trim())}
            >
              <Text style={styles.manualJoinBtnText}>Join</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Recent Conversations */}
        <View style={styles.recentSection}>
          <View style={styles.recentHeader}>
            <Feather name="message-square" size={13} color="rgba(255,255,255,0.3)" />
            <Text style={styles.recentTitle}> RECENT CONVERSATIONS</Text>
          </View>
          {loadingConvs && <ActivityIndicator color="#39FF14" style={{ marginTop: 16 }} />}
          {!loadingConvs && recentConversations.length === 0 && (
            <Text style={styles.recentEmpty}>No conversations yet. Start a session!</Text>
          )}
          {recentConversations.map(conv => (
            <View key={conv.id} style={styles.convItemWrapper}>
              {/* Chat transcript button */}
              <TouchableOpacity
                style={styles.convItem}
                onPress={() => onOpenConversation(conv.id, userId || '')}
                activeOpacity={0.75}
              >
                <View style={styles.convIcon}>
                  <Feather name="globe" size={16} color="#39FF14" />
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
                <Feather name="headphones" size={15} color="#39FF14" />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* QR Code Modal (Host) */}
      <Modal visible={showQR} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Share this QR Code</Text>
            <Text style={styles.modalSubtitle}>Ask your partner to scan this</Text>

            {sessionId ? (
              <QRCodeDisplay sessionId={sessionId} />
            ) : (
              <ActivityIndicator color="#39FF14" size="large" style={{ marginVertical: 40 }} />
            )}

            <StatusBadge status={status} role="host" />

            {status === 'connected' && (
              <Text style={styles.connectedMsg}>Partner connected! Starting session…</Text>
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
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  scroll: { padding: 24, paddingBottom: 48 },
  topGlow: {
    position: 'absolute', top: -80, right: -80,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: '#39FF14', opacity: 0.05,
  },
  bottomGlow: {
    position: 'absolute', bottom: -80, left: -80,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: '#39FF14', opacity: 0.05,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8,
    paddingTop: Platform.OS === 'android' ? 20 : 8,
  },
  headerTitleContainer: {
    flexDirection: 'row', alignItems: 'center',
  },
  logoIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center', marginRight: 10,
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  titleGreen: { color: '#39FF14' },
  signOutBtn: {
    padding: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  profileBtn: {
    padding: 6,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 13, marginBottom: 28,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)',
    borderRadius: 12, padding: 12, marginBottom: 16,
  },
  errorText: { color: '#ef4444', fontSize: 13, flex: 1 },
  card: {
    backgroundColor: '#111',
    borderRadius: 20,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    padding: 20,
    marginBottom: 28,
  },
  cardTitle: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 2, marginBottom: 18,
  },
  divider: {
    height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: 16,
  },
  actions: { gap: 12 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: '#39FF14', borderRadius: 16,
    paddingVertical: 18, paddingHorizontal: 24,
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
  },
  primaryBtnText: { color: '#000', fontSize: 16, fontWeight: '800', letterSpacing: 0.5 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  orLine: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.07)' },
  orText: { color: 'rgba(255,255,255,0.25)', fontSize: 12 },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: 'rgba(57,255,20,0.08)',
    borderWidth: 1, borderColor: 'rgba(57,255,20,0.3)',
    borderRadius: 16, paddingVertical: 18, paddingHorizontal: 24,
  },
  secondaryBtnText: { color: '#39FF14', fontSize: 16, fontWeight: '700' },
  manualJoinRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  manualJoinInput: {
    flex: 1, color: '#fff', fontSize: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
  },
  manualJoinBtn: {
    backgroundColor: 'rgba(57,255,20,0.15)',
    borderWidth: 1, borderColor: 'rgba(57,255,20,0.3)',
    borderRadius: 12, paddingHorizontal: 20, justifyContent: 'center',
  },
  manualJoinBtnDisabled: { opacity: 0.4 },
  manualJoinBtnText: { color: '#39FF14', fontSize: 14, fontWeight: '700' },
  footer: {
    color: 'rgba(255,255,255,0.2)', fontSize: 11,
    textAlign: 'center', marginTop: 28, lineHeight: 17,
  },
  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#111',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
    padding: 28, alignItems: 'center', paddingBottom: 48,
  },
  modalTitle: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 4 },
  modalSubtitle: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginBottom: 20 },
  connectedMsg: {
    color: '#39FF14', fontSize: 13, fontWeight: '600',
    marginTop: 16, textAlign: 'center',
  },
  cancelBtn: {
    marginTop: 24,
    paddingHorizontal: 32, paddingVertical: 12,
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  cancelBtnText: { color: 'rgba(255,255,255,0.4)', fontSize: 14 },

  // Recent Conversations
  recentSection: { marginTop: 32 },
  recentHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  recentTitle: { color: 'rgba(255,255,255,0.3)', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginLeft: 6 },
  recentEmpty: { color: 'rgba(255,255,255,0.3)', fontSize: 13, textAlign: 'center', marginTop: 16 },
  convItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
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
    backgroundColor: 'rgba(57,255,20,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(57,255,20,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  convIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(57,255,20,0.1)',
    justifyContent: 'center', alignItems: 'center',
    marginRight: 14,
  },
  convLangs: { color: '#fff', fontSize: 14, fontWeight: '600' },
  convTime: { color: 'rgba(255,255,255,0.4)', fontSize: 11 },
  convPreview: { color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 4 },
});
