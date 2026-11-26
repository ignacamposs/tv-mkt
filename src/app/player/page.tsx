'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { getCallerTheme } from '../../lib/callerThemes';
import { Channel, MediaItem, Screen } from '../../types/signage';

const STORAGE_SCREEN_ID_KEY = 'signage_player_screen_id';
const STORAGE_CHANNEL_CACHE_KEY = 'signage_player_cached_channel';
const APP_VERSION = '2.2.0-LBar';

function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function playDingDongChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // Primera nota: Mi5 (659.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.exponentialRampToValueAtTime(0.32, now + 0.03);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.6);

    // Segunda nota: Do5 (523.25 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(523.25, now + 0.35);
    gain2.gain.setValueAtTime(0.001, now + 0.35);
    gain2.gain.exponentialRampToValueAtTime(0.35, now + 0.38);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 1.15);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.35);
    osc2.stop(now + 1.2);
  } catch {
    // El navegador bloquea audio si aún no hubo interacción del usuario
  }
}

function announceTicketVoice(ticket: string, destination: string) {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const formattedTicket = ticket.replace(/-/g, ' ');
    const utterance = new SpeechSynthesisUtterance(
      `Turno ${formattedTicket}, ${destination}`
    );
    utterance.lang = 'es-AR';
    utterance.rate = 0.95;
    utterance.pitch = 1.0;

    setTimeout(() => {
      window.speechSynthesis.speak(utterance);
    }, 650);
  } catch {
    // Ignorar si speechSynthesis no está disponible
  }
}

export default function PlayerPage() {
  const [screenId, setScreenId] = useState<string>('');
  const [pairingCode, setPairingCode] = useState<string>('');
  const [screen, setScreen] = useState<(Screen & { id: string }) | null>(null);
  const [channel, setChannel] = useState<(Channel & { id: string }) | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [audioUnlocked, setAudioUnlocked] = useState<boolean>(false);
  const [callFlash, setCallFlash] = useState<boolean>(false);
  const [bootError, setBootError] = useState<string>('');

  const lastAnnouncedCallIdRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Monitoreo de red
  useEffect(() => {
    setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Recuperar canal cacheado por si se corta Internet
  useEffect(() => {
    try {
      const cached = localStorage.getItem(STORAGE_CHANNEL_CACHE_KEY);
      if (cached) {
        setChannel(JSON.parse(cached));
      }
    } catch {
      // Ignorar caché inválida
    }
  }, []);

  // Registrar o recuperar esta pantalla en Firestore
  useEffect(() => {
    let cancelled = false;

    async function initScreen() {
      try {
        const savedId = localStorage.getItem(STORAGE_SCREEN_ID_KEY);
        if (savedId) {
          setScreenId(savedId);
          return;
        }

        const newCode = generatePairingCode();
        const { addDoc } = await import('firebase/firestore');
        const docRef = await addDoc(collection(db, 'screens'), {
          name: `TV ${newCode}`,
          pairingCode: newCode,
          isPaired: false,
          channelId: '',
          command: 'playing',
          rotation: 0,
          callerEnabled: false,
          callerTheme: 'clinical',
        });

        if (!cancelled) {
          localStorage.setItem(STORAGE_SCREEN_ID_KEY, docRef.id);
          setPairingCode(newCode);
          setScreenId(docRef.id);
        }
      } catch {
        // Fallback: buscar si existe o mostrar error de red
        if (!cancelled) {
          setBootError('No se pudo registrar la pantalla. Verificá tu conexión a Internet.');
        }
      }
    }

    initScreen();
    return () => {
      cancelled = true;
    };
  }, []);

  // Escuchar cambios en tiempo real del documento de la pantalla
  useEffect(() => {
    if (!screenId) return;

    const unsub = onSnapshot(
      doc(db, 'screens', screenId),
      (snap) => {
        if (!snap.exists()) {
          localStorage.removeItem(STORAGE_SCREEN_ID_KEY);
          setScreenId('');
          setScreen(null);
          return;
        }

        const data = { ...(snap.data() as Screen), id: snap.id };
        setScreen(data);
        setPairingCode(data.pairingCode);

        // Detectar nuevo llamado de turno
        const currentCall = data.callerState?.current;
        if (currentCall && currentCall.id !== lastAnnouncedCallIdRef.current) {
          const isFirstLoad = lastAnnouncedCallIdRef.current === null;
          lastAnnouncedCallIdRef.current = currentCall.id;

          if (!isFirstLoad && data.callerEnabled) {
            setCallFlash(true);
            setTimeout(() => setCallFlash(false), 4500);

            if (data.callerState?.voiceEnabled !== false) {
              playDingDongChime();
              announceTicketVoice(currentCall.ticket, currentCall.destination);
            }
          }
        }
      },
      () => {
        // Si cae la red, sigue reproduciendo con el caché local
      }
    );

    return () => unsub();
  }, [screenId]);

  // Escuchar el canal asignado a este televisor
  useEffect(() => {
    const channelId = screen?.channelId;
    if (!channelId) {
      setChannel(null);
      return;
    }

    const unsub = onSnapshot(
      doc(db, 'channels', channelId),
      (snap) => {
        if (!snap.exists()) {
          setChannel(null);
          return;
        }
        const chData = { ...(snap.data() as Channel), id: snap.id };
        const sortedItems = [...(chData.items || [])].sort(
          (a, b) => (a.order ?? 0) - (b.order ?? 0)
        );
        const fullChannel = { ...chData, items: sortedItems };
        setChannel(fullChannel);
        setCurrentIndex(0);

        try {
          localStorage.setItem(STORAGE_CHANNEL_CACHE_KEY, JSON.stringify(fullChannel));
        } catch {
          // Ignorar límite de storage
        }
      },
      () => {
        // Mantener caché si falla Firestore
      }
    );

    return () => unsub();
  }, [screen?.channelId]);

  const items: MediaItem[] = channel?.items || [];
  const activeItem: MediaItem | undefined =
    items.length > 0 ? items[currentIndex % items.length] : undefined;

  const advanceSlide = useCallback(() => {
    if (items.length <= 1) return;
    setCurrentIndex((prev) => (prev + 1) % items.length);
  }, [items.length]);

  // Temporizador para imágenes y videos de YouTube
  useEffect(() => {
    if (!activeItem || screen?.command !== 'playing' || !screen?.isPaired) return;
    if (activeItem.type === 'video') return; // Los videos avanzan con onEnded

    const durationMs = Math.max(3, Number(activeItem.duration) || 10) * 1000;
    const timer = setTimeout(advanceSlide, durationMs);
    return () => clearTimeout(timer);
  }, [activeItem, screen?.command, screen?.isPaired, advanceSlide]);

  // Reportar telemetría en vivo a la Torre de Control cada 20 segundos
  useEffect(() => {
    if (!screenId || !screen?.isPaired) return;

    const sendHeartbeat = () => {
      updateDoc(doc(db, 'screens', screenId), {
        telemetry: {
          lastSeen: Date.now(),
          isNetworkOnline: navigator.onLine,
          currentItemTitle: activeItem?.title || 'Sin contenido',
          currentItemId: activeItem?.id || '',
          cachedItemsCount: items.length,
          appVersion: APP_VERSION,
        },
      }).catch(() => {});
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 20000);
    return () => clearInterval(interval);
  }, [screenId, screen?.isPaired, activeItem?.id, activeItem?.title, items.length]);

  // Desbloquear audio del navegador con un clic/toque en pantalla
  const handleUnlockAudio = () => {
    if (!audioUnlocked) {
      setAudioUnlocked(true);
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          ctx.resume();
        }
      } catch {
        // Ignorar
      }
    }
  };

  // Pantalla de error inicial
  if (bootError) {
    return (
      <div className="w-screen h-screen bg-black text-white flex flex-col items-center justify-center p-8 text-center">
        <p className="text-xl font-bold text-red-400 mb-2">Error de conexión</p>
        <p className="text-neutral-400 text-sm">{bootError}</p>
      </div>
    );
  }

  // Pantalla de vinculación (código gigante de 6 dígitos)
  if (!screen || !screen.isPaired) {
    return (
      <div
        onClick={handleUnlockAudio}
        className="w-screen h-screen bg-neutral-950 text-white flex flex-col items-center justify-center p-8 select-none"
      >
        <div className="max-w-lg w-full bg-neutral-900/90 border border-neutral-800 rounded-3xl p-10 text-center shadow-2xl space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-semibold uppercase tracking-widest">
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
            Listo para vincular
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              Vincular este Televisor
            </h1>
            <p className="text-sm text-neutral-400">
              Ingresá este código en el Panel de Control para comenzar a transmitir
            </p>
          </div>

          <div className="bg-black border-2 border-neutral-800 rounded-2xl py-6 px-4">
            <span className="text-5xl md:text-6xl font-black font-mono tracking-[0.25em] text-white">
              {pairingCode || '......'}
            </span>
          </div>

          <p className="text-xs text-neutral-500">
            ID de dispositivo: {screenId || 'Registrando...'}
          </p>
        </div>
      </div>
    );
  }

  // Modo pantalla apagada (Blackout)
  if (screen.command === 'blackout') {
    return <div onClick={handleUnlockAudio} className="w-screen h-screen bg-black cursor-none" />;
  }

  const rotation = screen.rotation || 0;
  const isVerticalRotation = rotation === 90 || rotation === 270;
  const callerEnabled = Boolean(screen.callerEnabled);
  const currentCall = screen.callerState?.current || null;
  const callHistory = screen.callerState?.history || [];
  const theme = getCallerTheme(screen.callerTheme);

  return (
    <div
      onClick={handleUnlockAudio}
      className="w-screen h-screen bg-black text-white overflow-hidden relative select-none"
    >
      {/* Contenedor con rotación soportada (0, 90, 180, 270) */}
      <div
        style={{
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
          width: isVerticalRotation ? '100vh' : '100vw',
          height: isVerticalRotation ? '100vw' : '100vh',
          position: 'absolute',
          top: isVerticalRotation ? 'calc((100vh - 100vw) / 2)' : 0,
          left: isVerticalRotation ? 'calc((100vw - 100vh) / 2)' : 0,
        }}
        className={`flex ${isVerticalRotation ? 'flex-col' : 'flex-row'} bg-black`}
      >
        {/* Zona de Publicidades (100% si el llamador está OFF, 72% en modo L-Bar si está ON) */}
        <main
          className={`relative bg-black flex items-center justify-center overflow-hidden ${
            callerEnabled
              ? isVerticalRotation
                ? 'w-full h-[68%]'
                : 'w-[72%] h-full'
              : 'w-full h-full'
          }`}
        >
          {!activeItem ? (
            <div className="text-center space-y-2 p-6">
              <p className="text-xl font-bold text-neutral-300">{screen.name}</p>
              <p className="text-sm text-neutral-500">
                Canal asignado sin contenidos activos todavía
              </p>
            </div>
          ) : activeItem.type === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={activeItem.id}
              src={activeItem.url}
              alt={activeItem.title}
              className="w-full h-full object-contain bg-black"
            />
          ) : activeItem.type === 'video' ? (
            <video
              key={activeItem.id}
              ref={videoRef}
              src={activeItem.url}
              autoPlay
              muted
              playsInline
              loop={items.length === 1}
              onEnded={advanceSlide}
              onError={advanceSlide}
              className="w-full h-full object-contain bg-black"
            />
          ) : (
            <iframe
              key={activeItem.id}
              src={`https://www.youtube.com/embed/${
                activeItem.youtubeId || ''
              }?autoplay=1&mute=1&controls=0&rel=0&showinfo=0&loop=1&playlist=${
                activeItem.youtubeId || ''
              }`}
              title={activeItem.title}
              allow="autoplay; encrypted-media"
              className="w-full h-full border-0 pointer-events-none"
            />
          )}

          {/* Indicador sutil si está pausado desde la Torre de Control */}
          {screen.command === 'paused' && (
            <div className="absolute top-4 left-4 bg-black/75 border border-white/15 px-3 py-1 rounded-full text-xs text-amber-300">
              ⏸ Reproducción en pausa
            </div>
          )}

          {/* Indicador sutil si se cortó el Wi-Fi */}
          {!isOnline && (
            <div className="absolute bottom-3 left-3 bg-red-950/85 border border-red-500/40 px-2.5 py-1 rounded-lg text-[11px] text-red-200">
              Sin conexión · Modo caché local
            </div>
          )}

          {/* Aviso discreto para habilitar audio si el llamador está activo */}
          {callerEnabled && !audioUnlocked && (
            <div className="absolute bottom-3 right-3 bg-black/80 border border-white/20 px-3 py-1.5 rounded-xl text-xs text-neutral-200 animate-pulse">
              🔊 Tocá la pantalla para activar el timbre de turnos
            </div>
          )}
        </main>

        {/* Columna Lateral de Turnos (L-Bar) */}
        {callerEnabled && (
          <aside
            className={`${theme.playerSidebarBg} flex flex-col justify-between p-5 transition-colors duration-300 ${
              isVerticalRotation
                ? `w-full h-[32%] border-t-2 ${theme.playerBorder}`
                : `w-[28%] h-full border-l-2 ${theme.playerBorder}`
            }`}
          >
            {/* Cabecera de Turnos */}
            <div className={`flex items-center justify-between border-b ${theme.playerBorder} pb-3`}>
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${theme.playerDot} animate-pulse`} />
                <span
                  className={`text-xs md:text-sm font-bold uppercase tracking-[0.2em] ${theme.playerHeaderTitle}`}
                >
                  Turnos
                </span>
              </div>
              <span className={`text-[11px] font-mono ${theme.playerCodeText}`}>
                {screen.pairingCode}
              </span>
            </div>

            {/* Tarjeta del Llamado Actual */}
            <div
              className={`my-auto rounded-2xl p-5 text-center transition-all duration-500 border-2 ${
                callFlash ? theme.playerCardFlash : theme.playerCardIdle
              }`}
            >
              {currentCall ? (
                <div className="space-y-2">
                  <p
                    className={`text-xs font-bold uppercase tracking-widest ${
                      callFlash ? theme.playerLabelFlash : theme.playerLabelIdle
                    }`}
                  >
                    Llamando Ahora
                  </p>
                  <p className="text-4xl xl:text-5xl font-black tracking-tight break-words leading-tight">
                    {currentCall.ticket}
                  </p>
                  <div
                    className={`inline-block mt-1 px-4 py-1.5 rounded-xl text-base xl:text-xl font-extrabold uppercase tracking-wide ${
                      callFlash ? theme.playerDestFlash : theme.playerDestIdle
                    }`}
                  >
                    {currentCall.destination}
                  </div>
                </div>
              ) : (
                <div className="py-6 space-y-1">
                  <p className={`text-sm font-medium ${theme.playerCodeText}`}>
                    Sala de Espera
                  </p>
                  <p className={`text-xs ${theme.playerCodeText}`}>
                    Aguardando próximo llamado
                  </p>
                </div>
              )}
            </div>

            {/* Historial reciente de llamados */}
            <div className={`border-t ${theme.playerBorder} pt-3 space-y-2`}>
              <p
                className={`text-[11px] font-semibold uppercase tracking-wider ${theme.playerCodeText}`}
              >
                Últimos llamados
              </p>
              {callHistory.length === 0 ? (
                <p className={`text-xs ${theme.playerCodeText}`}>—</p>
              ) : (
                <ul className="space-y-1.5">
                  {callHistory.map((entry) => (
                    <li
                      key={entry.id}
                      className={`flex items-center justify-between gap-2 ${theme.playerHistoryCard} border rounded-xl px-3 py-2 text-xs xl:text-sm`}
                    >
                      <span className={`font-bold ${theme.playerHistoryTicket} truncate`}>
                        {entry.ticket}
                      </span>
                      <span className={`font-semibold ${theme.playerHistoryDest} shrink-0`}>
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