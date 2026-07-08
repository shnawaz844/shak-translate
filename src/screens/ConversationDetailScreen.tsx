import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WS_URL } from '../config';

interface ConversationDetailScreenProps {
  conversationId: string;
  myUserId: string;
  onBack: () => void;
}

interface Message {
  id: string;
  sender_user_id: string;
  role: string;
  original_text: string;
  translated_text: string;
  sent_at: string;
}

export function ConversationDetailScreen({ conversationId, myUserId, onBack }: ConversationDetailScreenProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const httpUrl = WS_URL.replace(/^ws(s)?:\/\//, 'http$1://');
    fetch(`${httpUrl}/conversations/${encodeURIComponent(conversationId)}/messages`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load messages');
        return r.json();
      })
      .then(data => {
        setMessages(data);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [conversationId]);

  const renderItem = ({ item }: { item: Message }) => {
    const isMe = item.sender_user_id === myUserId;

    return (
      <View style={[styles.messageRow, isMe ? styles.messageRowMe : styles.messageRowPartner]}>
        <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubblePartner]}>
          <Text style={styles.originalText}>{item.original_text}</Text>
          <View style={styles.divider} />
          <Text style={styles.translatedText}>{item.translated_text}</Text>
          <Text style={styles.timeText}>
            {new Date(item.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Feather name="arrow-left" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Conversation</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#39FF14" size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={40} color="#ef4444" style={{ marginBottom: 16 }} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No messages were sent in this session.</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? 20 : 10, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  backBtn: { padding: 8, marginLeft: -8 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorText: { color: '#ef4444', textAlign: 'center' },
  emptyText: { color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 60 },
  listContent: { padding: 20, paddingBottom: 40 },

  messageRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  messageRowMe: {
    justifyContent: 'flex-end',
  },
  messageRowPartner: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    padding: 14,
    borderRadius: 20,
  },
  bubbleMe: {
    backgroundColor: 'rgba(57,255,20,0.15)',
    borderBottomRightRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(57,255,20,0.3)',
  },
  bubblePartner: {
    backgroundColor: '#1A1A1A',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  originalText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    marginBottom: 8,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginBottom: 8,
  },
  translatedText: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 22,
  },
  timeText: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 10,
    alignSelf: 'flex-end',
    marginTop: 8,
  },
});
