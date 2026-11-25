'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import {
  Channel,
  MediaItem,
  Screen,
  ScreenTelemetry,
} from '../../types/signage';

const APP_VERSION = '1.2.0-caller';
const STORAGE_SCREEN_ID = 'signage_screen_id';
const STORAGE_DEVICE_TOKEN = 'signage_device_token';

function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateDeviceToken(): string {
  return `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Genera un timbre clásico "ding-dong" usando Web Audio API (funciona offline)
 */
function playDoorbellChime() {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Primera nota: Mi5 (659.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.exponentialRampToValueAtTime(0.28, now + 0.03);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.56);

    // Segunda nota: Do5 (523.25 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(523.25, now + 0.35);
    gain2.gain.setValueAtTime(0.001, now + 0.35);
    gain2.gain.exponentialRampToValueAtTime(0.32, now + 0.38);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 1.15);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.35);
    osc2.stop(now + 1.2);

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 1500);
  } catch {
    // Ignorar bloqueo de autoplay si ocurre en navegador sin interacción previa
  }
}

/**
 * Anuncia el turno en voz alta en español usando el motor nativo del TV/navegador
 */
function speakTicketCall(ticket: string, destination: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();

    // Si es un código corto (ej: "A-014") antepone "Turno", si es nombre lo lee directo
    const isCode = /^[A-Z]{0,3}-?\d{1,4}$/i.test(ticket.trim());
    const spokenTicket = ticket.replace('-', ' ');
    const phrase = isCode
      ? `Turno ${spokenTicket}, ${destination}`
      : `${spokenTicket}, ${destination}`;

    const utterance = new SpeechSynthesisUtterance(phrase);
    utterance.lang = 'es-AR';
    utterance.rate = 0.95;
    utterance.pitch = 1.0;

    // Esperar 650ms para que suene primero el timbre "ding-dong"
    setTimeout(() => {
      window.speechSynthesis.speak(utterance);
    }, 650);
  } catch {
    // Silenciar errores si el dispositivo no tiene voces instaladas
  }
}

export default function PlayerPage() {
  const [screenId, setScreenId] = useState<string>('');
  const [screen, setScreen] = useState<(Screen & { id: string }) | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);

  // Transición suave entre spots
  const [outgoingItem, setOutgoingItem] = useState<MediaItem | null>(null);
  const [outgoingFading, setOutgoingFading] = useState<boolean>(false);
  const lastItemRef = useRef<MediaItem | null>(null);

  // Control de anuncios del llamador
  const [callFlash, setCallFlash] = useState<boolean>(false);
  const lastCallSignatureRef = useRef<string>('');
  const isFirstCallSnapshotRef = useRef<boolean>(true);

  const [bootError, setBootError] = useState<string>('');

  // 1. Registrar o recuperar identidad del televisor en Firestore
  useEffect(() => {
    let cancelled = false;

    async function initDevice() {
      try {
        const savedScreenId = localStorage.getItem(STORAGE_SCREEN_ID);
        let deviceToken = localStorage.getItem(STORAGE_DEVICE_TOKEN);

        if (!deviceToken) {
          deviceToken = generateDeviceToken();
          localStorage.setItem(STORAGE_DEVICE_TOKEN, deviceToken);
        }

        if (savedScreenId) {
          if (!cancelled) setScreenId(savedScreenId);
          return;
        }

        const newCode = generatePairingCode();
        const initialTelemetry: ScreenTelemetry = {
          lastSeen: Date.now(),
          isNetworkOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
          currentItemTitle: 'Esperando vinculación',
          cachedItemsCount: 0,
          appVersion: APP_VERSION,
        };

        const docRef = await addDoc(collection(db, 'screens'), {
          pairingCode: newCode,
          deviceToken,
          name: 'Nueva Pantalla',
          channelId: '',
          isPaired: false,
          rotation: 0,
          command: 'playing',
          callerEnabled: false,
          telemetry: initialTelemetry,
          lastSeen: Date.now(),
          currentStatus: 'Esperando vinculación',
        });

        localStorage.setItem(STORAGE_SCREEN_ID, docRef.id);
        if (!cancelled) setScreenId(docRef.id);
      } catch {
        if (!cancelled) {
          setBootError('Error conectando con el servidor. Reintentando...');
        }
      }
    }

    initDevice();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Escuchar cambios en tiempo real de este televisor (canal, comandos, rotación, llamador)
  useEffect(() => {
    if (!screenId) return;

    const unsub = onSnapshot(
      doc(db, 'screens', screenId),
      (snap) => {
        if (!snap.exists()) {
          // Si fue eliminada desde el panel, limpiar y regenerar
          localStorage.removeItem(STORAGE_SCREEN_ID);
          setScreenId('');
          setScreen(null);
          return;
        }

        const data = { ...(snap.data() as Screen), id: snap.id };
        setScreen(data);
        setBootError('');

        // Detectar nuevo llamado de turno
        const currentCall = data.callerState?.current;
        const updatedAt = data.callerState?.updatedAt || currentCall?.timestamp || 0;
        const signature = currentCall ? `${currentCall.id}_${updatedAt}` : '';

        if (isFirstCallSnapshotRef.current) {
          isFirstCallSnapshotRef.current = false;
          lastCallSignatureRef.current = signature;
        } else if (
          data.callerEnabled &&
          currentCall &&
          signature &&
          signature !== lastCallSignatureRef.current
        ) {
          lastCallSignatureRef.current = signature;
          setCallFlash(true);
          setTimeout(() => setCallFlash(false), 4000);

          playDoorbellChime();
          if (data.callerState?.voiceEnabled !== false) {
            speakTicketCall(currentCall.ticket, currentCall.destination);
          }
        }
      },
      () => {
        // Si cae la red temporalmente, mantiene el estado actual en memoria
      }
    );

    return () => unsub();
  }, [screenId]);

  // 3. Escuchar canal asignado (con respaldo en localStorage para modo offline)
  const channelId = screen?.channelId || '';

  useEffect(() => {
    if (!channelId) {
      setItems([]);
      setCurrentIndex(0);
      return;
    }

    const cacheKey = `signage_cached_channel_${channelId}`;
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw) as MediaItem[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setItems(parsed);
        }
      }
    } catch {
      // Ignorar error de lectura de caché
    }

    const unsub = onSnapshot(
      doc(db, 'channels', channelId),
      (snap) => {
        if (!snap.exists()) {
          setItems([]);
          return;
        }
        const channelData = snap.data() as Channel;
        const sorted = [...(channelData.items || [])].sort((a, b) => a.order - b.order);
        setItems(sorted);
        try {
          localStorage.setItem(cacheKey, JSON.stringify(sorted));
        } catch {
          // Ignorar límite de almacenamiento
        }
      },
      () => {
        // Ante corte de red mantiene los items cargados desde localStorage
      }
    );

    return () => unsub();
  }, [channelId]);

  // 4. Loop continuo de reproducción
  const safeIndex = items.length > 0 ? currentIndex % items.length : 0;
  const activeItem = items[safeIndex] || null;

  useEffect(() => {
    if (!screen?.isPaired || screen.command !== 'playing' || items.length === 0 || !activeItem) {
      return;
    }

    const durationMs = Math.max(activeItem.duration || 10, 2) * 1000;
    const timer = setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % items.length);
    }, durationMs);

    return () => clearTimeout(timer);
  }, [screen?.isPaired, screen?.command, items.length, activeItem]);

  // Transición suave (Crossfade 0.5s)
  useEffect(() => {
    const prev = lastItemRef.current;
    if (prev && activeItem && prev.id !== activeItem.id) {
      setOutgoingItem(prev);
      setOutgoingFading(false);

      const raf = requestAnimationFrame(() => {
        setOutgoingFading(true);
      });
      const cleanup = setTimeout(() => {
        setOutgoingItem(null);
        setOutgoingFading(false);
      }, 520);

      lastItemRef.current = activeItem;
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(cleanup);
      };
    }

    lastItemRef.current = activeItem;
  }, [activeItem]);

  // 5. Enviar latidos de telemetría a Firestore (para la Torre de Control)
  const sendHeartbeat = useCallback(async () => {
    if (!screenId) return;
    try {
      const now = Date.now();
      const statusLabel = !screen?.isPaired
        ? 'Esperando vinculación'
        : screen.command === 'blackout'
        ? 'Pantalla apagada'
        : screen.command === 'paused'
        ? 'Pausado'
        : activeItem
        ? `Emitiendo: ${activeItem.title}`
        : 'Sin contenido';

      const telemetry: ScreenTelemetry = {
        lastSeen: now,
        isNetworkOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
        currentItemTitle: activeItem?.title || statusLabel,
        ...(activeItem?.id ? { currentItemId: activeItem.id } : {}),
        cachedItemsCount: items.length,
        appVersion: APP_VERSION,
      };

      await updateDoc(doc(db, 'screens', screenId), {
        telemetry,
        lastSeen: now,
        currentStatus: statusLabel,
        cachedCount: items.length,
      });
    } catch {
      // Silenciar si momentáneamente no hay internet
    }
  }, [screenId, screen?.isPaired, screen?.command, activeItem, items.length]);

  useEffect(() => {
    if (!screenId) return;
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 25000);
    return () => clearInterval(interval);
  }, [screenId, sendHeartbeat]);

  // Pantalla de carga inicial o error de arranque
  if (!screen) {
    return (
      <div className="w-screen h-screen bg-black text-neutral-400 flex flex-col items-center justify-center p-8 select-none">
        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm tracking-wide">
          {bootError || 'Iniciando reproductor digital...'}
        </p>
      </div>
    );
  }

  // Pantalla sin vincular: muestra el código grande de 6 dígitos
  if (!screen.isPaired) {
    return (
      <div className="w-screen h-screen bg-neutral-950 text-white flex flex-col items-center justify-center p-8 select-none">
        <div className="max-w-md w-full bg-neutral-900 border border-neutral-800 rounded-3xl p-10 text-center space-y-6 shadow-2xl">
          <span className="inline-block px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-semibold uppercase tracking-widest">
            Pantalla Lista para Vincular
          </span>

          <div className="space-y-2">
            <p className="text-sm text-neutral-400">
              Ingresá este código en el Panel de Control o en el Llamador de Mostrador:
            </p>
            <div className="bg-black border-2 border-neutral-800 rounded-2xl py-6 px-4">
              <span className="text-5xl md:text-6xl font-black font-mono tracking-[0.25em] text-emerald-400">
                {screen.pairingCode}
              </span>
            </div>
          </div>

          <p className="text-xs text-neutral-500">
            Esperando asignación desde el panel...
          </p>
        </div>
      </div>
    );
  }

  // Comando Blackout (pantalla en negro)
  if (screen.command === 'blackout') {
    return <div className="w-screen h-screen bg-black cursor-none select-none" />;
  }

  const rotation = screen.rotation || 0;
  const isVerticalRotation = rotation === 90 || rotation === 270;
  const callerEnabled = Boolean(screen.callerEnabled);
  const currentCall = screen.callerState?.current || null;
  const callHistory = (screen.callerState?.history || []).slice(0, 4);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden flex items-center justify-center cursor-none select-none">
      {/* Contenedor rotado según configuración del TV (0°, 90°, 180°, 270°) */}
      <div
        style={{
          width: isVerticalRotation ? '100vh' : '100vw',
          height: isVerticalRotation ? '100vw' : '100vh',
          transform: `rotate(${rotation}deg)`,
        }}
        className={`shrink-0 bg-black flex ${
          isVerticalRotation ? 'flex-col' : 'flex-row'
        } overflow-hidden`}
      >
        {/* ZONA PRINCIPAL: PUBLICIDADES (100% normal o 72% si el llamador está activo) */}
        <div
          className={`relative bg-black flex items-center justify-center overflow-hidden ${
            callerEnabled
              ? isVerticalRotation
                ? 'w-full h-[68%]'
                : 'w-[72%] h-full'
              : 'w-full h-full'
          }`}
        >
          {!activeItem ? (
            <div className="text-center px-6 space-y-2">
              <p className="text-lg font-medium text-neutral-500">{screen.name}</p>
              <p className="text-xs text-neutral-600">
                {channelId
                  ? 'El canal asignado todavía no tiene anuncios publicados.'
                  : 'Pantalla vinculada. Asignale un canal desde el panel.'}
              </p>
            </div>
          ) : (
            <>
              {/* Spot entrante */}
              <div className="absolute inset-0 flex items-center justify-center">
                {activeItem.type === 'image' && (
                  <img
                    key={`in-${activeItem.id}`}
                    src={activeItem.url}
                    alt={activeItem.title}
                    className="w-full h-full object-contain"
                  />
                )}

                {activeItem.type === 'video' && (
                  <video
                    key={`in-${activeItem.id}`}
                    src={activeItem.url}
                    autoPlay={screen.command === 'playing'}
                    muted
                    loop
                    playsInline
                    className="w-full h-full object-contain"
                  />
                )}

                {activeItem.type === 'youtube' && activeItem.youtubeId && (
                  <iframe
                    key={`in-${activeItem.id}`}
                    className="w-full h-full pointer-events-none"
                    src={`https://www.youtube.com/embed/${activeItem.youtubeId}?autoplay=${
                      screen.command === 'playing' ? 1 : 0
                    }&mute=1&loop=1&playlist=${
                      activeItem.youtubeId
                    }&controls=0&rel=0&modestbranding=1&playsinline=1`}
                    title={activeItem.title}
                    allow="autoplay; encrypted-media"
                  />
                )}
              </div>

              {/* Spot saliente con fundido suave */}
              {outgoingItem && (
                <div
                  className={`absolute inset-0 bg-black flex items-center justify-center pointer-events-none transition-opacity duration-500 ${
                    outgoingFading ? 'opacity-0' : 'opacity-100'
                  }`}
                >
                  {outgoingItem.type === 'image' && (
                    <img
                      src={outgoingItem.url}
                      alt={outgoingItem.title}
                      className="w-full h-full object-contain"
                    />
                  )}
                  {outgoingItem.type === 'video' && (
                    <video
                      src={outgoingItem.url}
                      muted
                      playsInline
                      className="w-full h-full object-contain"
                    />
                  )}
                </div>
              )}
            </>
          )}

          {/* Indicador sutil si está pausada desde el panel */}
          {screen.command === 'paused' && (
            <div className="absolute top-4 left-4 bg-black/75 border border-amber-500/40 text-amber-300 px-3 py-1 rounded-full text-xs font-semibold">
              ⏸ Pausa
            </div>
          )}
        </div>

        {/* ZONA SECUNDARIA (L-BAR): COLUMNA DE TURNOS EN VIVO */}
        {callerEnabled && (
          <aside
            className={`bg-neutral-950 flex flex-col justify-between p-5 ${
              isVerticalRotation
                ? 'w-full h-[32%] border-t-2 border-neutral-800'
                : 'w-[28%] h-full border-l-2 border-neutral-800'
            }`}
          >
            {/* Cabecera de Turnos */}
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs md:text-sm font-bold uppercase tracking-[0.2em] text-neutral-300">
                  Turnos
                </span>
              </div>
              <span className="text-[11px] font-mono text-neutral-500">
                {screen.pairingCode}
              </span>
            </div>

            {/* Tarjeta del Llamado Actual */}
            <div
              className={`my-auto rounded-2xl p-5 text-center transition-all duration-500 border-2 ${
                callFlash
                  ? 'bg-emerald-500 border-white text-black scale-[1.02] shadow-[0_0_45px_rgba(16,185,129,0.65)]'
                  : 'bg-neutral-900 border-emerald-500/50 text-white'
              }`}
            >
              {currentCall ? (
                <div className="space-y-2">
                  <p
                    className={`text-xs font-bold uppercase tracking-widest ${
                      callFlash ? 'text-black/80' : 'text-emerald-400'
                    }`}
                  >
                    Llamando Ahora
                  </p>
                  <p className="text-4xl xl:text-5xl font-black tracking-tight break-words leading-tight">
                    {currentCall.ticket}
                  </p>
                  <div
                    className={`inline-block mt-1 px-4 py-1.5 rounded-xl text-base xl:text-xl font-extrabold uppercase tracking-wide ${
                      callFlash
                        ? 'bg-black text-emerald-400'
                        : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    }`}
                  >
                    {currentCall.destination}
                  </div>
                </div>
              ) : (
                <div className="py-6 space-y-1">
                  <p className="text-sm font-medium text-neutral-400">
                    Sala de Espera
                  </p>
                  <p className="text-xs text-neutral-600">
                    Aguardando próximo llamado
                  </p>
                </div>
              )}
            </div>

            {/* Historial reciente de llamados */}
            <div className="border-t border-neutral-800 pt-3 space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                Últimos llamados
              </p>
              {callHistory.length === 0 ? (
                <p className="text-xs text-neutral-600">—</p>
              ) : (
                <ul className="space-y-1.5">
                  {callHistory.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-2 bg-neutral-900/90 border border-neutral-800/80 rounded-xl px-3 py-2 text-xs xl:text-sm"
                    >
                      <span className="font-bold text-neutral-200 truncate">
                        {entry.ticket}
                      </span>
                      <span className="font-semibold text-emerald-400 shrink-0">
                        {entry.destination}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}