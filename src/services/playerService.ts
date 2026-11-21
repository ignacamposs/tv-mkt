import { db } from '@/lib/firebase';
import { doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import { Screen } from '@/types/signage';

const STORAGE_SCREEN_ID = 'signage_screen_id';
const STORAGE_DEVICE_TOKEN = 'signage_device_token';
const APP_VERSION = '1.0.0-androidtv';

function generatePairingCode(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

/**
 * Inicializa el dispositivo en localStorage y crea su registro en Firestore si es nuevo.
 */
export async function initializeDevice(): Promise<{ screenId: string; deviceToken: string }> {
  let screenId = localStorage.getItem(STORAGE_SCREEN_ID);
  let deviceToken = localStorage.getItem(STORAGE_DEVICE_TOKEN);

  if (!screenId || !deviceToken) {
    screenId = `scr_${generateUUID()}`;
    deviceToken = generateUUID();
    localStorage.setItem(STORAGE_SCREEN_ID, screenId);
    localStorage.setItem(STORAGE_DEVICE_TOKEN, deviceToken);
  }

  try {
    const screenRef = doc(db, 'screens', screenId);
    const screenSnap = await getDoc(screenRef);

    if (!screenSnap.exists()) {
      const newScreen: Screen = {
        id: screenId,
        pairingCode: generatePairingCode(6),
        deviceToken,
        name: 'Nueva Pantalla TV',
        channelId: null,
        isPaired: false,
        rotation: 0,
        command: 'playing',
        telemetry: {
          lastSeen: Date.now(),
          isNetworkOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
          currentItemTitle: 'Esperando vinculación',
          cachedItemsCount: 0,
          appVersion: APP_VERSION,
        },
      };
      await setDoc(screenRef, newScreen);
    }
  } catch (error) {
    console.warn('[PlayerService] Arrancando en modo offline sin acceso inicial a Firestore.', error);
  }

  return { screenId, deviceToken };
}

/**
 * Envía señal de vida y estado actual al panel de control usando dot-notation de Firestore.
 */
export async function sendTelemetryHeartbeat(
  screenId: string,
  currentItemTitle: string,
  cachedItemsCount: number
): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  try {
    const screenRef = doc(db, 'screens', screenId);
    await updateDoc(screenRef, {
      'telemetry.lastSeen': Date.now(),
      'telemetry.isNetworkOnline': true,
      'telemetry.currentItemTitle': currentItemTitle,
      'telemetry.cachedItemsCount': cachedItemsCount,
      'telemetry.appVersion': APP_VERSION,
    });
  } catch (error) {
    console.debug('[Telemetría] Error enviando heartbeat, reintentando en el próximo ciclo.', error);
  }
}