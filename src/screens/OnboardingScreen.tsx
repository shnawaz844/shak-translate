import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  ActivityIndicator,
  PanResponder,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useUser, useAuth } from '@clerk/clerk-expo';
import { API_URL } from '../config';
import { Alert } from '../utils/alertCompat';

// ─── Constants ────────────────────────────────────────────────────────────────

export type Gender = 'male' | 'female' | 'neutral';

const MIN_AGE = 10;
const MAX_AGE = 90;

const GENDER_OPTIONS: { value: Gender; label: string; icon: string }[] = [
  { value: 'female', label: 'Female', icon: '♀' },
  { value: 'male', label: 'Male', icon: '♂' },
  { value: 'neutral', label: 'Prefer not to say', icon: '◈' },
];

// ─── Props ────────────────────────────────────────────────────────────────────

interface OnboardingScreenProps {
  onComplete: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const { user } = useUser();
  const { getToken } = useAuth();

  const [age, setAge] = useState(25);
  const [gender, setGender] = useState<Gender | null>(null);
  const [loading, setLoading] = useState(false);

  // ── Age slider helpers ───────────────────────────────────────────────────

  const agePercent = (age - MIN_AGE) / (MAX_AGE - MIN_AGE);
  const TRACK_WIDTH = 280; // logical px — matches styles.track width
  const THUMB_SIZE = 28;
  const thumbLeft = agePercent * (TRACK_WIDTH - THUMB_SIZE);

  const currentAgeRef = React.useRef(age);
  currentAgeRef.current = age;

  const startAgeRef = React.useRef(age);

  const panResponder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        // Establish the starting age for the drag from the latest current age
        startAgeRef.current = currentAgeRef.current;
      },
      onPanResponderMove: (evt, gestureState) => {
        const deltaPercent = gestureState.dx / TRACK_WIDTH;
        const deltaAge = Math.round(deltaPercent * (MAX_AGE - MIN_AGE));
        let newAge = startAgeRef.current + deltaAge;
        if (newAge < MIN_AGE) newAge = MIN_AGE;
        if (newAge > MAX_AGE) newAge = MAX_AGE;
        setAge(newAge);
      },
    })
  ).current;

  // Increment / Decrement buttons as the slider substitute
  const decAge = () => setAge((a) => Math.max(MIN_AGE, a - 1));
  const incAge = () => setAge((a) => Math.min(MAX_AGE, a + 1));

  // Long-press for fast scroll
  const fastDec = () => setAge((a) => Math.max(MIN_AGE, a - 5));
  const fastInc = () => setAge((a) => Math.min(MAX_AGE, a + 5));

  // ── Submit ───────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!gender) {
      Alert.alert('Please select your gender', 'Choose one of the options above to continue.');
      return;
    }
    if (!user) return;

    try {
      setLoading(true);

      // unsafeMetadata is writable directly by the signed-in user, so this
      // doesn't depend on the backend having a Clerk secret key configured.
      await user.update({ unsafeMetadata: { age, gender, onboardingComplete: true } });

      // Best-effort sync to backend/publicMetadata for server-side use
      // (e.g. if CLERK_SECRET_KEY is configured); failure here is non-fatal.
      try {
        const token = await getToken();
        if (token) {
          await fetch(`${API_URL}/clerk/update-profile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ age, gender }),
          });
        }
      } catch (syncErr: any) {
        console.warn('[Onboarding] Backend profile sync failed (non-fatal):', syncErr?.message);
      }

      onComplete();
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [age, gender, user, getToken, onComplete]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.glowTop} />
      <View style={styles.glowBottom} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.logoIcon}>
            <Feather name="mic" size={28} color="#000" />
          </View>
          <Text style={styles.title}>
            One quick step<Text style={styles.titleGreen}>.</Text>
          </Text>
          <Text style={styles.subtitle}>
            We'll match your translation voice to your age and gender so conversations
            feel natural for whoever you're speaking with.
          </Text>
        </View>

        {/* ── Gender Selector ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>GENDER</Text>
          <View style={styles.pillRow}>
            {GENDER_OPTIONS.map((opt) => {
              const active = gender === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.pill, active && styles.pillActive]}
                  onPress={() => setGender(opt.value)}
                  activeOpacity={0.75}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.pillIcon, active && styles.pillIconActive]}>
                    {opt.icon}
                  </Text>
                  <Text style={[styles.pillLabel, active && styles.pillLabelActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── Age Picker ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>AGE</Text>

          {/* Big age display */}
          <View style={styles.ageDisplay}>
            <Text style={styles.ageNumber}>{age}</Text>
            <Text style={styles.ageUnit}>years old</Text>
          </View>

          {/* Visual track */}
          <View style={styles.trackContainer} {...panResponder.panHandlers}>
            <View style={styles.track}>
              {/* Filled portion */}
              <View style={[styles.trackFill, { width: `${agePercent * 100}%` }]} />
              {/* Thumb indicator */}
              <View style={[styles.trackThumb, { left: thumbLeft }]} />
            </View>
            <View style={styles.trackLabels}>
              <Text style={styles.trackLabel}>{MIN_AGE}</Text>
              <Text style={styles.trackLabel}>{MAX_AGE}</Text>
            </View>
          </View>


        </View>

        {/* ── Privacy note ── */}
        <View style={styles.privacyRow}>
          <Feather name="lock" size={12} color="rgba(255,255,255,0.25)" />
          <Text style={styles.privacyText}>
            This info is stored securely in your account and only used to adapt your voice output.
          </Text>
        </View>

        {/* ── CTA ── */}
        <TouchableOpacity
          style={[styles.ctaBtn, (!gender || loading) && styles.ctaBtnDisabled]}
          onPress={handleSubmit}
          disabled={!gender || loading}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Continue to the app"
        >
          {loading ? (
            <ActivityIndicator color="#000" size="small" />
          ) : (
            <>
              <Text style={styles.ctaBtnText}>Let's Go</Text>
              <Feather name="arrow-right" size={18} color="#000" />
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const TRACK_WIDTH = 280;
const THUMB_SIZE = 28;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  glowTop: {
    position: 'absolute', top: -120, right: -80,
    width: 320, height: 320, borderRadius: 160,
    backgroundColor: '#39FF14', opacity: 0.05,
  },
  glowBottom: {
    position: 'absolute', bottom: -100, left: -80,
    width: 280, height: 280, borderRadius: 140,
    backgroundColor: '#39FF14', opacity: 0.04,
  },
  scroll: {
    padding: 28,
    paddingBottom: 56,
    flexGrow: 1,
    justifyContent: 'center',
  },

  // Header
  header: { alignItems: 'center', marginBottom: 40 },
  logoIcon: {
    width: 64, height: 64, borderRadius: 20,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4, shadowRadius: 20, elevation: 10,
  },
  title: {
    color: '#fff', fontSize: 32, fontWeight: '800', letterSpacing: -0.5,
    textAlign: 'center',
  },
  titleGreen: { color: '#39FF14' },
  subtitle: {
    color: 'rgba(255,255,255,0.4)', fontSize: 14, textAlign: 'center',
    lineHeight: 20, marginTop: 10, maxWidth: 320,
  },

  // Section
  section: {
    backgroundColor: '#111',
    borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    padding: 20, marginBottom: 16,
  },
  sectionLabel: {
    color: 'rgba(255,255,255,0.3)', fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 2.5, marginBottom: 16,
  },

  // Gender pills
  pillRow: { flexDirection: 'row', gap: 10 },
  pill: {
    flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    gap: 4,
  },
  pillActive: {
    backgroundColor: 'rgba(57,255,20,0.1)',
    borderColor: '#39FF14',
  },
  pillIcon: {
    fontSize: 18, color: 'rgba(255,255,255,0.4)',
  },
  pillIconActive: { color: '#39FF14' },
  pillLabel: {
    color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '600', textAlign: 'center',
  },
  pillLabelActive: { color: '#39FF14' },

  // Age display
  ageDisplay: { alignItems: 'center', marginBottom: 24 },
  ageNumber: {
    color: '#fff', fontSize: 64, fontWeight: '800', letterSpacing: -2, lineHeight: 72,
  },
  ageUnit: { color: 'rgba(255,255,255,0.3)', fontSize: 13, fontWeight: '500', marginTop: -4 },

  // Track
  trackContainer: { alignItems: 'center', marginBottom: 20, paddingVertical: 16 },
  track: {
    width: TRACK_WIDTH, height: 6, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    position: 'relative', overflow: 'visible',
  },
  trackFill: {
    height: 6, borderRadius: 3, backgroundColor: '#39FF14',
    shadowColor: '#39FF14', shadowOpacity: 0.5, shadowRadius: 6, elevation: 3,
  },
  trackThumb: {
    position: 'absolute',
    top: -(THUMB_SIZE / 2 - 3),
    width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#39FF14',
    borderWidth: 3, borderColor: '#0A0A0A',
    shadowColor: '#39FF14', shadowOpacity: 0.6, shadowRadius: 8, elevation: 5,
  },
  trackLabels: {
    flexDirection: 'row', justifyContent: 'space-between',
    width: TRACK_WIDTH, marginTop: 10,
  },
  trackLabel: { color: 'rgba(255,255,255,0.2)', fontSize: 11 },

  // Stepper
  stepperRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  stepperBtn: {
    width: 52, height: 52, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', alignItems: 'center',
  },
  stepperMiddle: { flex: 1, alignItems: 'center' },
  stepperHint: {
    color: 'rgba(255,255,255,0.2)', fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 0.5,
  },

  // Privacy
  privacyRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    marginBottom: 24, paddingHorizontal: 4,
  },
  privacyText: {
    color: 'rgba(255,255,255,0.2)', fontSize: 11, flex: 1, lineHeight: 16,
  },

  // CTA
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: '#39FF14', borderRadius: 18, height: 60,
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4, shadowRadius: 14, elevation: 6,
  },
  ctaBtnDisabled: { opacity: 0.4, shadowOpacity: 0 },
  ctaBtnText: { color: '#000', fontSize: 17, fontWeight: '800' },
});
