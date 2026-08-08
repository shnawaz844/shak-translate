import { useEffect, useRef, useState, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';

// ═══════════════════════════════════════════════════════════════════════════
// PLAIN PEER-TO-PEER VOICE CALL (WebRTC) — web only for now.
//
// AI translation is bypassed entirely here: audio flows directly between the
// two browsers once connected. The signaling handshake (offer/answer/ICE)
// still goes through our existing WebSocket server, which just relays the
// messages verbatim — it never touches the audio itself. See
// backend/server.js's "WEBRTC SIGNALING" section.
// ═══════════════════════════════════════════════════════════════════════════

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'failed' | 'ended';

interface UseWebRTCCallOptions {
  /** Start the call once both peers are present (e.g. status === 'connected' from useWebSocket). */
  enabled: boolean;
  role: 'host' | 'guest';
  sessionId: string;
}

// Free public STUN server — sufficient for most networks. Add a TURN server
// here later if testing turns up connections that can't traverse NAT.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function useWebRTCCall({ enabled, role, sessionId }: UseWebRTCCallOptions) {
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<any[]>([]);
  const startedRef = useRef(false);
  const offerSentRef = useRef(false);
  const partnerReadyRef = useRef(false);

  // The peer connection is created asynchronously (getUserMedia takes time).
  // An offer/answer/candidate can arrive from the partner before that setup
  // finishes — without this, the handlers below would find pcRef.current
  // still null and silently drop the message, leaving both sides stuck on
  // "Connecting..." forever. This promise lets them wait for setup instead.
  const pcReadyResolverRef = useRef<((pc: RTCPeerConnection) => void) | null>(null);
  const pcReadyPromiseRef = useRef<Promise<RTCPeerConnection> | null>(null);
  // Note: useRef(new Promise(...)) would re-run the executor on every render
  // (React only keeps the first *result*, but still evaluates the argument
  // each time), silently re-pointing pcReadyResolverRef at an orphaned
  // promise nobody awaits. Guarding construction like this makes it run once.
  if (!pcReadyPromiseRef.current) {
    pcReadyPromiseRef.current = new Promise<RTCPeerConnection>((resolve) => { pcReadyResolverRef.current = resolve; });
  }

  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn('[useWebRTCCall] addIceCandidate (queued) failed:', e); }
    }
  }, []);

  // Even though WebSocket callback registration happens as soon as this hook
  // mounts (well before getUserMedia resolves), relying on that ordering is
  // fragile — there's no guarantee the partner's own registration has landed
  // by the time our offer arrives, and a message with nobody listening is
  // silently dropped forever (this was exactly what got both sides stuck on
  // "Connecting..." indefinitely). So instead of the host firing an offer the
  // moment its own setup finishes, both sides explicitly announce readiness,
  // and the host only creates the offer once it knows the guest is actually
  // there to receive it.
  const { sendWebRTCOffer, sendWebRTCAnswer, sendWebRTCIceCandidate, sendWebRTCReady } = useWebSocket({
    onWebRTCReady: () => {
      console.log(`[webrtc][client] (${role}) partner announced ready`);
      partnerReadyRef.current = true;
      maybeCreateOfferRef.current?.();
    },
    onWebRTCOffer: async (sdp: any) => {
      try {
        console.log(`[webrtc][client] (${role}) offer received, waiting for pc...`);
        const pc = await pcReadyPromiseRef.current!;
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        console.log(`[webrtc][client] (${role}) remote description (offer) set, creating answer`);
        await flushPendingCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`[webrtc][client] (${role}) sending answer`);
        // Send a plain object, not the RTCSessionDescription instance itself —
        // in several browsers its type/sdp fields are prototype getters, not
        // own enumerable properties, so JSON.stringify silently serializes it
        // as {} and the other side's setRemoteDescription then throws.
        sendWebRTCAnswer({ type: pc.localDescription!.type, sdp: pc.localDescription!.sdp }, role, sessionId);
      } catch (e) {
        console.error(`[webrtc][client] (${role}) FAILED handling offer:`, e);
      }
    },
    onWebRTCAnswer: async (sdp: any) => {
      try {
        console.log(`[webrtc][client] (${role}) answer received`);
        const pc = await pcReadyPromiseRef.current!;
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        console.log(`[webrtc][client] (${role}) remote description (answer) set`);
        await flushPendingCandidates(pc);
      } catch (e) {
        console.error(`[webrtc][client] (${role}) FAILED handling answer:`, e);
      }
    },
    onWebRTCIceCandidate: async (candidate: any) => {
      const pc = await pcReadyPromiseRef.current!;
      if (!pc.remoteDescription) {
        pendingCandidatesRef.current.push(candidate);
        console.log(`[webrtc][client] (${role}) ICE candidate queued (no remote description yet)`);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`[webrtc][client] (${role}) ICE candidate added`);
      } catch (e) { console.warn('[useWebRTCCall] addIceCandidate failed:', e); }
    },
  });

  // Holds the latest maybeCreateOffer closure so the onWebRTCReady handler
  // above (captured once, at mount) can always call the current version.
  const maybeCreateOfferRef = useRef<(() => void) | null>(null);

  // ── Start the call once enabled ─────────────────────────────────────────
  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    maybeCreateOfferRef.current = () => {
      const pc = pcRef.current;
      if (role !== 'host' || !pc || offerSentRef.current || !partnerReadyRef.current) return;
      offerSentRef.current = true;
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          console.log(`[webrtc][client] (${role}) sending offer`);
          // Plain object, not the RTCSessionDescription instance — see the
          // comment on sendWebRTCAnswer above for why.
          sendWebRTCOffer({ type: pc.localDescription!.type, sdp: pc.localDescription!.sdp }, role, sessionId);
        } catch (e) {
          console.error(`[webrtc][client] (${role}) FAILED creating/sending offer:`, e);
        }
      })();
    };

    (async () => {
      try {
        setCallStatus('connecting');
        console.log(`[webrtc][client] (${role}) requesting microphone...`);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        console.log(`[webrtc][client] (${role}) microphone acquired, tracks=${stream.getAudioTracks().length}`);
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        localStreamRef.current = stream;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        stream.getTracks().forEach(track => pc.addTrack(track, stream));

        pc.ontrack = (event) => {
          console.log(`[webrtc][client] (${role}) ontrack fired — remote audio received`);
          setRemoteStream(event.streams[0]);
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            console.log(`[webrtc][client] (${role}) local ICE candidate found, sending`);
            // Same plain-object serialization concern as offer/answer above.
            sendWebRTCIceCandidate(event.candidate.toJSON(), role, sessionId);
          } else {
            console.log(`[webrtc][client] (${role}) ICE gathering complete`);
          }
        };

        pc.oniceconnectionstatechange = () => {
          console.log(`[webrtc][client] (${role}) iceConnectionState -> ${pc.iceConnectionState}`);
        };

        pc.onconnectionstatechange = () => {
          console.log(`[webrtc][client] (${role}) connectionState -> ${pc.connectionState}`);
          if (pc.connectionState === 'connected') setCallStatus('connected');
          else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') setCallStatus('failed');
        };

        pcReadyResolverRef.current?.(pc);
        console.log(`[webrtc][client] (${role}) RTCPeerConnection created and ready — announcing readiness`);

        // Announce readiness to the partner, then retry periodically in case
        // our own 'webrtc_ready' was sent before the partner's handler was
        // registered (the exact same race we're protecting against below) —
        // cheap and self-cancelling once the offer/answer exchange starts.
        sendWebRTCReady(role, sessionId);
        const readyRetry = setInterval(() => {
          if (cancelled || pc.signalingState !== 'stable' || pc.currentLocalDescription) {
            clearInterval(readyRetry);
            return;
          }
          sendWebRTCReady(role, sessionId);
        }, 1000);
        setTimeout(() => clearInterval(readyRetry), 10000);

        // If we're the host and the guest already announced readiness before
        // our own setup finished, fire the offer immediately.
        maybeCreateOfferRef.current?.();
      } catch (e: any) {
        console.error(`[webrtc][client] (${role}) setup failed:`, e?.message);
        setMicError(e?.message ?? 'Microphone access failed');
        setCallStatus('failed');
      }
    })();

    return () => { cancelled = true; };
  }, [enabled, role, sessionId, sendWebRTCOffer, sendWebRTCIceCandidate, sendWebRTCReady]);

  // ── Play the remote stream (web-only: a plain <audio> element) ──────────
  useEffect(() => {
    if (typeof document === 'undefined' || !remoteStream) return;
    const audioEl = document.createElement('audio');
    audioEl.srcObject = remoteStream as any;
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
    return () => {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
    };
  }, [remoteStream]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !isMuted;
    stream.getAudioTracks().forEach(track => { track.enabled = !nextMuted; });
    setIsMuted(nextMuted);
  }, [isMuted]);

  const endCall = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    setRemoteStream(null);
    setCallStatus('ended');
  }, []);

  // Cleanup on unmount regardless of how the call ended.
  useEffect(() => {
    return () => {
      pcRef.current?.close();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return { callStatus, remoteStream, isMuted, toggleMute, endCall, micError };
}
