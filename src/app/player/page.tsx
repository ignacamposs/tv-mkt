'use client';

import React, { useEffect, useState, useRef } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Channel, MediaItem, Screen } from '../../types/signage';
import { MediaCacheManager } from '../../services/mediaCache';
import { initializeDevice, sendTelemetryHeartbeat } from '../../services/playerService';

const LOCAL_SCREEN_BACKUP = 'signage_backup_screen';
const LOCAL_CHANNEL_BACKUP = 'signage_backup_channel';

export default function PlayerPage() {
  const [screenId, setScreenId] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  // Transición suave (Crossfade 0.5s) entre spots
  const [outgoingItem, setOutgoingItem] = useState<MediaItem | null>(null);
  const [outgoingFading, setOutgoingFading] = useState<boolean>(false);
  const lastItemRef = useRef<MediaItem | null>(null);

  const cacheManagerRef = useRef<MediaCacheManager | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    cacheManagerRef.current = new MediaCacheManager();
    setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    let wakeLock: WakeLockSentinel | null = null;
    if ('wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((lock) => {
          wakeLock = lock;
        })
        .catch(() => {});
    }

    const savedScreen = localStorage.getItem(LOCAL_SCREEN_BACKUP);
    const savedChannel = localStorage.getItem(LOCAL_CHANNEL_BACKUP);
    if (savedScreen) setScreen(JSON.parse(savedScreen));
    if (savedChannel) {
      const parsedChannel: Channel = JSON.parse(savedChannel);
      setChannel(parsedChannel);
      cacheManagerRef.current.syncPlaylist(parsedChannel.items).then(setBlobUrls);
    }

    initializeDevice().then(({ screenId: id }) => {
      setScreenId(id);
    });

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (wakeLock) wakeLock.release().catch(() => {});
      cacheManagerRef.current?.cleanup();
    };
  }, []);

  useEffect(() => {
    if (!screenId) return;

    const unsubScreen = onSnapshot(
      doc(db, 'screens', screenId),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data() as Screen;
          setScreen(data);
          localStorage.setItem(LOCAL_SCREEN_BACKUP, JSON.stringify(data));
        }
      },
      (err) => console.debug('[Player] Esperando reconexión para pantalla...', err)
    );

    return () => unsubScreen();
  }, [screenId]);

  useEffect(() => {
    if (!screen?.channelId) {
      setChannel(null);
      return;
    }

    const unsubChannel = onSnapshot(
      doc(db, 'channels', screen.channelId),
      async (snapshot) => {
        if (snapshot.exists()) {
          const channelData = { id: snapshot.id, ...snapshot.data() } as Channel;
          const sortedItems = [...(channelData.items || [])].sort((a, b) => a.order - b.order);
          const updatedChannel = { ...channelData, items: sortedItems };

          setChannel(updatedChannel);
          localStorage.setItem(LOCAL_CHANNEL_BACKUP, JSON.stringify(updatedChannel));

          if (cacheManagerRef.current) {
            setIsSyncing(true);
            const urls = await cacheManagerRef.current.syncPlaylist(sortedItems);
            setBlobUrls(urls);
            setIsSyncing(false);
          }
        }
      },
      (err) => console.debug('[Player] Usando canal en caché local...', err)
    );

    return () => unsubChannel();
  }, [screen?.channelId]);

  const playableItems: MediaItem[] = (channel?.items || []).filter((item) => {
    if (!isOnline && item.type === 'youtube') return false;
    return true;
  });

  const safeIndex = playableItems.length > 0 ? currentIndex % playableItems.length : 0;
  const currentItem = playableItems[safeIndex] || null;

  // Ejecutar crossfade suave al cambiar de spot
  useEffect(() => {
    const prev = lastItemRef.current;
    if (prev && currentItem && prev.id !== currentItem.id) {
      setOutgoingItem(prev);
      setOutgoingFading(false);

      const raf = requestAnimationFrame(() => {
        setOutgoingFading(true);
      });
      const cleanupTimer = setTimeout(() => {
        setOutgoingItem(null);
        setOutgoingFading(false);
      }, 520);

      lastItemRef.current = currentItem;
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(cleanupTimer);
      };
    }

    lastItemRef.current = currentItem;
  }, [currentItem]);

  // Controla Play / Pausa real en videos MP4 y evita bloqueo de autoplay
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || currentItem?.type !== 'video') return;

    if (screen?.command === 'playing') {
      videoEl.play().catch(() => {
        videoEl.muted = true;
        videoEl.play().catch(() => {});
      });
    } else {
      videoEl.pause();
    }
  }, [currentItem, screen?.command]);

  useEffect(() => {
    if (!currentItem || screen?.command !== 'playing' || playableItems.length === 0) {
      return;
    }

    const durationMs = Math.max(currentItem.duration || 10, 2) * 1000;
    const timer = setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % playableItems.length);
    }, durationMs);

    return () => clearTimeout(timer);
  }, [currentItem, screen?.command, playableItems.length]);

  useEffect(() => {
    if (!screenId) return;

    const reportStatus = () => {
      const statusText = !screen?.isPaired
        ? 'Esperando vinculación'
        : screen?.command === 'blackout'
        ? 'Pantalla apagada (Blackout)'
        : screen?.command === 'paused'
        ? `Pausado: ${currentItem?.title || 'Sin contenido'}`
        : currentItem?.title || 'Canal vacío';

      sendTelemetryHeartbeat(screenId, statusText, Object.keys(blobUrls).length);
    };

    reportStatus();
    const interval = setInterval(reportStatus, 30000);
    return () => clearInterval(interval);
  }, [screenId, screen?.isPaired, screen?.command, currentItem?.title, blobUrls]);

  const rotation = screen?.rotation || 0;
  const isVertical = rotation === 90 || rotation === 270;
  const containerStyle: React.CSSProperties = isVertical
    ? {
        width: '100vh',
        height: '100vw',
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center center',
      }
    : {
        width: '100vw',
        height: '100vh',
        transform: `rotate(${rotation}deg)`,
      };

  if (!screen || !screen.isPaired) {
    return (
      <div className="fixed inset-0 bg-neutral-950 text-white flex flex-col items-center justify-center p-8 select-none">
        <div className="max-w-xl w-full bg-neutral-900 border border-neutral-800 rounded-3xl p-10 text-center shadow-2xl">
          <div className="inline-block px-4 py-1.5 rounded-full bg-emerald-500/10 text-emerald-400 text-sm font-medium mb-6">
            Listo para vincular
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-3">Conectar esta pantalla</h1>
          <p className="text-neutral-400 mb-8">
            Ingresá este código en tu panel de control para asignar un canal de contenido:
          </p>

          <div className="bg-black border-2 border-neutral-700 rounded-2xl py-6 px-8 mb-6">
            <span className="font-mono text-6xl font-extrabold tracking-[0.25em] text-white">
              {screen?.pairingCode || '......'}
            </span>
          </div>

          <div className="flex items-center justify-center gap-2 text-xs text-neutral-500">
            <span
              className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-amber-500'}`}
            />
            <span>{isOnline ? 'Conectado al servidor' : 'Sin conexión a internet'}</span>
          </div>
        </div>
      </div>
    );
  }

  if (screen.command === 'blackout') {
    return <div className="fixed inset-0 bg-black cursor-none" />;
  }

  return (
    <div className="fixed inset-0 bg-black overflow-hidden flex items-center justify-center cursor-none select-none">
      <div
        style={containerStyle}
        className="relative bg-black flex items-center justify-center overflow-hidden"
      >
        {!currentItem ? (
          <div className="text-center text-neutral-400">
            <p className="text-2xl font-semibold text-white mb-2">{screen.name}</p>
            <p>
              {isSyncing ? 'Descargando contenidos...' : 'Canal asignado sin contenidos activos'}
            </p>
          </div>
        ) : (
          <>
            {/* Capa actual */}
            <div className="absolute inset-0 flex items-center justify-center">
              {currentItem.type === 'image' && (
                <img
                  key={currentItem.id}
                  src={blobUrls[currentItem.url] || currentItem.url}
                  alt={currentItem.title}
                  className="w-full h-full object-contain"
                />
              )}

              {currentItem.type === 'video' && (
                <video
                  ref={videoRef}
                  key={currentItem.id}
                  src={blobUrls[currentItem.url] || currentItem.url}
                  autoPlay={screen.command === 'playing'}
                  loop
                  playsInline
                  className="w-full h-full object-contain"
                />
              )}

              {currentItem.type === 'youtube' && currentItem.youtubeId && (
                <iframe
                  key={currentItem.id}
                  className="w-full h-full pointer-events-none"
                  src={`https://www.youtube.com/embed/${currentItem.youtubeId}?autoplay=${
                    screen.command === 'playing' ? 1 : 0
                  }&mute=1&controls=0&rel=0&modestbranding=1&iv_load_policy=3&playsinline=1`}
                  title={currentItem.title}
                  allow="autoplay; encrypted-media"
                />
              )}
            </div>

            {/* Capa anterior disolviéndose suavemente (0.5s) */}
            {outgoingItem && (
              <div
                className={`absolute inset-0 bg-black flex items-center justify-center pointer-events-none transition-opacity duration-500 ${
                  outgoingFading ? 'opacity-0' : 'opacity-100'
                }`}
              >
                {outgoingItem.type === 'image' && (
                  <img
                    src={blobUrls[outgoingItem.url] || outgoingItem.url}
                    alt={outgoingItem.title}
                    className="w-full h-full object-contain"
                  />
                )}
                {outgoingItem.type === 'video' && (
                  <video
                    src={blobUrls[outgoingItem.url] || outgoingItem.url}
                    muted
                    playsInline
                    className="w-full h-full object-contain"
                  />
                )}
              </div>
            )}
          </>
        )}

        {!isOnline && (
          <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded bg-black/70 border border-amber-500/40 text-amber-400 text-xs font-mono">
            MODO OFFLINE
          </div>
        )}
      </div>
    </div>
  );
}