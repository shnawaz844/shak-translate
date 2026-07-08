import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { ConnectionStatus } from '../hooks/useWebSocket';

interface StatusBadgeProps {
  status: ConnectionStatus;
  role?: 'host' | 'guest' | null;
}

const STATUS_CONFIG: Record<
  ConnectionStatus,
  { label: string; color: string; bg: string }
> = {
  idle:         { label: 'IDLE',         color: 'rgba(255,255,255,0.4)', bg: 'rgba(255,255,255,0.05)' },
  connecting:   { label: 'CONNECTING…',  color: '#f59e0b',               bg: 'rgba(245,158,11,0.1)' },
  waiting:      { label: 'WAITING…',     color: '#f59e0b',               bg: 'rgba(245,158,11,0.1)' },
  connected:    { label: 'CONNECTED',    color: '#39FF14',               bg: 'rgba(57,255,20,0.1)' },
  disconnected: { label: 'DISCONNECTED', color: '#ef4444',               bg: 'rgba(239,68,68,0.1)' },
  error:        { label: 'ERROR',        color: '#ef4444',               bg: 'rgba(239,68,68,0.1)' },
};

export function StatusBadge({ status, role }: StatusBadgeProps) {
  const cfg = STATUS_CONFIG[status];
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg, borderColor: cfg.color + '40' }]}>
      <View style={[styles.dot, { backgroundColor: cfg.color }]} />
      <Text style={[styles.text, { color: cfg.color }]}>
        {cfg.label}{role ? `  ·  ${role.toUpperCase()}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  text: {
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontWeight: '700',
    letterSpacing: 1,
  },
});
