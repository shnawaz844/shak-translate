import { Alert as RNAlert, Platform } from 'react-native';

// React Native Web's own Alert.alert is a hard no-op (`static alert() {}`) —
// every confirmation dialog and error alert in this app was silently doing
// nothing on web. This is a drop-in replacement: same call signature, so
// call sites don't change, just the import. On native it just delegates to
// the real Alert; on web it maps onto window.confirm/window.alert.
interface AlertButton {
  text?: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
}

function alert(title: string, message?: string, buttons?: AlertButton[]): void {
  if (Platform.OS !== 'web') {
    RNAlert.alert(title, message, buttons as any);
    return;
  }

  const list = buttons && buttons.length > 0 ? buttons : [{ text: 'OK' } as AlertButton];
  const text = [title, message].filter(Boolean).join('\n\n');

  if (list.length === 1) {
    window.alert(text);
    list[0].onPress?.();
    return;
  }

  // window.confirm only gives OK/Cancel, so map onto whichever button looks
  // like the "cancel" one (explicit style, else the last button — matches
  // the common convention of listing Cancel last) vs. the other as the
  // confirming action.
  const cancelBtn = list.find(b => b.style === 'cancel') ?? list[list.length - 1];
  const actionBtn = list.find(b => b !== cancelBtn) ?? list[0];

  if (window.confirm(text)) {
    actionBtn.onPress?.();
  } else {
    cancelBtn.onPress?.();
  }
}

export const Alert = { alert };
export default Alert;
