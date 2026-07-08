import React from 'react';
import {
  ScrollView,
  TouchableOpacity,
  Text,
  View,
  StyleSheet,
  Platform,
} from 'react-native';
import { LANGUAGES } from '../config';

interface LanguageSelectorProps {
  label: string;
  selected: string;
  onSelect: (name: string) => void;
}

export function LanguageSelector({ label, selected, onSelect }: LanguageSelectorProps) {
  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {LANGUAGES.map((lang) => {
          const isSelected = selected === lang.name;
          return (
            <TouchableOpacity
              key={lang.code}
              style={[styles.pill, isSelected && styles.pillSelected]}
              onPress={() => onSelect(lang.name)}
              activeOpacity={0.75}
            >
              <Text style={[styles.pillText, isSelected && styles.pillTextSelected]}>
                {lang.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: 8,
  },
  label: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  row: {
    paddingHorizontal: 4,
    paddingBottom: 4,
    alignItems: 'center',
  },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginRight: 8,
  },
  pillSelected: {
    backgroundColor: '#39FF14',
    borderColor: '#39FF14',
  },
  pillText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    fontWeight: '600',
  },
  pillTextSelected: {
    color: '#000',
  },
});
