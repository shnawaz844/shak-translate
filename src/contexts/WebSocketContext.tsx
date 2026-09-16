import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { websocketService } from '../services/websocketService';
import { WS_URL } from '../config';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface TranslatedAudioPayload {
  audioBase64: string;
  mimeType: string;
  originalText: string;
  translatedText: string;
}

export interface TranslatedAudioChunkPayload {
  audioBase64: string;
  mimeType: string;
  index: number;
  text: string;
  turnId?: string;
}

interface WebSocketContextType {
  status: ConnectionStatus;
  sessionId: string | null;
  partnerLang: string | null;
  isProcessing: boolean;
  queueDepth: number;
  createSession: (lang: string, userId?: string, speakerGender?: string, speakerAge?: number) => Promise<void>;
  joinSession: (sid: string, lang: string, userId?: string, speakerGender?: string, speakerAge?: number) => Promise<void>;
  sendAudioStreamChunk: (
    audioBase64: string,
    mimeType: string,
    role: string,
    sid: string
  ) => void;
  sendPauseQueue: (role: string, sid: string) => void;
  sendResumeQueue: (role: string, sid: string) => void;
  sendCancelQueue: (role: string, sid: string) => void; // kept for compat
  claimTurn: (role: string, sid: string, confidence?: number) => void;
  releaseTurn: (role: string, sid: string) => void;
  endSession: (role: string, sid: string) => void;
  sendWebRTCOffer: (sdp: any, role: string, sid: string) => void;
  sendWebRTCAnswer: (sdp: any, role: string, sid: string) => void;
  sendWebRTCIceCandidate: (candidate: any, role: string, sid: string) => void;
  sendWebRTCReady: (role: string, sid: string) => void;
  registerCallbacks: (id: string, callbacks: WebSocketCallbacks) => void;
  unregisterCallbacks: (id: string) => void;
}

interface WebSocketCallbacks {
  onTranslatedAudio?: (payload: TranslatedAudioPayload) => void;
  onTranslatedAudioChunk?: (payload: TranslatedAudioChunkPayload) => void;
  onTranslatedAudioFinal?: (originalText: string, translatedText: string, audioBase64?: string) => void;
  onTranscript?: (originalText: string, translatedText: string) => void;
  onPartnerDisconnected?: () => void;
  onError?: (message: string) => void;
  onPartnerSpeaking?: () => void;
  onTurnRejected?: () => void;
  onLockReleased?: () => void;
  onQueueResumed?: () => void;
  onSessionReadyEvent?: (partnerLang: string) => void;
  onWebRTCOffer?: (sdp: any) => void;
  onWebRTCAnswer?: (sdp: any) => void;
  onWebRTCIceCandidate?: (candidate: any) => void;
  onWebRTCReady?: () => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [partnerLang, setPartnerLang] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  // How many of the local user's sentences are queued server-side waiting to process
  const [queueDepth, setQueueDepth] = useState(0);

  // Map of registered callbacks from various screens/components
  const callbacksMap = useRef<Map<string, WebSocketCallbacks>>(new Map());

  const registerCallbacks = useCallback((id: string, callbacks: WebSocketCallbacks) => {
    callbacksMap.current.set(id, callbacks);
  }, []);

  const unregisterCallbacks = useCallback((id: string) => {
    callbacksMap.current.delete(id);
  }, []);

  const handleMessage = useCallback((message: Record<string, any>) => {
    const { type } = message;

    if (type === 'session_created') {
      setSessionId(message.sessionId);
      setStatus('waiting');
    }

    if (type === 'session_ready') {
      setStatus('connected');
      if (message.partnerLang) {
        setPartnerLang(message.partnerLang);
        callbacksMap.current.forEach(c => c.onSessionReadyEvent?.(message.partnerLang));
      }
    }

    if (type === 'processing_started') {
      setIsProcessing(true);
      console.log(`[LATENCY][client] processing_started received (turnId=${message.turnId}) at ${Date.now()}`);
    }

    if (type === 'processing_done') {
      setIsProcessing(false);
    }

    // Server reports how many of our sentences are still in the queue
    if (type === 'queue_depth') {
      setQueueDepth(message.depth ?? 0);
    }

    // Distribute messages to all registered listeners
    callbacksMap.current.forEach((callbacks) => {
      if (type === 'translated_audio') {
        callbacks.onTranslatedAudio?.({
          audioBase64: message.audioBase64,
          mimeType: message.mimeType,
          originalText: message.originalText,
          translatedText: message.translatedText,
        });
      }

      if (type === 'translated_audio_chunk') {
        console.log(`[LATENCY][client] translated_audio_chunk idx=${message.index} turnId=${message.turnId} received at ${Date.now()}`);
        callbacks.onTranslatedAudioChunk?.({
          audioBase64: message.audioBase64,
          mimeType: message.mimeType,
          index: message.index,
          text: message.text,
          turnId: message.turnId,
        });
      }

      if (type === 'translated_audio_final') {
        console.log(`[LATENCY][client] translated_audio_final turnId=${message.turnId} received at ${Date.now()}`);
        callbacks.onTranslatedAudioFinal?.(message.originalText, message.translatedText, message.audioBase64);
      }

      if (type === 'transcript') {
        callbacks.onTranscript?.(message.originalText, message.translatedText);
      }

      if (type === 'partner_disconnected') {
        setStatus('disconnected');
        callbacks.onPartnerDisconnected?.();
      }

      if (type === 'partner_speaking') {
        console.log(`[LATENCY][client] partner_speaking received (turnId=${message.turnId}) at ${Date.now()}`);
        callbacks.onPartnerSpeaking?.();
      }

      if (type === 'turn_rejected') {
        callbacks.onTurnRejected?.();
      }

      if (type === 'lock_released') {
        callbacks.onLockReleased?.();
      }

      if (type === 'queue_resumed') {
        callbacks.onQueueResumed?.();
      }

      if (type === 'error') {
        setIsProcessing(false);
        callbacks.onError?.(message.message);
      }

      if (type === 'webrtc_offer') {
        callbacks.onWebRTCOffer?.(message.sdp);
      }

      if (type === 'webrtc_answer') {
        callbacks.onWebRTCAnswer?.(message.sdp);
      }

      if (type === 'webrtc_ice_candidate') {
        callbacks.onWebRTCIceCandidate?.(message.candidate);
      }

      if (type === 'webrtc_ready') {
        callbacks.onWebRTCReady?.();
      }
    });
  }, []);

  const createSession = useCallback(async (lang: string, userId?: string, speakerGender?: string, speakerAge?: number) => {
    setStatus('connecting');
    try {
      websocketService.onMessage(handleMessage);
      websocketService.onClose(() => {
        setStatus('disconnected');
        setIsProcessing(false);
      });
      websocketService.onError(() => { setStatus('error'); });
      await websocketService.connect(WS_URL);
      websocketService.send({
        type: 'create_session', lang, userId,
        ...(speakerGender ? { speakerGender } : {}),
        ...(speakerAge !== undefined ? { speakerAge } : {}),
      });
    } catch (e) {
      setStatus('error');
      callbacksMap.current.forEach(c => c.onError?.('Failed to connect to server.'));
    }
  }, [handleMessage]);

  const joinSession = useCallback(async (sid: string, lang: string, userId?: string, speakerGender?: string, speakerAge?: number) => {
    setStatus('connecting');
    try {
      websocketService.onMessage(handleMessage);
      websocketService.onClose(() => {
        setStatus('disconnected');
        setIsProcessing(false);
      });
      websocketService.onError(() => { setStatus('error'); });
      await websocketService.connect(WS_URL);
      websocketService.send({
        type: 'join_session', sessionId: sid, lang, userId,
        ...(speakerGender ? { speakerGender } : {}),
        ...(speakerAge !== undefined ? { speakerAge } : {}),
      });
      setSessionId(sid);
    } catch (e) {
      setStatus('error');
      callbacksMap.current.forEach(c => c.onError?.('Failed to connect to server.'));
    }
  }, [handleMessage]);

  const sendAudioStreamChunk = useCallback(
    (audioBase64: string, mimeType: string, role: string, sid: string) => {
      // Fired continuously (~10x/sec) while the mic is live. Language and voice
      // profile are already known server-side from create_session/join_session,
      // so each chunk only carries what's needed to forward it to Gemini.
      websocketService.send({
        type: 'audio_stream_chunk',
        sessionId: sid,
        role,
        audioBase64,
        mimeType,
      });
    },
    []
  );

  const sendCancelQueue = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'cancel_queue', role, sessionId: sid });
  }, []);

  const sendPauseQueue = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'pause_queue', role, sessionId: sid });
  }, []);

  const sendResumeQueue = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'resume_queue', role, sessionId: sid });
  }, []);

  const claimTurn = useCallback((role: string, sid: string, confidence: number = 1) => {
    websocketService.send({ type: 'claim_turn', sessionId: sid, role, confidence });
  }, []);

  const releaseTurn = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'release_turn', sessionId: sid, role });
  }, []);

  const sendWebRTCOffer = useCallback((sdp: any, role: string, sid: string) => {
    websocketService.send({ type: 'webrtc_offer', sdp, role, sessionId: sid });
  }, []);

  const sendWebRTCAnswer = useCallback((sdp: any, role: string, sid: string) => {
    websocketService.send({ type: 'webrtc_answer', sdp, role, sessionId: sid });
  }, []);

  const sendWebRTCIceCandidate = useCallback((candidate: any, role: string, sid: string) => {
    websocketService.send({ type: 'webrtc_ice_candidate', candidate, role, sessionId: sid });
  }, []);

  const sendWebRTCReady = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'webrtc_ready', role, sessionId: sid });
  }, []);

  const endSession = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'end_session', sessionId: sid, role });
    websocketService.disconnect();
    setStatus('idle');
    setSessionId(null);
    setPartnerLang(null);
    setIsProcessing(false);
    setQueueDepth(0);
  }, []);

  // Cleanup on provider unmount (rare, usually app close)
  useEffect(() => {
    return () => {
      websocketService.disconnect();
    };
  }, []);

  return (
    <WebSocketContext.Provider
      value={{
        status,
        sessionId,
        partnerLang,
        isProcessing,
        queueDepth,
        createSession,
        joinSession,
        sendAudioStreamChunk,
        sendPauseQueue,
        sendResumeQueue,
        sendCancelQueue,
        claimTurn,
        releaseTurn,
        endSession,
        sendWebRTCOffer,
        sendWebRTCAnswer,
        sendWebRTCIceCandidate,
        sendWebRTCReady,
        registerCallbacks,
        unregisterCallbacks,
      }}
    >
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocketContext = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocketContext must be used within a WebSocketProvider');
  }
  return context;
};
