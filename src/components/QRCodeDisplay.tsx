import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

interface QRCodeDisplayProps {
  sessionId: string;
}

export function QRCodeDisplay({ sessionId }: QRCodeDisplayProps) {
  const qrValue = JSON.stringify({ s: sessionId });
  return (
    <View style={styles.container}>
      <Text style={styles.label}>SCAN TO JOIN</Text>
      <View style={styles.qrBox}>
        <QRCode
          value={qrValue}
          size={180}
          backgroundColor="#1A1A1A"
          color="#39FF14"
        />
      </View>
      <Text style={styles.sessionId} numberOfLines={1} ellipsizeMode="middle">
        {sessionId}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  label: {
    color: '#39FF14',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 2,
    marginBottom: 16,
  },
  qrBox: {
    padding: 16,
    backgroundColor: '#1A1A1A',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(57,255,20,0.3)',
  },
  sessionId: {
    marginTop: 12,
    color: 'rgba(255,255,255,0.25)',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    maxWidth: 240,
  },
});
