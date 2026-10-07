import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Modal,
  FlatList,
  SafeAreaView,
  TextInput,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LANGUAGES } from '../config';

interface LanguageSelectorProps {
  label: string;
  selected: string;
  onSelect: (name: string) => void;
}

export function LanguageSelector({ label, selected, onSelect }: LanguageSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = LANGUAGES.filter((l) =>
    l.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = (name: string) => {
    onSelect(name);
    setOpen(false);
    setSearch('');
  };

  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      {/* Trigger */}
      <TouchableOpacity
        style={styles.trigger}
        onPress={() => setOpen(true)}
        activeOpacity={0.8}
      >
        <Text style={styles.triggerText}>{selected}</Text>
        <Feather name="chevron-down" size={18} color="rgba(255,255,255,0.4)" />
      </TouchableOpacity>

      {/* Dropdown Modal */}
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => { setOpen(false); setSearch(''); }}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={() => { setOpen(false); setSearch(''); }}
        />
        <SafeAreaView style={styles.sheet} pointerEvents="box-none">
          <View style={styles.sheetInner}>
            {/* Header */}
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Select Language</Text>
              <TouchableOpacity
                onPress={() => { setOpen(false); setSearch(''); }}
                style={styles.closeBtn}
              >
                <Feather name="x" size={20} color="rgba(255,255,255,0.5)" />
              </TouchableOpacity>
            </View>

            {/* Search */}
            <View style={styles.searchRow}>
              <Feather name="search" size={15} color="rgba(255,255,255,0.3)" style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search language…"
                placeholderTextColor="rgba(255,255,255,0.2)"
                value={search}
                onChangeText={setSearch}
                autoCorrect={false}
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')}>
                  <Feather name="x-circle" size={15} color="rgba(255,255,255,0.3)" />
                </TouchableOpacity>
              )}
            </View>

            {/* List */}
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.code}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const isSelected = item.name === selected;
                return (
                  <TouchableOpacity
                    style={[styles.option, isSelected && styles.optionSelected]}
                    onPress={() => handleSelect(item.name)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.optionText, isSelected && styles.optionTextSelected]}>
                      {item.name}
                    </Text>
                    {isSelected && (
                      <Feather name="check" size={16} color="#39FF14" />
                    )}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.emptyText}>No languages found</Text>
              }
            />
          </View>
        </SafeAreaView>
      </Modal>
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

  // Dropdown trigger button
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  triggerText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  // Modal backdrop
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },

  // Bottom sheet
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  sheetInner: {
    backgroundColor: '#141414',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingTop: 20,
    maxHeight: 480,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  sheetTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  closeBtn: {
    padding: 4,
  },

  // Search
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    padding: 0,
  },

  // List items
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  optionSelected: {
    backgroundColor: 'rgba(57,255,20,0.06)',
  },
  optionText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    fontWeight: '500',
  },
  optionTextSelected: {
    color: '#39FF14',
    fontWeight: '700',
  },
  emptyText: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 24,
  },
});
