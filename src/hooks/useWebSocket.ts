import { useEffect, useId } from 'react';
import { useWebSocketContext, TranslatedAudioPayload, TranslatedAudioChunkPayload } from '../contexts/WebSocketContext';

export { ConnectionStatus, TranslatedAudioPayload, TranslatedAudioChunkPayload } from '../contexts/WebSocketContext';

interface UseWebSocketOptions {
  onTranslatedAudio?: (payload: TranslatedAudioPayload) => void;
  onTranslatedAudioChunk?: (payload: TranslatedAudioChunkPayload) => void;
  onTranslatedAudioFinal?: (originalText: string, translatedText: string) => void;
  onTranscript?: (originalText: string, translatedText: string) => void;
  onPartnerDisconnected?: () => void;
  onError?: (message: string) => void;
  onPartnerSpeaking?: () => void;
  onTurnRejected?: () => void;
  onLockReleased?: () => void;
  onQueueResumed?: () => void;
  onSessionReadyEvent?: (partnerLang: string) => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const context = useWebSocketContext();
  const hookId = useId();

  useEffect(() => {
    context.registerCallbacks(hookId, options);
    return () => {
      context.unregisterCallbacks(hookId);
    };
  }, [hookId, options, context]);

  return {
    status: context.status,
    sessionId: context.sessionId,
    partnerLang: context.partnerLang,
    isProcessing: context.isProcessing,
    queueDepth: context.queueDepth,
    createSession: context.createSession,
    joinSession: context.joinSession,
    sendAudioStreamChunk: context.sendAudioStreamChunk,
    sendPauseQueue: context.sendPauseQueue,
    sendResumeQueue: context.sendResumeQueue,
    sendCancelQueue: context.sendCancelQueue,
    claimTurn: context.claimTurn,
    releaseTurn: context.releaseTurn,
    endSession: context.endSession,
  };
}
