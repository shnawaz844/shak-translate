import React, { useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { useWebSocket } from '../hooks/useWebSocket';
import { useWebRTCCall } from '../hooks/useWebRTCCall';
import { StatusBadge } from '../components/StatusBadge';
import { Alert } from '../utils/alertCompat';

interface SessionScreenProps {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
  onEnd: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAIN VOICE CALL (AI translation temporarily bypassed — see backend/server.js
// AI_TRANSLATION_ENABLED). This validates call quality/latency using a real
// peer-to-peer WebRTC connection before layering translation back on top.
// ═══════════════════════════════════════════════════════════════════════════

export function SessionScreen({ sessionId, role, myLang, partnerLang, onEnd }: SessionScreenProps) {
  const { status, endSession } = useWebSocket({
    onPartnerDisconnected: () => {
      Alert.alert('Partner Disconnected', 'Your partner has left the call.', [{ text: 'OK', onPress: onEnd }]);
    },
    onError: (msg: string) => {
      Alert.alert('Error', msg);
    },
  });

  const { callStatus, isMuted, toggleMute, endCall, micError } = useWebRTCCall({
    enabled: status === 'connected',
    role,
    sessionId,
  });

  useEffect(() => {
    if (micError) Alert.alert('Microphone Error', micError);
  }, [micError]);

  const handleEnd = () => {
    Alert.alert('End Call', 'Are you sure you want to end this call?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End',
        style: 'destructive',
        onPress: () => {
          endCall();
          endSession(role, sessionId);
          onEnd();
        },
      },
    ]);
  };

  const statusLabel =
    status !== 'connected' ? 'Waiting for partner…'
    : callStatus === 'connecting' ? 'Connecting call…'
    : callStatus === 'connected' ? 'Call connected'
    : callStatus === 'failed' ? 'Call failed to connect'
    : 'Call ended';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topGlow} />

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

      <View style={styles.mainContent}>
        <View style={styles.callPanel}>
          <View style={[styles.callIcon, callStatus === 'connected' && styles.callIconActive]}>
            <Feather name="phone" size={32} color={callStatus === 'connected' ? '#000' : '#39FF14'} />
          </View>
          <Text style={styles.statusLabel}>{statusLabel}</Text>
          {callStatus === 'connected' && (
            <Text style={styles.hintText}>Talk naturally — this is a direct call, no AI in the loop right now.</Text>
          )}
        </View>
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.micBtn, isMuted && styles.micBtnMuted]}
          onPress={toggleMute}
          disabled={callStatus !== 'connected'}
          activeOpacity={0.8}
        >
          <Feather name={isMuted ? 'mic-off' : 'mic'} size={32} color={isMuted ? '#fff' : '#000'} />
        </TouchableOpacity>
        <Text style={styles.micHint}>
          {callStatus !== 'connected' ? 'Please wait…' : isMuted ? 'Tap to Unmute' : 'Tap to Mute'}
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
  mainContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  callPanel: { alignItems: 'center', gap: 16 },
  callIcon: {
    width: 96, height: 96, borderRadius: 48,
    borderWidth: 2, borderColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center',
  },
  callIconActive: { backgroundColor: '#39FF14' },
  statusLabel: { color: '#fff', fontSize: 18, fontWeight: '700' },
  hintText: { color: 'rgba(255,255,255,0.4)', fontSize: 13, textAlign: 'center', lineHeight: 18 },
  controls: {
    alignItems: 'center',
    paddingTop: 20, paddingBottom: Platform.OS === 'ios' ? 24 : 40,
    borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  micBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 12,
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4, shadowRadius: 12, elevation: 6,
  },
  micBtnMuted: { backgroundColor: '#ef4444', shadowColor: '#ef4444' },
  micHint: {
    color: 'rgba(255,255,255,0.25)', fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 0.5,
  },
});
