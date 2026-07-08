import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, FontAwesome } from '@expo/vector-icons';
import { useSignIn, useSignUp, useOAuth } from '@clerk/clerk-expo';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
WebBrowser.maybeCompleteAuthSession();





export function AuthScreen() {

  const { signIn, setActive: setSignInActive, isLoaded: isSignInLoaded } = useSignIn();
  const { signUp, setActive: setSignUpActive, isLoaded: isSignUpLoaded } = useSignUp();

  const { startOAuthFlow: startGoogleFlow } = useOAuth({ strategy: 'oauth_google' });
  const { startOAuthFlow: startAppleFlow } = useOAuth({ strategy: 'oauth_apple' });

  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [pendingVerification, setPendingVerification] = useState(false);
  const [flowType, setFlowType] = useState<'signIn' | 'signUp' | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleOAuth = useCallback(async (strategy: 'google' | 'apple') => {
    try {
      setLoading(true);
      setErrorMsg(null);

      const startFlow = strategy === 'google' ? startGoogleFlow : startAppleFlow;
      const redirectUrl = Linking.createURL('/oauth-callback');

      const result = await startFlow({ redirectUrl });
      const { createdSessionId, setActive, signIn, signUp } = result;

      if (createdSessionId) {
        await setActive!({ session: createdSessionId });
      } else if (signIn || signUp) {
        setErrorMsg('Additional setup required.');
      } else {
        setErrorMsg('Sign in was cancelled.');
      }
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message ?? err?.message ?? 'OAuth failed';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }, [startGoogleFlow, startAppleFlow]);

  const handleContinue = async () => {
    if (!isSignInLoaded || !isSignUpLoaded) return;
    if (!signIn || !signUp) {
      setErrorMsg('Auth not ready. Please restart the app.');
      return;
    }
    if (!identifier.trim()) {
      setErrorMsg('Please enter your email');
      return;
    }

    try {
      setLoading(true);
      setErrorMsg(null);

      const strategy = 'email_code';

      // 1. Try to sign in first
      try {
        const { supportedFirstFactors } = await signIn.create({ identifier });

        const factor: any = supportedFirstFactors?.find((f: any) => f.strategy === strategy);

        if (factor) {
          await signIn.prepareFirstFactor({
            strategy,
            emailAddressId: factor.emailAddressId,
          });
          setFlowType('signIn');
          setPendingVerification(true);
        } else {
          setErrorMsg(`Please sign in with a different method.`);
        }
      } catch (signInErr: any) {
        // If user not found, catch and start signUp
        if (signInErr.errors?.[0]?.code === 'form_identifier_not_found') {
          await signUp.create({
            emailAddress: identifier,
          });

          await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });

          setFlowType('signUp');
          setPendingVerification(true);
        } else {
          throw signInErr;
        }
      }
    } catch (err: any) {
      console.error('Continue error', err);
      setErrorMsg(err.errors?.[0]?.longMessage || err.errors?.[0]?.message || 'An error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!isSignInLoaded || !isSignUpLoaded) return;
    if (!code) {
      setErrorMsg('Please enter the verification code');
      return;
    }

    try {
      setLoading(true);
      setErrorMsg(null);

      if (flowType === 'signIn') {
        const result = await signIn.attemptFirstFactor({
          strategy: 'email_code',
          code,
        });

        if (result.status === 'complete') {
          await setSignInActive({ session: result.createdSessionId });
        } else {
          console.log('SignIn incomplete status:', result.status);
          setErrorMsg(`Additional steps required: ${result.status}. Check Clerk dashboard settings.`);
        }
      } else if (flowType === 'signUp') {
        const result = await signUp.attemptEmailAddressVerification({ code });

        if (result.status === 'complete') {
          await setSignUpActive({ session: result.createdSessionId });
        } else {
          console.log('SignUp incomplete status:', result.status);
          setErrorMsg(`Additional steps required: ${result.status}. Check Clerk dashboard settings.`);
        }
      }
    } catch (err: any) {
      console.error('Verify error', JSON.stringify(err, null, 2));
      setErrorMsg(err.errors?.[0]?.longMessage || err.errors?.[0]?.message || 'Invalid code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topGlow} />
      <View style={styles.bottomGlow} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.logoIcon}>
              <Feather name="globe" size={32} color="#000" />
            </View>
            <Text style={styles.title}>
              Shak<Text style={styles.titleGreen}>Translate</Text>
            </Text>
            <Text style={styles.subtitle}>Sign in or create an account to continue</Text>
          </View>

          {errorMsg && (
            <View style={styles.errorBox}>
              <Feather name="alert-circle" size={14} color="#ef4444" />
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          )}

          {!pendingVerification ? (
            <>
              {/* OAuth Buttons */}
              <View style={styles.oauthContainer}>
                <TouchableOpacity
                  style={styles.oauthBtn}
                  onPress={() => handleOAuth('google')}
                  disabled={loading}
                >
                  <FontAwesome name="google" size={20} color="#fff" />
                  <Text style={styles.oauthBtnText}>Continue with Google</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.oauthBtn, { marginTop: 12 }]}
                  onPress={() => handleOAuth('apple')}
                  disabled={loading}
                >
                  <FontAwesome name="apple" size={20} color="#fff" />
                  <Text style={styles.oauthBtnText}>Continue with Apple</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.orRow}>
                <View style={styles.orLine} />
                <Text style={styles.orText}>OR</Text>
                <View style={styles.orLine} />
              </View>

              {/* Input */}
              <View style={styles.inputContainer}>
                <Feather
                  name="mail"
                  size={20}
                  color="rgba(255,255,255,0.4)"
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your email"
                  placeholderTextColor="rgba(255,255,255,0.2)"
                  value={identifier}
                  onChangeText={setIdentifier}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              {/* Continue Button */}
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={handleContinue}
                disabled={loading}
                activeOpacity={0.8}
              >
                {loading ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <Text style={styles.primaryBtnText}>Continue</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            // Verification Code Flow
            <View style={styles.verifyContainer}>
              <Text style={styles.verifyText}>
                We sent a code to <Text style={styles.verifyIdentifier}>{identifier}</Text>
              </Text>

              <View style={styles.inputContainer}>
                <Feather name="lock" size={20} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter verification code"
                  placeholderTextColor="rgba(255,255,255,0.2)"
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={handleVerify}
                disabled={loading}
                activeOpacity={0.8}
              >
                {loading ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <Text style={styles.primaryBtnText}>Verify Code</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.backBtn}
                onPress={() => { setPendingVerification(false); setCode(''); setErrorMsg(null); }}
                disabled={loading}
              >
                <Text style={styles.backBtnText}>Back to Sign In</Text>
              </TouchableOpacity>
            </View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  keyboardView: { flex: 1 },
  scroll: { padding: 24, flexGrow: 1, justifyContent: 'center' },
  topGlow: {
    position: 'absolute', top: -100, right: -100,
    width: 300, height: 300, borderRadius: 150,
    backgroundColor: '#39FF14', opacity: 0.05,
  },
  bottomGlow: {
    position: 'absolute', bottom: -100, left: -100,
    width: 300, height: 300, borderRadius: 150,
    backgroundColor: '#39FF14', opacity: 0.05,
  },
  header: { alignItems: 'center', marginBottom: 40 },
  logoIcon: {
    width: 64, height: 64, borderRadius: 18,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center', marginBottom: 16,
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  title: { color: '#fff', fontSize: 32, fontWeight: '800', letterSpacing: -1 },
  titleGreen: { color: '#39FF14' },
  subtitle: {
    color: 'rgba(255,255,255,0.4)', fontSize: 14, marginTop: 8,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)',
    borderRadius: 12, padding: 12, marginBottom: 24,
  },
  errorText: { color: '#ef4444', fontSize: 13, flex: 1 },
  oauthContainer: { marginBottom: 24 },
  oauthBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
    backgroundColor: '#111', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 16, paddingVertical: 16,
  },
  oauthBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 24 },
  orLine: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.07)' },
  orText: { color: 'rgba(255,255,255,0.25)', fontSize: 12, fontWeight: '600' },
  toggleContainer: {
    flexDirection: 'row', backgroundColor: '#111',
    borderRadius: 12, padding: 4, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)'
  },
  toggleBtn: {
    flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 10,
  },
  toggleBtnActive: { backgroundColor: 'rgba(57,255,20,0.1)' },
  toggleBtnText: { color: 'rgba(255,255,255,0.4)', fontSize: 14, fontWeight: '600' },
  toggleBtnTextActive: { color: '#39FF14' },
  inputContainer: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 16, paddingHorizontal: 16, height: 56, marginBottom: 24,
  },
  inputIcon: { marginRight: 12 },
  input: { flex: 1, color: '#fff', fontSize: 16 },
  primaryBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#39FF14', borderRadius: 16,
    height: 56,
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
  },
  primaryBtnText: { color: '#000', fontSize: 16, fontWeight: '800' },
  verifyContainer: { marginTop: 8 },
  verifyText: { color: 'rgba(255,255,255,0.7)', fontSize: 15, textAlign: 'center', marginBottom: 24, lineHeight: 22 },
  verifyIdentifier: { color: '#fff', fontWeight: '700' },
  backBtn: { marginTop: 24, alignItems: 'center' },
  backBtnText: { color: 'rgba(255,255,255,0.4)', fontSize: 14, fontWeight: '600' },
});
