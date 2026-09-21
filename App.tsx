import React, { useState, useEffect, useCallback } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ClerkProvider, SignedIn, SignedOut, useUser } from '@clerk/clerk-expo';
import { tokenCache } from './src/utils/tokenCache';
import { HomeScreen } from './src/screens/HomeScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { ConversationDetailScreen } from './src/screens/ConversationDetailScreen';
import { AudioRecordingsScreen } from './src/screens/AudioRecordingsScreen';
import { WebSocketProvider } from './src/contexts/WebSocketContext';
import * as WebBrowser from 'expo-web-browser';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';

// Keep the splash screen visible while we load async resources (Clerk auth).
// Without this the splash disappears immediately and shows a black screen
// while the JS bundle boots and Clerk validates the session.
SplashScreen.preventAutoHideAsync();

WebBrowser.maybeCompleteAuthSession();


type AppScreen = 'onboarding' | 'home' | 'session' | 'profile' | 'conversation' | 'recordings';

interface SessionParams {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
}

const publishableKey =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  'pk_test_cHJvcGVyLWphZ3Vhci04NS5jbGVyay5hY2NvdW50cy5kZXYk';

function MainApp() {
  const { user, isLoaded } = useUser();

  // isLoaded = Clerk has resolved auth state (signed in or out)
  const isOnboarded = !!(user?.unsafeMetadata as any)?.onboardingComplete;
  const [screen, setScreen] = useState<AppScreen>(isOnboarded ? 'home' : 'onboarding');
  const [sessionParams, setSessionParams] = useState<SessionParams | null>(null);
  const [activeConversation, setActiveConversation] = useState<{ id: string, myUserId: string } | null>(null);
  const [activeRecordings, setActiveRecordings] = useState<{ id: string, myUserId: string, myLang: string, partnerLang: string } | null>(null);

  const onLayoutRootView = useCallback(async () => {
    if (isLoaded) {
      // Clerk is done — hide the splash now that we have real content to show.
      await SplashScreen.hideAsync();
    }
  }, [isLoaded]);

  // While Clerk resolves the session, keep the splash up (preventAutoHideAsync
  // above). Return null so onLayoutRootView never fires until isLoaded=true.
  if (!isLoaded) return null;

  const handleSessionReady = (params: SessionParams) => {
    setSessionParams(params);
    setScreen('session');
  };

  const handleEndSession = () => {
    setSessionParams(null);
    setScreen('home');
  };

  return (
    <WebSocketProvider>
      <View style={{ flex: 1, backgroundColor: '#0A0A0A' }} onLayout={onLayoutRootView}>
      {screen === 'onboarding' && (
        <OnboardingScreen onComplete={() => setScreen('home')} />
      )}
      {screen === 'home' && (
        <HomeScreen
          onSessionReady={handleSessionReady}
          onOpenProfile={() => setScreen('profile')}
          onOpenConversation={(id, myUserId) => {
            setActiveConversation({ id, myUserId });
            setScreen('conversation');
          }}
          onOpenRecordings={(id, myUserId, myLang, partnerLang) => {
            setActiveRecordings({ id, myUserId, myLang, partnerLang });
            setScreen('recordings');
          }}
        />
      )}
      {screen === 'profile' && (
        <ProfileScreen onBack={() => setScreen('home')} />
      )}
      {screen === 'session' && sessionParams && (
        <SessionScreen
          sessionId={sessionParams.sessionId}
          role={sessionParams.role}
          myLang={sessionParams.myLang}
          partnerLang={sessionParams.partnerLang}
          onEnd={handleEndSession}
        />
      )}
      {screen === 'conversation' && activeConversation && (
        <ConversationDetailScreen
          conversationId={activeConversation.id}
          myUserId={activeConversation.myUserId}
          onBack={() => {
            setActiveConversation(null);
            setScreen('home');
          }}
        />
      )}
      {screen === 'recordings' && activeRecordings && (
        <AudioRecordingsScreen
          conversationId={activeRecordings.id}
          myUserId={activeRecordings.myUserId}
          myLang={activeRecordings.myLang}
          partnerLang={activeRecordings.partnerLang}
          onBack={() => {
            setActiveRecordings(null);
            setScreen('home');
          }}
        />
      )}
      </View>
    </WebSocketProvider>
  );
}

export default function App() {
  return (
    <View style={{ flex: 1, backgroundColor: '#0A0A0A' }}>
      <SafeAreaProvider>
        <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
          <StatusBar style="light" />
          <SignedIn>
            <MainApp />
          </SignedIn>
          <SignedOut>
            <AuthScreen />
          </SignedOut>
        </ClerkProvider>
      </SafeAreaProvider>
    </View>
  );
}
