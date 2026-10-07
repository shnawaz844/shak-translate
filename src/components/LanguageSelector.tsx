import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  FlatList,
  TextInput,
  Modal,
  TouchableWithoutFeedback,
  Dimensions,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LANGUAGES } from '../config';

interface LanguageSelectorProps {
  label?: string;
  selected: string;
  onSelect: (name: string) => void;
}

export function LanguageSelector({ label, selected, onSelect }: LanguageSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<View>(null);
  const [coords, setCoords] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const filtered = LANGUAGES.filter((l) =>
    l.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = (name: string) => {
    onSelect(name);
    setOpen(false);
    setSearch('');
  };

  const handleToggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (triggerRef.current) {
      triggerRef.current.measureInWindow((x, y, width, height) => {
        if (width > 0 && height > 0) {
          setCoords({ x, y, width, height });
        }
        setOpen(true);
        setSearch('');
      });
    } else {
      setOpen(true);
      setSearch('');
    }
  };

  const windowHeight = Dimensions.get('window').height;
  const maxListHeight = coords
    ? Math.max(140, Math.min(220, windowHeight - coords.y - coords.height - 100))
    : 220;

  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      {/* Trigger button anchored in the document layout */}
      <View ref={triggerRef} collapsable={false}>
        <TouchableOpacity
          style={[styles.trigger, open && styles.triggerOpen]}
          onPress={handleToggle}
          activeOpacity={0.8}
        >
          <Text style={styles.triggerText}>{selected}</Text>
          <Feather
            name={open ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={open ? '#39FF14' : 'rgba(255,255,255,0.4)'}
          />
        </TouchableOpacity>
      </View>

      {/* Floating overlay dropdown so the rest of the layout never shifts */}
      <Modal
        visible={open}
        transparent={true}
        animationType="none"
        onRequestClose={() => setOpen(false)}
      >
        <TouchableWithoutFeedback onPress={() => setOpen(false)}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>

        {coords && (
          <View
            style={[
              styles.floatingContainer,
              {
                position: 'absolute',
                top: coords.y,
                left: coords.x,
                width: coords.width,
              },
            ]}
          >
            {/* Active Trigger Header in overlay */}
            <TouchableOpacity
              style={[styles.trigger, styles.triggerOpen]}
              onPress={() => setOpen(false)}
              activeOpacity={0.8}
            >
              <Text style={styles.triggerText}>{selected}</Text>
              <Feather
                name="chevron-up"
                size={18}
                color="#39FF14"
              />
            </TouchableOpacity>

            {/* Dropdown panel floating directly over the layout below */}
            <View style={styles.panel}>
              {/* Search bar */}
              <View style={styles.searchRow}>
                <Feather name="search" size={14} color="rgba(255,255,255,0.3)" style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search language…"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={search}
                  onChangeText={setSearch}
                  autoCorrect={false}
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => setSearch('')}>
                    <Feather name="x-circle" size={14} color="rgba(255,255,255,0.3)" />
                  </TouchableOpacity>
                )}
              </View>

              {/* Language list */}
              <FlatList
                data={filtered}
                keyExtractor={(item) => item.code}
                showsVerticalScrollIndicator={true}
                keyboardShouldPersistTaps="handled"
                style={[styles.list, { maxHeight: maxListHeight }]}
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
                        <Feather name="check" size={15} color="#39FF14" />
                      )}
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={
                  <Text style={styles.emptyText}>No languages found</Text>
                }
              />
            </View>
          </View>
        )}
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

  // Trigger
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
  triggerOpen: {
    borderColor: '#39FF14',
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomWidth: 0,
  },
  triggerText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  // Modal backdrop & floating container
  modalBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  floatingContainer: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 25,
  },

  // Floating dropdown panel
  panel: {
    backgroundColor: '#161c1a',
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: '#39FF14',
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    overflow: 'hidden',
  },

  // Search
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    color: '#fff',
    fontSize: 13,
    padding: 0,
  },

  // List
  list: {
    maxHeight: 220,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  optionSelected: {
    backgroundColor: 'rgba(57,255,20,0.07)',
  },
  optionText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    fontWeight: '500',
  },
  optionTextSelected: {
    color: '#39FF14',
    fontWeight: '700',
  },
  emptyText: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
  },
});
