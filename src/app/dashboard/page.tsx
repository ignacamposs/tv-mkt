'use client';

import React, { useEffect, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  getDoc,
  query,
  where,
  getDocs,
} from 'firebase/firestore';
import {
  Tv,
  Plus,
  Play,
  Pause,
  PowerOff,
  RotateCw,
  ShieldCheck,
  Trash2,
  Video,
  Image as ImageIcon,
  Film,
  Wifi,
  WifiOff,
  Send,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { Channel, MediaItem, MediaType, PlaybackCommand, Screen, ScreenRotation } from '../../types/signage';
import { extractYouTubeId, hashSecurityPin } from '../../lib/securityAndMedia';

const DEFAULT_PIN = '123456';

export default function DashboardPage() {
  const [screens, setScreens] = useState<Screen[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const [newChannelName, setNewChannelName] = useState('');

  const [itemTitle, setItemTitle] = useState('');
  const [itemType, setItemType] = useState<MediaType>('image');
  const [itemUrl, setItemUrl] = useState('');
  const [itemDuration, setItemDuration] = useState<number>(10);
  const [draftItems, setDraftItems] = useState<MediaItem[]>([]);

  const [pairCode, setPairCode] = useState('');
  const [pairName, setPairName] = useState('');
  const [pairChannelId, setPairChannelId] = useState('');

  const [securityPinInput, setSecurityPinInput] = useState('');
  const [storedPinHash, setStoredPinHash] = useState<string>('');
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [now, setNow] = useState<number>(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function initSecurityConfig() {
      const configRef = doc(db, 'system_config', 'security');
      const snap = await getDoc(configRef);
      if (!snap.exists()) {
        const defaultHash = await hashSecurityPin(DEFAULT_PIN);
        await setDoc(configRef, { pinHash: defaultHash });
        setStoredPinHash(defaultHash);
      } else {
        setStoredPinHash(snap.data().pinHash);
      }
    }
    initSecurityConfig();
  }, []);

  useEffect(() => {
    const unsubScreens = onSnapshot(collection(db, 'screens'), (snapshot) => {
      const list = snapshot.docs.map((d) => d.data() as Screen);
      setScreens(list.filter((s) => s.isPaired));
    });

    const unsubChannels = onSnapshot(collection(db, 'channels'), (snapshot) => {
      const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Channel));
      setChannels(list);
      if (list.length > 0 && !selectedChannelId) {
        setSelectedChannelId(list[0].id);
        setDraftItems(list[0].items || []);
      }
    });

    return () => {
      unsubScreens();
      unsubChannels();
    };
  }, [selectedChannelId]);

  const showFeedback = (type: 'ok' | 'err', text: string) => {
    setFeedbackMsg({ type, text });
    setTimeout(() => setFeedbackMsg(null), 4000);
  };

  const verifyPin = async (): Promise<boolean> => {
    if (!securityPinInput.trim()) {
      showFeedback('err', 'Ingresá el PIN de seguridad (123456 por defecto) para confirmar.');
      return false;
    }
    const inputHash = await hashSecurityPin(securityPinInput);
    if (inputHash !== storedPinHash) {
      showFeedback('err', 'PIN de seguridad incorrecto. Acción bloqueada.');
      return false;
    }
    return true;
  };

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    if (!(await verifyPin())) return;

    const id = `ch_${Date.now()}`;
    const newCh: Channel = {
      id,
      name: newChannelName.trim(),
      items: [],
      updatedAt: Date.now(),
    };
    await setDoc(doc(db, 'channels', id), newCh);
    setNewChannelName('');
    setSelectedChannelId(id);
    setDraftItems([]);
    showFeedback('ok', `Canal "${newCh.name}" creado.`);
  };

  const handleSelectChannel = (ch: Channel) => {
    setSelectedChannelId(ch.id);
    setDraftItems(ch.items || []);
  };

  const handleAddDraftItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemUrl.trim() || !itemTitle.trim()) return;

    let youtubeId: string | undefined;
    if (itemType === 'youtube') {
      const extracted = extractYouTubeId(itemUrl);
      if (!extracted) {
        showFeedback('err', 'El enlace de YouTube no es válido.');
        return;
      }
      youtubeId = extracted;
    }

    const newItem: MediaItem = {
      id: `item_${Date.now()}`,
      type: itemType,
      title: itemTitle.trim(),
      url: itemUrl.trim(),
      ...(youtubeId ? { youtubeId } : {}),
      duration: Math.max(2, Number(itemDuration) || 10),
      order: draftItems.length,
    };

    setDraftItems([...draftItems, newItem]);
    setItemTitle('');
    setItemUrl('');
  };

  const handleRemoveDraftItem = (id: string) => {
    setDraftItems(draftItems.filter((item) => item.id !== id).map((item, idx) => ({ ...item, order: idx })));
  };

  const handlePublishChannel = async () => {
    if (!selectedChannelId) return;
    if (!(await verifyPin())) return;

    await updateDoc(doc(db, 'channels', selectedChannelId), {
      items: draftItems,
      updatedAt: Date.now(),
    });
    showFeedback('ok', '¡Programación publicada! Las pantallas vinculadas se están actualizando.');
  };

  const handlePairScreen = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = pairCode.trim().toUpperCase();
    if (!cleanCode) return;
    if (!(await verifyPin())) return;

    const q = query(collection(db, 'screens'), where('pairingCode', '==', cleanCode));
    const snap = await getDocs(q);

    if (snap.empty) {
      showFeedback('err', `No se encontró ninguna pantalla esperando con el código ${cleanCode}.`);
      return;
    }

    const screenDoc = snap.docs[0];
    await updateDoc(doc(db, 'screens', screenDoc.id), {
      isPaired: true,
      name: pairName.trim() || `Pantalla ${cleanCode}`,
      channelId: pairChannelId || (channels[0]?.id ?? null),
      command: 'playing',
    });

    setPairCode('');
    setPairName('');
    showFeedback('ok', '¡Pantalla vinculada correctamente!');
  };

  const handleScreenCommand = async (screenId: string, command: PlaybackCommand) => {
    if (!(await verifyPin())) return;
    await updateDoc(doc(db, 'screens', screenId), { command });
    showFeedback('ok', `Comando "${command}" enviado a la pantalla.`);
  };

  const handleScreenChannelChange = async (screenId: string, channelId: string) => {
    if (!(await verifyPin())) return;
    await updateDoc(doc(db, 'screens', screenId), { channelId: channelId || null });
    showFeedback('ok', 'Canal asignado actualizado.');
  };

  const handleRotateScreen = async (screen: Screen) => {
    if (!(await verifyPin())) return;
    const nextRotation = (((screen.rotation || 0) + 90) % 360) as ScreenRotation;
    await updateDoc(doc(db, 'screens', screen.id), { rotation: nextRotation });
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6 md:p-10">
      <div className="max-w-7xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-neutral-900 border border-neutral-800 p-6 rounded-2xl">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
              <Tv className="text-emerald-400" />
              Panel de Control — Cartelería Digital
            </h1>
            <p className="text-sm text-neutral-400 mt-1">
              Administrá canales, programaciones y monitoreá tus pantallas Android TV en tiempo real.
            </p>
          </div>

          <div className="flex items-center gap-3 bg-neutral-950 border border-neutral-800 px-4 py-2.5 rounded-xl">
            <ShieldCheck className="text-amber-400 w-5 h-5 shrink-0" />
            <div className="text-xs">
              <label className="block text-neutral-400 font-medium">PIN de Seguridad (123456)</label>
              <input
                type="password"
                maxLength={6}
                placeholder="••••••"
                value={securityPinInput}
                onChange={(e) => setSecurityPinInput(e.target.value)}
                className="bg-transparent text-white font-mono text-base tracking-widest focus:outline-none w-28 mt-0.5"
              />
            </div>
          </div>
        </header>

        {feedbackMsg && (
          <div
            className={`p-4 rounded-xl border text-sm font-medium ${
              feedbackMsg.type === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}
          >
            {feedbackMsg.text}
          </div>
        )}

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Plus className="w-5 h-5 text-emerald-400" />
              Vincular nueva pantalla
            </h2>
            <form onSubmit={handlePairScreen} className="space-y-4">
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Código en pantalla TV (6 dígitos)</label>
                <input
                  type="text"
                  maxLength={6}
                  placeholder="Ej: K8P29M"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-3.5 py-2.5 font-mono text-lg uppercase tracking-widest focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Nombre del dispositivo</label>
                <input
                  type="text"
                  placeholder="Ej: TV Mostrador Principal"
                  value={pairName}
                  onChange={(e) => setPairName(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-3.5 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Canal inicial</label>
                <select
                  value={pairChannelId}
                  onChange={(e) => setPairChannelId(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-3.5 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                >
                  <option value="">Seleccionar canal...</option>
                  {channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 rounded-xl transition cursor-pointer"
              >
                Vincular Pantalla
              </button>
            </form>
          </div>

          <div className="lg:col-span-2 bg-neutral-900 border border-neutral-800 rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4">Pantallas Conectadas ({screens.length})</h2>
            {screens.length === 0 ? (
              <div className="text-center py-12 text-neutral-500 border border-dashed border-neutral-800 rounded-xl">
                No hay pantallas vinculadas aún. Abrí <code className="text-neutral-300">/player</code> en otra pestaña y vinculá su código.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {screens.map((scr) => {
                  const isAlive = now - (scr.telemetry?.lastSeen || 0) < 90000;
                  return (
                    <div
                      key={scr.id}
                      className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 flex flex-col justify-between gap-4"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="font-semibold text-white truncate">{scr.name}</h3>
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-full font-medium ${
                              isAlive
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-red-500/10 text-red-400'
                            }`}
                          >
                            {isAlive ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                            {isAlive ? 'Online' : 'Sin señal'}
                          </span>
                        </div>

                        <p className="text-xs text-neutral-400 mt-1.5">
                          En pantalla: <span className="text-neutral-200">{scr.telemetry?.currentItemTitle || '—'}</span>
                        </p>
                        <p className="text-[11px] text-neutral-500 mt-0.5">
                          Caché offline: {scr.telemetry?.cachedItemsCount || 0} archivos · Rotación: {scr.rotation}°
                        </p>
                      </div>

                      <div className="space-y-3 pt-2 border-t border-neutral-900">
                        <select
                          value={scr.channelId || ''}
                          onChange={(e) => handleScreenChannelChange(scr.id, e.target.value)}
                          className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs text-neutral-200"
                        >
                          <option value="">Sin canal asignado</option>
                          {channels.map((ch) => (
                            <option key={ch.id} value={ch.id}>
                              Canal: {ch.name}
                            </option>
                          ))}
                        </select>

                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleScreenCommand(scr.id, 'playing')}
                            title="Reproducir"
                            className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1 text-xs font-medium cursor-pointer ${
                              scr.command === 'playing'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-neutral-900 text-neutral-400 hover:text-white'
                            }`}
                          >
                            <Play className="w-3.5 h-3.5" /> Play
                          </button>
                          <button
                            onClick={() => handleScreenCommand(scr.id, 'paused')}
                            title="Pausar"
                            className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1 text-xs font-medium cursor-pointer ${
                              scr.command === 'paused'
                                ? 'bg-amber-600 text-white'
                                : 'bg-neutral-900 text-neutral-400 hover:text-white'
                            }`}
                          >
                            <Pause className="w-3.5 h-3.5" /> Pausa
                          </button>
                          <button
                            onClick={() => handleScreenCommand(scr.id, 'blackout')}
                            title="Apagar pantalla"
                            className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1 text-xs font-medium cursor-pointer ${
                              scr.command === 'blackout'
                                ? 'bg-red-600 text-white'
                                : 'bg-neutral-900 text-neutral-400 hover:text-white'
                            }`}
                          >
                            <PowerOff className="w-3.5 h-3.5" /> Negro
                          </button>
                          <button
                            onClick={() => handleRotateScreen(scr)}
                            title="Rotar 90°"
                            className="p-1.5 rounded-lg bg-neutral-900 text-neutral-400 hover:text-white cursor-pointer"
                          >
                            <RotateCw className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-lg font-semibold">Canales de Contenido</h2>

            <form onSubmit={handleCreateChannel} className="flex gap-2">
              <input
                type="text"
                placeholder="Nuevo canal (ej: Menú Café)"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                className="flex-1 bg-neutral-950 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
              <button
                type="submit"
                className="bg-neutral-800 hover:bg-neutral-700 px-3.5 py-2 rounded-xl text-sm font-medium cursor-pointer"
              >
                Crear
              </button>
            </form>

            <div className="space-y-2 pt-2">
              {channels.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => handleSelectChannel(ch)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition flex items-center justify-between cursor-pointer ${
                    selectedChannelId === ch.id
                      ? 'bg-emerald-500/10 border-emerald-500/40 text-white'
                      : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                  }`}
                >
                  <span className="font-medium text-sm">{ch.name}</span>
                  <span className="text-xs bg-neutral-900 px-2 py-0.5 rounded-md">
                    {ch.items?.length || 0} items
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  Programación: {channels.find((c) => c.id === selectedChannelId)?.name || 'Seleccioná un canal'}
                </h2>
                <p className="text-xs text-neutral-400">
                  Agregá imágenes, videos MP4 directos o links de YouTube con su duración en segundos.
                </p>
              </div>
              {selectedChannelId && (
                <button
                  onClick={handlePublishChannel}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 cursor-pointer"
                >
                  <Send className="w-4 h-4" /> Publicar en Pantallas
                </button>
              )}
            </div>

            {selectedChannelId && (
              <>
                <form onSubmit={handleAddDraftItem} className="grid grid-cols-1 md:grid-cols-12 gap-3 bg-neutral-950 p-4 rounded-xl border border-neutral-800">
                  <div className="md:col-span-3">
                    <select
                      value={itemType}
                      onChange={(e) => setItemType(e.target.value as MediaType)}
                      className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="image">Imagen (URL)</option>
                      <option value="video">Video MP4 (URL)</option>
                      <option value="youtube">YouTube Link</option>
                    </select>
                  </div>
                  <div className="md:col-span-3">
                    <input
                      type="text"
                      placeholder="Título (ej: Promo 2x1)"
                      value={itemTitle}
                      onChange={(e) => setItemTitle(e.target.value)}
                      className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="md:col-span-4">
                    <input
                      type="url"
                      placeholder="https://..."
                      value={itemUrl}
                      onChange={(e) => setItemUrl(e.target.value)}
                      className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="md:col-span-2 flex gap-2">
                    <input
                      type="number"
                      min={2}
                      max={3600}
                      title="Duración en segundos"
                      value={itemDuration}
                      onChange={(e) => setItemDuration(Number(e.target.value))}
                      className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-2 text-sm text-center"
                    />
                    <button
                      type="submit"
                      className="bg-neutral-800 hover:bg-neutral-700 px-3 rounded-lg text-white cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </form>

                <div className="space-y-2">
                  {draftItems.length === 0 ? (
                    <p className="text-sm text-neutral-500 text-center py-6">
                      Este canal todavía no tiene contenidos. Agregá uno arriba y presioná &quot;Publicar en Pantallas&quot;.
                    </p>
                  ) : (
                    draftItems.map((item, idx) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between bg-neutral-950 border border-neutral-800 px-4 py-3 rounded-xl"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-xs font-mono text-neutral-500">#{idx + 1}</span>
                          {item.type === 'youtube' && <Video className="w-4 h-4 text-red-400 shrink-0" />}
                          {item.type === 'image' && <ImageIcon className="w-4 h-4 text-sky-400 shrink-0" />}
                          {item.type === 'video' && <Film className="w-4 h-4 text-purple-400 shrink-0" />}
                          <div className="truncate">
                            <p className="text-sm font-medium text-white truncate">{item.title}</p>
                            <p className="text-xs text-neutral-500 truncate">{item.url}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          <span className="text-xs font-mono bg-neutral-900 px-2.5 py-1 rounded text-neutral-300">
                            {item.duration}s
                          </span>
                          <button
                            onClick={() => handleRemoveDraftItem(item.id)}
                            className="text-neutral-500 hover:text-red-400 cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}