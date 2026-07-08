import { WS_URL } from '../config';

type MessageHandler = (message: Record<string, any>) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private openHandler: (() => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((error: any) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(url: string = WS_URL): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[WebSocketService] Connected to', url);
        this.openHandler?.();
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.messageHandler?.(data);
        } catch (e) {
          console.error('[WebSocketService] Failed to parse message:', event.data);
        }
      };

      this.ws.onclose = (event) => {
        console.log('[WebSocketService] Disconnected:', event.code, event.reason);
        this.closeHandler?.(event.code, event.reason);
        this.ws = null;
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocketService] Error:', error);
        this.errorHandler?.(error);
        reject(error);
      };
    });
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent close handler from firing on intentional disconnect
      this.ws.onerror = null; // prevent error handler from firing on intentional disconnect
      try {
        this.ws.close(1000, 'User disconnected');
      } catch (e) {
        console.warn('[WebSocketService] Error during close:', e);
      }
      this.ws = null;
    }
  }

  send(payload: Record<string, any>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WebSocketService] Cannot send — not connected');
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  onMessage(handler: MessageHandler) {
    this.messageHandler = handler;
  }

  onOpen(handler: () => void) {
    this.openHandler = handler;
  }

  onClose(handler: (code: number, reason: string) => void) {
    this.closeHandler = handler;
  }

  onError(handler: (error: any) => void) {
    this.errorHandler = handler;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const websocketService = new WebSocketService();
