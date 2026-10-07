import React, { useState, useEffect } from 'react';
import { View, Image } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { APP_OPENING_SCREEN } from './src/config';
import { ClerkProvider, useAuth, useUser } from '@clerk/clerk-expo';
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
  const { user } = useUser();
  const isOnboarded = !!(user?.unsafeMetadata as any)?.onboardingComplete;
  const [screen, setScreen] = useState<AppScreen>(isOnboarded ? 'home' : 'onboarding');
  const [sessionParams, setSessionParams] = useState<SessionParams | null>(null);
  const [activeConversation, setActiveConversation] = useState<{ id: string, myUserId: string } | null>(null);
  const [activeRecordings, setActiveRecordings] = useState<{ id: string, myUserId: string, myLang: string, partnerLang: string } | null>(null);

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
      <View style={{ flex: 1, backgroundColor: '#0A0A0A' }}>
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

function AppNavigator({ openingFinished }: { openingFinished: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !openingFinished) {
    return (
      <View style={{ flex: 1, backgroundColor: '#182527', width: '100%', height: '100%' }}>
        <StatusBar hidden={true} />
        <Image
          source={APP_OPENING_SCREEN}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
        />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" hidden={false} />
      {isSignedIn ? <MainApp /> : <AuthScreen />}
    </>
  );
}

export default function App() {
  const [openingFinished, setOpeningFinished] = useState(false);

  useEffect(() => {
    // Immediately hide Android's native splash screen so our full-screen startup image displays
    void SplashScreen.hideAsync().catch(() => {});

    // Keep the branded full-screen startup poster visible for 2.5 seconds
    const timer = setTimeout(() => {
      setOpeningFinished(true);
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#182527' }}>
      <SafeAreaProvider>
        <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
          <AppNavigator openingFinished={openingFinished} />
        </ClerkProvider>
      </SafeAreaProvider>
      {!openingFinished && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100%',
            height: '100%',
            backgroundColor: '#182527',
            zIndex: 99999,
          }}
          pointerEvents="none"
        >
          <StatusBar hidden={true} />
          <Image
            source={APP_OPENING_SCREEN}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        </View>
      )}
    </View>
  );
}
