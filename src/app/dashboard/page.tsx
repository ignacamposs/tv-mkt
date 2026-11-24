'use client';

import React, { useEffect, useState, useRef } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  setDoc,
  getDoc,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Channel, MediaItem, Screen, ScreenRotation } from '../../types/signage';

const DEFAULT_PIN = '123456';
const PIN_STORAGE_KEY = 'signage_dashboard_unlocked';

type ScreenWithMeta = Screen & {
  id: string;
  lastSeen?: unknown;
  status?: string;
  currentStatus?: string;
  cachedCount?: number;
};

function extractYoutubeId(url: string): string | null {
  const regExp =
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regExp);
  return match ? match[1] : null;
}

function getTimestampMillis(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    'toMillis' in value &&
    typeof (value as { toMillis: () => number }).toMillis === 'function'
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }
  return 0;
}

export default function DashboardPage() {
  // Autenticación por PIN
  const [isUnlocked, setIsUnlocked] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
  const [activePin, setActivePin] = useState<string>(DEFAULT_PIN);
  const [newPin, setNewPin] = useState<string>('');
  const [showPinEditor, setShowPinEditor] = useState<boolean>(false);

  // Canales y programación
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>('');
  const [newChannelName, setNewChannelName] = useState<string>('');
  const [draftItems, setDraftItems] = useState<MediaItem[]>([]);
  const [hasChanges, setHasChanges] = useState<boolean>(false);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);

  // Formulario de nuevo contenido
  const [itemTitle, setItemTitle] = useState<string>('');
  const [itemType, setItemType] = useState<'image' | 'video' | 'youtube'>('image');
  const [itemUrl, setItemUrl] = useState<string>('');
  const [itemDuration, setItemDuration] = useState<number>(10);
  const [isUploading, setIsUploading] = useState<boolean>(false);

  // Simulador / Vista Previa en Vivo
  const [previewAspect, setPreviewAspect] = useState<'16:9' | '9:16'>('16:9');
  const [previewPlaying, setPreviewPlaying] = useState<boolean>(true);
  const [previewIndex, setPreviewIndex] = useState<number>(0);
  const [previewElapsedMs, setPreviewElapsedMs] = useState<number>(0);
  const [outgoingPreviewItem, setOutgoingPreviewItem] = useState<MediaItem | null>(null);
  const [outgoingPreviewFading, setOutgoingPreviewFading] = useState<boolean>(false);
  const lastPreviewItemRef = useRef<MediaItem | null>(null);

  // Pantallas vinculadas
  const [screens, setScreens] = useState<ScreenWithMeta[]>([]);
  const [pairingCode, setPairingCode] = useState<string>('');
  const [newScreenName, setNewScreenName] = useState<string>('');
  const [isPairing, setIsPairing] = useState<boolean>(false);

  // Feedback y reloj seguro para Next.js 16
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [now, setNow] = useState<number>(0);

  const showToast = (type: 'ok' | 'err', text: string) => {
    setFeedbackMsg({ type, text });
    setTimeout(() => setFeedbackMsg(null), 4000);
  };

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  // Cargar configuración de PIN
  useEffect(() => {
    const savedSession = sessionStorage.getItem(PIN_STORAGE_KEY);
    if (savedSession === 'true') {
      setIsUnlocked(true);
    }

    getDoc(doc(db, 'settings', 'security'))
      .then((snap) => {
        if (snap.exists() && snap.data()?.pin) {
          setActivePin(String(snap.data().pin));
        }
      })
      .catch(() => {});
  }, []);

  // Suscripción en tiempo real a canales
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'channels'), (snapshot) => {
      const list: Channel[] = snapshot.docs.map((d) => ({
        ...(d.data() as Channel),
        id: d.id,
      }));
      setChannels(list);

      if (list.length > 0) {
        setSelectedChannelId((prev) => {
          if (prev && list.some((c) => c.id === prev)) return prev;
          return list[0].id;
        });
      }
    });

    return () => unsub();
  }, []);

  // Sincronizar items del canal seleccionado cuando no hay ediciones pendientes
  useEffect(() => {
    if (!selectedChannelId) {
      setDraftItems([]);
      return;
    }
    const current = channels.find((c) => c.id === selectedChannelId);
    if (current && !hasChanges) {
      const sorted = [...(current.items || [])].sort((a, b) => a.order - b.order);
      setDraftItems(sorted);
    }
  }, [selectedChannelId, channels, hasChanges]);

  // Suscripción en tiempo real a pantallas
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'screens'), (snapshot) => {
      const list: ScreenWithMeta[] = snapshot.docs
        .map((d) => ({
          ...(d.data() as Screen),
          id: d.id,
        }))
        .filter((s) => s.isPaired);
      setScreens(list);
    });

    return () => unsub();
  }, []);

  // Lógica del Loop y barra de progreso en Vista Previa
  const safePreviewIndex = draftItems.length > 0 ? previewIndex % draftItems.length : 0;
  const activePreviewItem = draftItems[safePreviewIndex] || null;
  const activePreviewDurationMs = Math.max(activePreviewItem?.duration || 10, 2) * 1000;

  useEffect(() => {
    setPreviewElapsedMs(0);
  }, [activePreviewItem?.id, selectedChannelId]);

  useEffect(() => {
    if (!activePreviewItem || !previewPlaying || draftItems.length === 0) return;

    const tick = 100;
    const interval = setInterval(() => {
      setPreviewElapsedMs((prev) => {
        if (prev + tick >= activePreviewDurationMs) {
          setPreviewIndex((idx) => (idx + 1) % draftItems.length);
          return 0;
        }
        return prev + tick;
      });
    }, tick);

    return () => clearInterval(interval);
  }, [activePreviewItem, activePreviewDurationMs, previewPlaying, draftItems.length]);

  // Transición suave (Crossfade 0.5s) en Vista Previa
  useEffect(() => {
    const prev = lastPreviewItemRef.current;
    if (prev && activePreviewItem && prev.id !== activePreviewItem.id) {
      setOutgoingPreviewItem(prev);
      setOutgoingPreviewFading(false);

      const raf = requestAnimationFrame(() => {
        setOutgoingPreviewFading(true);
      });
      const cleanupTimer = setTimeout(() => {
        setOutgoingPreviewItem(null);
        setOutgoingPreviewFading(false);
      }, 520);

      lastPreviewItemRef.current = activePreviewItem;
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(cleanupTimer);
      };
    }

    lastPreviewItemRef.current = activePreviewItem;
  }, [activePreviewItem]);

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    if (pinInput.trim() === activePin || pinInput.trim() === DEFAULT_PIN) {
      setIsUnlocked(true);
      sessionStorage.setItem(PIN_STORAGE_KEY, 'true');
      setPinInput('');
    } else {
      showToast('err', 'PIN incorrecto');
    }
  };

  const handleSaveNewPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPin.trim().length < 4) {
      showToast('err', 'El PIN debe tener al menos 4 dígitos');
      return;
    }
    try {
      await setDoc(doc(db, 'settings', 'security'), { pin: newPin.trim() }, { merge: true });
      setActivePin(newPin.trim());
      setNewPin('');
      setShowPinEditor(false);
      showToast('ok', 'PIN actualizado correctamente');
    } catch {
      showToast('err', 'No se pudo guardar el PIN');
    }
  };

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    try {
      const docRef = await addDoc(collection(db, 'channels'), {
        name: newChannelName.trim(),
        items: [],
      });
      setNewChannelName('');
      setSelectedChannelId(docRef.id);
      setDraftItems([]);
      setHasChanges(false);
      showToast('ok', 'Canal creado');
    } catch {
      showToast('err', 'Error al crear el canal');
    }
  };

  const handleDeleteChannel = async (channelId: string) => {
    try {
      await deleteDoc(doc(db, 'channels', channelId));
      if (selectedChannelId === channelId) {
        setSelectedChannelId('');
        setDraftItems([]);
        setHasChanges(false);
      }
      showToast('ok', 'Canal eliminado');
    } catch {
      showToast('err', 'Error al eliminar canal');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    const uploadPreset =
      process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET ||
      process.env.NEXT_PUBLIC_CLOUDINARY_PRESET;

    if (!cloudName || !uploadPreset) {
      showToast('err', 'Faltan las variables de Cloudinary en el entorno');
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('upload_preset', uploadPreset);

      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Error en Cloudinary');
      const data = await res.json();

      const detectedType = file.type.startsWith('video/') ? 'video' : 'image';
      setItemType(detectedType);
      setItemUrl(data.secure_url);
      if (!itemTitle.trim()) {
        setItemTitle(file.name.replace(/\.[^/.]+$/, ''));
      }
      showToast('ok', 'Archivo subido listo para agregar');
    } catch {
      showToast('err', 'Error subiendo archivo a Cloudinary');
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedChannelId) {
      showToast('err', 'Creá o seleccioná un canal primero');
      return;
    }
    if (!itemUrl.trim()) {
      showToast('err', 'Subí un archivo o pegá una URL');
      return;
    }

    let finalType = itemType;
    let ytId: string | undefined;

    if (
      itemType === 'youtube' ||
      itemUrl.includes('youtube.com') ||
      itemUrl.includes('youtu.be')
    ) {
      const extracted = extractYoutubeId(itemUrl.trim());
      if (!extracted) {
        showToast('err', 'El enlace de YouTube no es válido');
        return;
      }
      finalType = 'youtube';
      ytId = extracted;
    }

    const newItem: MediaItem = {
      id: Date.now().toString(),
      title: itemTitle.trim() || 'Contenido sin título',
      type: finalType,
      url: itemUrl.trim(),
      ...(ytId ? { youtubeId: ytId } : {}),
      duration: Math.max(Number(itemDuration) || 10, 2),
      order: draftItems.length,
    };

    setDraftItems((prev) => [...prev, newItem]);
    setHasChanges(true);
    setItemTitle('');
    setItemUrl('');
    setItemDuration(10);
  };

  const handleRemoveItem = (id: string) => {
    setDraftItems((prev) =>
      prev.filter((item) => item.id !== id).map((item, idx) => ({ ...item, order: idx }))
    );
    setHasChanges(true);
  };

  const handleMoveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draftItems.length) return;
    const updated = [...draftItems];
    const temp = updated[index];
    updated[index] = updated[target];
    updated[target] = temp;
    setDraftItems(updated.map((item, idx) => ({ ...item, order: idx })));
    setHasChanges(true);
  };

  const handlePublish = async () => {
    if (!selectedChannelId) return;
    setIsPublishing(true);
    try {
      const normalized = draftItems.map((item, idx) => ({ ...item, order: idx }));
      await updateDoc(doc(db, 'channels', selectedChannelId), {
        items: normalized,
      });
      setHasChanges(false);
      showToast('ok', 'Programación publicada en todas las pantallas');
    } catch {
      showToast('err', 'Error al publicar en Firestore');
    } finally {
      setIsPublishing(false);
    }
  };

  const handlePairScreen = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = pairingCode.trim().toUpperCase();
    if (!code) return;

    setIsPairing(true);
    try {
      const q = query(collection(db, 'screens'), where('pairingCode', '==', code));
      const snap = await getDocs(q);

      if (snap.empty) {
        showToast('err', 'No se encontró ninguna pantalla con ese código');
        return;
      }

      const targetDoc = snap.docs[0];
      await updateDoc(doc(db, 'screens', targetDoc.id), {
        isPaired: true,
        name: newScreenName.trim() || `Pantalla ${code}`,
        channelId: selectedChannelId || '',
        command: 'playing',
        rotation: 0,
      });

      setPairingCode('');
      setNewScreenName('');
      showToast('ok', 'Pantalla vinculada con éxito');
    } catch {
      showToast('err', 'Error al vincular la pantalla');
    } finally {
      setIsPairing(false);
    }
  };

  const handleUpdateScreen = async (screenId: string, patch: Partial<Screen>) => {
    try {
      await updateDoc(doc(db, 'screens', screenId), patch);
    } catch {
      showToast('err', 'Error actualizando la pantalla');
    }
  };

  const handleUnpairScreen = async (screenId: string) => {
    try {
      await updateDoc(doc(db, 'screens', screenId), {
        isPaired: false,
        channelId: '',
      });
      showToast('ok', 'Pantalla desvinculada');
    } catch {
      showToast('err', 'Error al desvincular');
    }
  };

  if (!isUnlocked) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-6">
        <form
          onSubmit={handleUnlock}
          className="w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-2xl p-8 shadow-2xl"
        >
          <h1 className="text-2xl font-bold mb-2">Panel de Control</h1>
          <p className="text-sm text-neutral-400 mb-6">
            Ingresá el PIN de administrador para gestionar pantallas y canales.
          </p>
          <input
            type="password"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            placeholder="PIN (ej. 123456)"
            className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3 text-center text-xl tracking-widest mb-4 focus:outline-none focus:border-emerald-500"
            autoFocus
          />
          <button
            type="submit"
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 rounded-xl transition"
          >
            Ingresar
          </button>
          {feedbackMsg && (
            <p className="mt-4 text-center text-sm text-red-400">{feedbackMsg.text}</p>
          )}
        </form>
      </div>
    );
  }

  const progressPercent = Math.min(
    100,
    Math.round((previewElapsedMs / activePreviewDurationMs) * 100)
  );
  const remainingSec = Math.max(
    0,
    Math.ceil((activePreviewDurationMs - previewElapsedMs) / 1000)
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-6 md:p-10">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800 pb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Gestión de Cartelería Digital</h1>
            <p className="text-sm text-neutral-400">
              Control remoto de canales, previsualización en vivo y televisores en tiempo real
            </p>
          </div>

          <div className="flex items-center gap-3">
            <a
              href="/player"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 px-4 py-2 rounded-xl text-sm font-medium text-emerald-400 transition"
            >
              Simular TV (/player) ↗
            </a>

            {showPinEditor ? (
              <form onSubmit={handleSaveNewPin} className="flex items-center gap-2">
                <input
                  type="text"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  placeholder="Nuevo PIN"
                  className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-sm w-28"
                />
                <button
                  type="submit"
                  className="bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded-lg text-sm font-medium"
                >
                  Guardar
                </button>
                <button
                  type="button"
                  onClick={() => setShowPinEditor(false)}
                  className="text-neutral-400 hover:text-white text-sm px-2"
                >
                  Cancelar
                </button>
              </form>
            ) : (
              <button
                onClick={() => setShowPinEditor(true)}
                className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 px-4 py-2 rounded-xl text-sm font-medium transition"
              >
                Cambiar PIN
              </button>
            )}
          </div>
        </header>

        {feedbackMsg && (
          <div
            className={`px-4 py-3 rounded-xl text-sm font-medium border ${
              feedbackMsg.type === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}
          >
            {feedbackMsg.text}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Columna Izquierda: Canales, Vista Previa y Playlist */}
          <section className="lg:col-span-7 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">Canales y Programación</h2>

              <form onSubmit={handleCreateChannel} className="flex gap-2">
                <input
                  type="text"
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  placeholder="Nuevo canal (ej. Promos)"
                  className="bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                />
                <button
                  type="submit"
                  className="bg-neutral-800 hover:bg-neutral-700 px-4 py-2 rounded-xl text-sm font-medium transition"
                >
                  + Crear
                </button>
              </form>
            </div>

            {/* Selector de canal activo */}
            {channels.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {channels.map((ch) => (
                  <div
                    key={ch.id}
                    className={`flex items-center rounded-xl border text-sm transition ${
                      selectedChannelId === ch.id
                        ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-300 hover:border-neutral-700'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setHasChanges(false);
                        setSelectedChannelId(ch.id);
                        setPreviewIndex(0);
                      }}
                      className="px-4 py-2 font-medium"
                    >
                      {ch.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteChannel(ch.id)}
                      title="Eliminar canal"
                      className="pr-3 pl-1 py-2 text-neutral-500 hover:text-red-400"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-neutral-500">
                Creá tu primer canal para empezar a cargar imágenes o videos.
              </p>
            )}

            {/* Monitor de Previsualización en Vivo */}
            {selectedChannelId && (
              <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                      Vista Previa del Loop
                    </span>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                        hasChanges
                          ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                          : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      }`}
                    >
                      {hasChanges ? 'Borrador sin publicar' : 'Publicado'}
                    </span>
                  </div>

                  {/* Selector de Formato Horizontal / Vertical */}
                  <div className="flex items-center gap-1 bg-neutral-900 p-1 rounded-lg border border-neutral-800">
                    <button
                      type="button"
                      onClick={() => setPreviewAspect('16:9')}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                        previewAspect === '16:9'
                          ? 'bg-neutral-700 text-white'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      Horizontal 16:9
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewAspect('9:16')}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                        previewAspect === '9:16'
                          ? 'bg-neutral-700 text-white'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      Vertical 9:16
                    </button>
                  </div>
                </div>

                {/* Marco de pantalla simulada */}
                <div className="w-full bg-black/80 rounded-xl p-4 flex items-center justify-center border border-neutral-900">
                  <div
                    className={`relative bg-black border-2 border-neutral-800 rounded-lg overflow-hidden shadow-2xl flex items-center justify-center transition-all duration-300 ${
                      previewAspect === '16:9'
                        ? 'w-full aspect-video'
                        : 'w-52 sm:w-60 aspect-[9/16]'
                    }`}
                  >
                    {!activePreviewItem ? (
                      <div className="text-center px-4 text-xs text-neutral-500">
                        Agregá una imagen, video o YouTube para previsualizar cómo se verá en el TV.
                      </div>
                    ) : (
                      <>
                        {/* Capa entrante (siempre activa debajo) */}
                        <div className="absolute inset-0 flex items-center justify-center">
                          {activePreviewItem.type === 'image' && (
                            <img
                              key={`in-${activePreviewItem.id}`}
                              src={activePreviewItem.url}
                              alt={activePreviewItem.title}
                              className="w-full h-full object-contain"
                            />
                          )}
                          {activePreviewItem.type === 'video' && (
                            <video
                              key={`in-${activePreviewItem.id}`}
                              src={activePreviewItem.url}
                              autoPlay={previewPlaying}
                              muted
                              loop
                              playsInline
                              className="w-full h-full object-contain"
                            />
                          )}
                          {activePreviewItem.type === 'youtube' &&
                            activePreviewItem.youtubeId && (
                              <iframe
                                key={`in-${activePreviewItem.id}`}
                                className="w-full h-full pointer-events-none"
                                src={`https://www.youtube.com/embed/${activePreviewItem.youtubeId}?autoplay=${
                                  previewPlaying ? 1 : 0
                                }&mute=1&controls=0&rel=0&modestbranding=1&playsinline=1`}
                                title={activePreviewItem.title}
                                allow="autoplay; encrypted-media"
                              />
                            )}
                        </div>

                        {/* Capa saliente (fundido suave de 0.5s al cambiar de spot) */}
                        {outgoingPreviewItem && (
                          <div
                            className={`absolute inset-0 bg-black flex items-center justify-center pointer-events-none transition-opacity duration-500 ${
                              outgoingPreviewFading ? 'opacity-0' : 'opacity-100'
                            }`}
                          >
                            {outgoingPreviewItem.type === 'image' && (
                              <img
                                src={outgoingPreviewItem.url}
                                alt={outgoingPreviewItem.title}
                                className="w-full h-full object-contain"
                              />
                            )}
                            {outgoingPreviewItem.type === 'video' && (
                              <video
                                src={outgoingPreviewItem.url}
                                muted
                                playsInline
                                className="w-full h-full object-contain"
                              />
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Barra de progreso y controles de simulación */}
                {activePreviewItem && (
                  <div className="space-y-2">
                    <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-100"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-neutral-400">
                      <span className="truncate max-w-[60%]">
                        Spot {safePreviewIndex + 1}/{draftItems.length}:{' '}
                        <strong className="text-neutral-200">{activePreviewItem.title}</strong> (
                        {remainingSec}s)
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setPreviewPlaying((p) => !p)}
                          className="px-2.5 py-1 rounded bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-200"
                        >
                          {previewPlaying ? '⏸ Pausar' : '▶ Reproducir'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewIndex((idx) => (idx + 1) % draftItems.length)
                          }
                          className="px-2.5 py-1 rounded bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-200"
                        >
                          Siguiente ⏭
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Formulario agregar contenido */}
            {selectedChannelId && (
              <form
                onSubmit={handleAddItem}
                className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-neutral-300">
                    Agregar contenido al canal
                  </span>
                  <label className="cursor-pointer bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition">
                    {isUploading ? 'Subiendo...' : 'Elegir Archivo (Imagen / MP4)'}
                    <input
                      type="file"
                      accept="image/*,video/mp4,video/webm"
                      onChange={handleFileUpload}
                      disabled={isUploading}
                      className="hidden"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <input
                    type="text"
                    value={itemTitle}
                    onChange={(e) => setItemTitle(e.target.value)}
                    placeholder="Título del anuncio"
                    className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                  />
                  <select
                    value={itemType}
                    onChange={(e) =>
                      setItemType(e.target.value as 'image' | 'video' | 'youtube')
                    }
                    className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="image">Imagen (URL / Subida)</option>
                    <option value="video">Video MP4 (URL / Subida)</option>
                    <option value="youtube">YouTube Link</option>
                  </select>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={2}
                      max={3600}
                      value={itemDuration}
                      onChange={(e) => setItemDuration(Number(e.target.value))}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                    />
                    <span className="text-xs text-neutral-400">seg</span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={itemUrl}
                    onChange={(e) => setItemUrl(e.target.value)}
                    placeholder="URL directa del archivo o enlace de YouTube"
                    className="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    type="submit"
                    disabled={isUploading}
                    className="bg-neutral-800 hover:bg-neutral-700 px-4 py-2 rounded-lg text-sm font-medium transition"
                  >
                    Agregar
                  </button>
                </div>
              </form>
            )}

            {/* Lista de reproducción */}
            {selectedChannelId && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-neutral-400">
                    Lista de reproducción ({draftItems.length})
                  </h3>
                  <button
                    type="button"
                    onClick={handlePublish}
                    disabled={isPublishing}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
                      hasChanges
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
                        : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
                    }`}
                  >
                    {isPublishing ? 'Publicando...' : 'Publicar en Pantallas'}
                  </button>
                </div>

                {draftItems.length === 0 ? (
                  <div className="border border-dashed border-neutral-800 rounded-xl p-6 text-center text-sm text-neutral-500">
                    Este canal todavía no tiene contenidos.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {draftItems.map((item, idx) => {
                      const isCurrentInPreview = activePreviewItem?.id === item.id;
                      return (
                        <li
                          key={item.id}
                          onClick={() => setPreviewIndex(idx)}
                          className={`cursor-pointer flex items-center justify-between gap-3 bg-neutral-950 border rounded-xl p-3 transition ${
                            isCurrentInPreview
                              ? 'border-emerald-500/60 bg-emerald-950/10'
                              : 'border-neutral-800 hover:border-neutral-700'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-neutral-800 text-neutral-300">
                                {item.type}
                              </span>
                              <p className="font-medium text-sm truncate">{item.title}</p>
                            </div>
                            <p className="text-xs text-neutral-500 truncate mt-1">
                              {item.duration}s • {item.url}
                            </p>
                          </div>

                          <div
                            className="flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => handleMoveItem(idx, -1)}
                              disabled={idx === 0}
                              className="p-1.5 text-neutral-400 hover:text-white disabled:opacity-30"
                              title="Subir"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMoveItem(idx, 1)}
                              disabled={idx === draftItems.length - 1}
                              className="p-1.5 text-neutral-400 hover:text-white disabled:opacity-30"
                              title="Bajar"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveItem(item.id)}
                              className="p-1.5 text-red-400 hover:text-red-300 ml-1"
                              title="Eliminar"
                            >
                              🗑
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* Columna Derecha: Pantallas */}
          <section className="lg:col-span-5 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
            <h2 className="text-lg font-semibold">Pantallas Conectadas</h2>

            <form
              onSubmit={handlePairScreen}
              className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-neutral-300">Vincular nueva pantalla</p>
                <a
                  href="/player"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-emerald-400 hover:underline"
                >
                  Obtener código en /player ↗
                </a>
              </div>
              <p className="text-xs text-neutral-500">
                Abrí <code className="text-neutral-300">/player</code> en el televisor (o en una
                pestaña nueva) e ingresá el código de 6 dígitos que muestra en pantalla.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value)}
                  placeholder="Código 6 dígitos"
                  maxLength={6}
                  className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm font-mono uppercase"
                />
                <input
                  type="text"
                  value={newScreenName}
                  onChange={(e) => setNewScreenName(e.target.value)}
                  placeholder="Nombre (ej. Vidriera)"
                  className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={isPairing}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2 rounded-lg text-sm transition"
              >
                {isPairing ? 'Vinculando...' : 'Vincular Pantalla'}
              </button>
            </form>

            {screens.length === 0 ? (
              <p className="text-sm text-neutral-500 text-center py-6">
                No hay pantallas vinculadas todavía.
              </p>
            ) : (
              <div className="space-y-4">
                {screens.map((scr) => {
                  const lastSeenMs = getTimestampMillis(scr.lastSeen);
                  const isOnline = now > 0 && lastSeenMs > 0 && now - lastSeenMs < 75000;

                  return (
                    <div
                      key={scr.id}
                      className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-full ${
                              isOnline ? 'bg-emerald-500' : 'bg-neutral-600'
                            }`}
                          />
                          <h3 className="font-semibold text-sm">{scr.name}</h3>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleUnpairScreen(scr.id)}
                          className="text-xs text-neutral-500 hover:text-red-400"
                        >
                          Desvincular
                        </button>
                      </div>

                      <p className="text-xs text-neutral-500">
                        Estado: {scr.currentStatus || scr.status || 'Activo'} • Código:{' '}
                        <span className="font-mono">{scr.pairingCode}</span>
                      </p>

                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={scr.channelId || ''}
                          onChange={(e) =>
                            handleUpdateScreen(scr.id, { channelId: e.target.value })
                          }
                          className="bg-neutral-900 border border-neutral-700 rounded-lg px-2.5 py-1.5 text-xs"
                        >
                          <option value="">-- Sin canal --</option>
                          {channels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>

                        <select
                          value={scr.rotation || 0}
                          onChange={(e) =>
                            handleUpdateScreen(scr.id, {
                              rotation: Number(e.target.value) as ScreenRotation,
                            })
                          }
                          className="bg-neutral-900 border border-neutral-700 rounded-lg px-2.5 py-1.5 text-xs"
                        >
                          <option value={0}>Horizontal (0°)</option>
                          <option value={90}>Vertical (90°)</option>
                          <option value={180}>Invertido (180°)</option>
                          <option value={270}>Vertical (270°)</option>
                        </select>
                      </div>

                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => handleUpdateScreen(scr.id, { command: 'playing' })}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium border ${
                            scr.command === 'playing'
                              ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                              : 'bg-neutral-900 border-neutral-800 text-neutral-400'
                          }`}
                        >
                          ▶ Play
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdateScreen(scr.id, { command: 'paused' })}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium border ${
                            scr.command === 'paused'
                              ? 'bg-amber-600/20 border-amber-500 text-amber-300'
                              : 'bg-neutral-900 border-neutral-800 text-neutral-400'
                          }`}
                        >
                          ⏸ Pausa
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdateScreen(scr.id, { command: 'blackout' })}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium border ${
                            scr.command === 'blackout'
                              ? 'bg-red-600/20 border-red-500 text-red-300'
                              : 'bg-neutral-900 border-neutral-800 text-neutral-400'
                          }`}
                        >
                          ⬛ Apagar
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}