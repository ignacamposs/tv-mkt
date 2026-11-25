'use client';

import React, { useEffect, useState, useRef } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
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
import { auth, secondaryAuth, db } from '../../lib/firebase';
import {
  Channel,
  ClientAccount,
  MediaItem,
  Screen,
  ScreenRotation,
  UserProfile,
} from '../../types/signage';

type ScreenWithMeta = Screen & {
  id: string;
  lastSeen?: unknown;
  status?: string;
  currentStatus?: string;
  cachedCount?: number;
};

type AgencyTab = 'live' | 'editor' | 'clients';

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

function formatRelativeTime(lastSeenMs: number, nowMs: number): string {
  if (!lastSeenMs || !nowMs) return 'Sin conexión';
  const diffSec = Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000));
  if (diffSec < 60) return `Hace ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Hace ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `Hace ${diffHr}h`;
  return `Hace ${Math.floor(diffHr / 24)}d`;
}

function resolveLiveItemForScreen(
  scr: ScreenWithMeta,
  channel: Channel | undefined,
  nowMs: number
): MediaItem | null {
  if (!channel || !channel.items || channel.items.length === 0) return null;
  const sorted = [...channel.items].sort((a, b) => a.order - b.order);

  if (scr.telemetry?.currentItemId) {
    const byId = sorted.find((i) => i.id === scr.telemetry?.currentItemId);
    if (byId) return byId;
  }

  if (scr.telemetry?.currentItemTitle) {
    const byTitle = sorted.find((i) => i.title === scr.telemetry?.currentItemTitle);
    if (byTitle) return byTitle;
  }

  const totalDurationSec = sorted.reduce(
    (acc, item) => acc + Math.max(item.duration || 10, 2),
    0
  );
  if (totalDurationSec <= 0 || nowMs <= 0) return sorted[0];

  const elapsedSec = Math.floor(nowMs / 1000) % totalDurationSec;
  let cursor = 0;
  for (const item of sorted) {
    const dur = Math.max(item.duration || 10, 2);
    if (elapsedSec < cursor + dur) {
      return item;
    }
    cursor += dur;
  }
  return sorted[0];
}

export default function DashboardPage() {
  // Sesión y Rol (Agencia vs Comercio)
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loginEmail, setLoginEmail] = useState<string>('');
  const [loginPassword, setLoginPassword] = useState<string>('');
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // Navegación y filtros Master Agencia
  const [agencyTab, setAgencyTab] = useState<AgencyTab>('live');
  const [liveSearch, setLiveSearch] = useState<string>('');
  const [liveStatusFilter, setLiveStatusFilter] = useState<'all' | 'online' | 'offline'>('all');

  // Gestión de Comercios (Solo Agencia)
  const [clients, setClients] = useState<ClientAccount[]>([]);
  const [clientFilterId, setClientFilterId] = useState<string>('all');
  const [newClientName, setNewClientName] = useState<string>('');
  const [newClientEmail, setNewClientEmail] = useState<string>('');
  const [newClientPassword, setNewClientPassword] = useState<string>('');
  const [isCreatingClient, setIsCreatingClient] = useState<boolean>(false);

  // Canales y programación
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>('');
  const [newChannelName, setNewChannelName] = useState<string>('');
  const [newChannelClientId, setNewChannelClientId] = useState<string>('');
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
  const [newScreenClientId, setNewScreenClientId] = useState<string>('');
  const [isPairing, setIsPairing] = useState<boolean>(false);

  // Feedback y reloj seguro para Next.js 16
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [now, setNow] = useState<number>(0);

  const showToast = (type: 'ok' | 'err', text: string) => {
    setFeedbackMsg({ type, text });
    setTimeout(() => setFeedbackMsg(null), 4500);
  };

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  // Escuchar sesión de Firebase Auth y resolver perfil
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setProfile(null);
        setAuthLoading(false);
        return;
      }

      try {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const snap = await getDoc(userRef);

        if (snap.exists()) {
          setProfile(snap.data() as UserProfile);
        } else {
          const agencyProfile: UserProfile = {
            uid: firebaseUser.uid,
            email: firebaseUser.email || '',
            role: 'agency',
            name: 'Agencia Principal',
          };
          await setDoc(userRef, agencyProfile);
          setProfile(agencyProfile);
        }
      } catch {
        showToast('err', 'Error al cargar el perfil de usuario');
      } finally {
        setAuthLoading(false);
      }
    });

    return () => unsub();
  }, []);

  // Suscripción a Comercios (Solo para Agencia)
  useEffect(() => {
    if (!profile || profile.role !== 'agency') {
      setClients([]);
      return;
    }

    const unsub = onSnapshot(collection(db, 'clients'), (snapshot) => {
      const list: ClientAccount[] = snapshot.docs.map((d) => ({
        ...(d.data() as ClientAccount),
        id: d.id,
      }));
      setClients(list);
    });

    return () => unsub();
  }, [profile]);

  // Suscripción en tiempo real a canales
  useEffect(() => {
    if (!profile) return;

    const unsub = onSnapshot(collection(db, 'channels'), (snapshot) => {
      let list: Channel[] = snapshot.docs.map((d) => ({
        ...(d.data() as Channel),
        id: d.id,
      }));

      if (profile.role === 'client') {
        list = list.filter((c) => c.clientId === profile.clientId);
      }

      setChannels(list);

      if (list.length > 0) {
        setSelectedChannelId((prev) => {
          if (prev && list.some((c) => c.id === prev)) return prev;
          return list[0].id;
        });
      } else {
        setSelectedChannelId('');
      }
    });

    return () => unsub();
  }, [profile]);

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
    if (!profile) return;

    const unsub = onSnapshot(collection(db, 'screens'), (snapshot) => {
      let list: ScreenWithMeta[] = snapshot.docs
        .map((d) => ({
          ...(d.data() as Screen),
          id: d.id,
        }))
        .filter((s) => s.isPaired);

      if (profile.role === 'client') {
        list = list.filter((s) => s.clientId === profile.clientId);
      }

      setScreens(list);
    });

    return () => unsub();
  }, [profile]);

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

  // Handlers de Autenticación
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginEmail.trim() || !loginPassword.trim()) return;
    setIsLoggingIn(true);
    try {
      await signInWithEmailAndPassword(auth, loginEmail.trim(), loginPassword);
      setLoginPassword('');
    } catch {
      showToast('err', 'Correo o contraseña incorrectos');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setHasChanges(false);
    setSelectedChannelId('');
  };

  // Crear subcuenta de Comercio (Solo Agencia)
  const handleCreateClientAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (profile?.role !== 'agency') return;
    if (!newClientName.trim() || !newClientEmail.trim() || newClientPassword.length < 6) {
      showToast('err', 'Completá nombre, correo y una clave de al menos 6 caracteres');
      return;
    }

    setIsCreatingClient(true);
    try {
      const cred = await createUserWithEmailAndPassword(
        secondaryAuth,
        newClientEmail.trim(),
        newClientPassword
      );
      const clientUid = cred.user.uid;
      await signOut(secondaryAuth);

      const clientDoc = await addDoc(collection(db, 'clients'), {
        name: newClientName.trim(),
        email: newClientEmail.trim(),
        ownerUid: clientUid,
        active: true,
        createdAt: Date.now(),
      });

      const clientUserProfile: UserProfile = {
        uid: clientUid,
        email: newClientEmail.trim(),
        role: 'client',
        clientId: clientDoc.id,
        name: newClientName.trim(),
      };
      await setDoc(doc(db, 'users', clientUid), clientUserProfile);

      await addDoc(collection(db, 'channels'), {
        name: `Programación - ${newClientName.trim()}`,
        items: [],
        clientId: clientDoc.id,
      });

      setNewClientName('');
      setNewClientEmail('');
      setNewClientPassword('');
      showToast('ok', 'Comercio creado con su acceso y canal propios');
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.message.includes('email-already-in-use')
          ? 'Ese correo ya está registrado en el sistema'
          : 'Error al crear la cuenta del comercio';
      showToast('err', msg);
    } finally {
      setIsCreatingClient(false);
    }
  };

  // Canales
  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim() || !profile) return;

    const assignedClientId =
      profile.role === 'client' ? profile.clientId || '' : newChannelClientId;

    try {
      const docRef = await addDoc(collection(db, 'channels'), {
        name: newChannelName.trim(),
        items: [],
        ...(assignedClientId ? { clientId: assignedClientId } : {}),
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
    const target = channels.find((c) => c.id === channelId);
    if (
      profile?.role === 'client' &&
      target?.items?.some((item) => item.createdBy === 'agency')
    ) {
      showToast('err', 'No podés eliminar un canal que tiene pautas activas de la agencia');
      return;
    }

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

  // Subida a Cloudinary
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
    if (!profile) return;
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
      createdBy: profile.role,
    };

    setDraftItems((prev) => [...prev, newItem]);
    setHasChanges(true);
    setItemTitle('');
    setItemUrl('');
    setItemDuration(10);
  };

  const handleRemoveItem = (item: MediaItem) => {
    if (profile?.role === 'client' && item.createdBy === 'agency') {
      showToast('err', 'Este espacio está bloqueado por la agencia');
      return;
    }

    setDraftItems((prev) =>
      prev.filter((i) => i.id !== item.id).map((i, idx) => ({ ...i, order: idx }))
    );
    setHasChanges(true);
  };

  const handleMoveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draftItems.length) return;

    const currentItem = draftItems[index];
    const targetItem = draftItems[target];

    if (
      profile?.role === 'client' &&
      (currentItem.createdBy === 'agency' || targetItem.createdBy === 'agency')
    ) {
      showToast('err', 'Los espacios de la agencia tienen posición fija');
      return;
    }

    const updated = [...draftItems];
    updated[index] = targetItem;
    updated[target] = currentItem;
    setDraftItems(updated.map((item, idx) => ({ ...item, order: idx })));
    setHasChanges(true);
  };

  // Replicar un spot bloqueado de Agencia en todos los comercios
  const handleReplicateAgencyAdToAllClients = async (adItem: MediaItem) => {
    if (profile?.role !== 'agency') return;
    if (clients.length === 0) {
      showToast('err', 'Todavía no hay comercios registrados');
      return;
    }

    try {
      const lockedAd: MediaItem = {
        ...adItem,
        createdBy: 'agency',
      };

      const tasks: Promise<unknown>[] = [];

      clients.forEach((client) => {
        const clientChannels = channels.filter((c) => c.clientId === client.id);
        if (clientChannels.length > 0) {
          clientChannels.forEach((ch) => {
            const existing = ch.items || [];
            const filtered = existing.filter((i) => i.id !== lockedAd.id);
            const merged = [lockedAd, ...filtered].map((item, idx) => ({
              ...item,
              order: idx,
            }));
            tasks.push(updateDoc(doc(db, 'channels', ch.id), { items: merged }));
          });
        } else {
          tasks.push(
            addDoc(collection(db, 'channels'), {
              name: `Programación - ${client.name}`,
              clientId: client.id,
              items: [{ ...lockedAd, order: 0 }],
            })
          );
        }
      });

      await Promise.all(tasks);
      showToast(
        'ok',
        `Pauta inyectada en ${clients.length} comercio(s) de la red automáticamente`
      );
    } catch {
      showToast('err', 'Error al replicar la pauta en los comercios');
    }
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

  // Pantallas
  const handlePairScreen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    const code = pairingCode.trim().toUpperCase();
    if (!code) return;

    const assignedClientId =
      profile.role === 'client' ? profile.clientId || '' : newScreenClientId;

    setIsPairing(true);
    try {
      const q = query(collection(db, 'screens'), where('pairingCode', '==', code));
      const snap = await getDocs(q);

      if (snap.empty) {
        showToast('err', 'No se encontró ninguna pantalla con ese código');
        return;
      }

      const targetDoc = snap.docs[0];
      const defaultChannelForClient = assignedClientId
        ? channels.find((c) => c.clientId === assignedClientId)?.id || selectedChannelId
        : selectedChannelId;

      await updateDoc(doc(db, 'screens', targetDoc.id), {
        isPaired: true,
        name: newScreenName.trim() || `Pantalla ${code}`,
        channelId: defaultChannelForClient || '',
        ...(assignedClientId ? { clientId: assignedClientId } : { clientId: '' }),
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

  const openClientInEditor = (clientId: string, preferredChannelId?: string) => {
    setHasChanges(false);
    setClientFilterId(clientId || 'agency_only');
    if (preferredChannelId) {
      setSelectedChannelId(preferredChannelId);
    } else {
      const firstChannel = channels.find((c) =>
        clientId ? c.clientId === clientId : !c.clientId
      );
      if (firstChannel) setSelectedChannelId(firstChannel.id);
    }
    setPreviewIndex(0);
    setAgencyTab('editor');
  };

  // Pantalla de carga inicial
  if (authLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-400 flex items-center justify-center">
        Verificando credenciales...
      </div>
    );
  }

  // Pantalla de Login
  if (!profile) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-6">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-2xl p-8 shadow-2xl space-y-4"
        >
          <div>
            <span className="inline-block px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium mb-2">
              Acceso Plataforma
            </span>
            <h1 className="text-2xl font-bold">Iniciar Sesión</h1>
            <p className="text-sm text-neutral-400 mt-1">
              Ingresá con tu cuenta de Agencia o Comercio para gestionar tus pantallas.
            </p>
          </div>

          <div className="space-y-3 pt-2">
            <input
              type="email"
              required
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              placeholder="Correo electrónico"
              className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500"
              autoFocus
            />
            <input
              type="password"
              required
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="Contraseña"
              className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>

          <button
            type="submit"
            disabled={isLoggingIn}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 rounded-xl transition"
          >
            {isLoggingIn ? 'Ingresando...' : 'Entrar al Panel'}
          </button>

          {feedbackMsg && (
            <p className="text-center text-sm text-red-400">{feedbackMsg.text}</p>
          )}
        </form>
      </div>
    );
  }

  const isAgency = profile.role === 'agency';
  const clientNameMap: Record<string, string> = {};
  clients.forEach((c) => {
    clientNameMap[c.id] = c.name;
  });

  const isScreenOnline = (scr: ScreenWithMeta) => {
    const lastSeenMs = Math.max(
      getTimestampMillis(scr.telemetry?.lastSeen),
      getTimestampMillis(scr.lastSeen)
    );
    return now > 0 && lastSeenMs > 0 && now - lastSeenMs < 75000;
  };

  // Métricas globales para el Master Agencia
  const onlineScreensCount = screens.filter(isScreenOnline).length;
  const totalAgencyLockedAds = channels.reduce(
    (acc, ch) => acc + (ch.items || []).filter((i) => i.createdBy === 'agency').length,
    0
  );

  // Filtros visuales para Editor
  const visibleChannels =
    isAgency && clientFilterId !== 'all'
      ? channels.filter((c) =>
          clientFilterId === 'agency_only' ? !c.clientId : c.clientId === clientFilterId
        )
      : channels;

  const visibleScreens =
    isAgency && clientFilterId !== 'all'
      ? screens.filter((s) =>
          clientFilterId === 'agency_only' ? !s.clientId : s.clientId === clientFilterId
        )
      : screens;

  const progressPercent = Math.min(
    100,
    Math.round((previewElapsedMs / activePreviewDurationMs) * 100)
  );
  const remainingSec = Math.max(
    0,
    Math.ceil((activePreviewDurationMs - previewElapsedMs) / 1000)
  );

  // Tarjeta reutilizable de Monitor en Vivo para cada TV en la Torre de Control
  const renderLiveMonitorCard = (scr: ScreenWithMeta) => {
    const online = isScreenOnline(scr);
    const lastSeenMs = Math.max(
      getTimestampMillis(scr.telemetry?.lastSeen),
      getTimestampMillis(scr.lastSeen)
    );
    const assignedChannel = channels.find((c) => c.id === scr.channelId);
    const liveItem = resolveLiveItemForScreen(scr, assignedChannel, now);
    const isVertical = scr.rotation === 90 || scr.rotation === 270;
    const callerActive = Boolean(scr.callerEnabled);
    const activeTicket = scr.callerState?.current;

    return (
      <div
        key={scr.id}
        className="bg-neutral-950 border border-neutral-800/90 hover:border-neutral-700 rounded-xl p-3.5 flex flex-col justify-between gap-3 transition"
      >
        {/* Cabecera del TV */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                online
                  ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]'
                  : 'bg-neutral-600'
              }`}
            />
            <h4 className="font-semibold text-sm text-neutral-100 truncate">{scr.name}</h4>
          </div>
          <span
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${
              online
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : 'bg-neutral-900 text-neutral-500 border border-neutral-800'
            }`}
          >
            {online ? 'EN LÍNEA' : formatRelativeTime(lastSeenMs, now)}
          </span>
        </div>

        {/* Pantalla simulada en vivo */}
        <div className="w-full h-36 bg-black rounded-lg border border-neutral-800/80 flex items-center justify-center overflow-hidden relative p-2">
          <div
            className={`relative bg-neutral-950 border border-neutral-800 overflow-hidden flex items-center justify-center shadow-inner ${
              isVertical ? 'h-full aspect-[9/16]' : 'w-full h-full aspect-video'
            }`}
          >
            {scr.command === 'blackout' ? (
              <div className="text-center px-2">
                <p className="text-[10px] font-mono uppercase tracking-wider text-red-400">
                  ⬛ Apagada
                </p>
              </div>
            ) : !liveItem ? (
              <div className="text-center px-2 text-[11px] text-neutral-600">
                {assignedChannel ? 'Canal vacío' : 'Sin canal asignado'}
              </div>
            ) : (
              <>
                {liveItem.type === 'image' && (
                  <img
                    src={liveItem.url}
                    alt={liveItem.title}
                    className="w-full h-full object-contain"
                  />
                )}
                {liveItem.type === 'video' && (
                  <video
                    src={liveItem.url}
                    autoPlay
                    muted
                    loop
                    playsInline
                    className="w-full h-full object-contain"
                  />
                )}
                {liveItem.type === 'youtube' && liveItem.youtubeId && (
                  <img
                    src={`https://img.youtube.com/vi/${liveItem.youtubeId}/hqdefault.jpg`}
                    alt={liveItem.title}
                    className="w-full h-full object-cover"
                  />
                )}

                {scr.command === 'paused' && (
                  <div className="absolute inset-0 bg-black/65 flex items-center justify-center">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      ⏸ PAUSADA
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Etiqueta flotante de formato y código */}
          <span className="absolute top-1.5 right-1.5 text-[9px] font-mono bg-black/75 text-neutral-400 px-1.5 py-0.5 rounded border border-neutral-800">
            {isVertical ? '9:16' : '16:9'} • {scr.pairingCode}
          </span>

          {/* Indicador flotante si el llamador está activo */}
          {callerActive && (
            <span className="absolute bottom-1.5 left-1.5 right-1.5 text-[10px] font-medium bg-amber-500/90 text-black px-2 py-0.5 rounded truncate text-center shadow">
              {activeTicket
                ? `🔔 ${activeTicket.ticket} → ${activeTicket.destination}`
                : '🔔 Llamador de turnos activo'}
            </span>
          )}
        </div>

        {/* Info del spot actual */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-neutral-400 truncate">
              {liveItem ? (
                <>
                  <span className="text-emerald-400 mr-1">●</span>
                  <strong className="text-neutral-200 font-medium">{liveItem.title}</strong>
                </>
              ) : (
                'Esperando programación'
              )}
            </span>
            {liveItem?.createdBy === 'agency' && (
              <span className="text-[10px] text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded shrink-0">
                🔒 Agencia
              </span>
            )}
          </div>

          {/* Selector rápido de canal */}
          <select
            value={scr.channelId || ''}
            onChange={(e) => handleUpdateScreen(scr.id, { channelId: e.target.value })}
            className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs text-neutral-300 focus:outline-none focus:border-indigo-500"
          >
            <option value="">-- Sin canal asignado --</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{' '}
                {c.clientId && clientNameMap[c.clientId]
                  ? `(${clientNameMap[c.clientId]})`
                  : ''}
              </option>
            ))}
          </select>

          {/* Controles instantáneos + Interruptor Llamador */}
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => handleUpdateScreen(scr.id, { command: 'playing' })}
              title="Reproducir"
              className={`flex-1 py-1 rounded-md text-[11px] font-medium border transition ${
                scr.command === 'playing'
                  ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                  : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
              }`}
            >
              ▶
            </button>
            <button
              type="button"
              onClick={() => handleUpdateScreen(scr.id, { command: 'paused' })}
              title="Pausar"
              className={`flex-1 py-1 rounded-md text-[11px] font-medium border transition ${
                scr.command === 'paused'
                  ? 'bg-amber-600/20 border-amber-500/50 text-amber-300'
                  : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
              }`}
            >
              ⏸
            </button>
            <button
              type="button"
              onClick={() => handleUpdateScreen(scr.id, { command: 'blackout' })}
              title="Apagar pantalla"
              className={`flex-1 py-1 rounded-md text-[11px] font-medium border transition ${
                scr.command === 'blackout'
                  ? 'bg-red-600/20 border-red-500/50 text-red-300'
                  : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
              }`}
            >
              ⬛
            </button>
            <button
              type="button"
              onClick={() =>
                handleUpdateScreen(scr.id, {
                  rotation: (scr.rotation === 90 ? 0 : 90) as ScreenRotation,
                })
              }
              title="Alternar Horizontal / Vertical"
              className="px-2 py-1 rounded-md text-[11px] font-mono bg-neutral-900 border border-neutral-800 text-neutral-300 hover:border-neutral-600"
            >
              {scr.rotation || 0}°
            </button>
            <button
              type="button"
              onClick={() =>
                handleUpdateScreen(scr.id, { callerEnabled: !callerActive })
              }
              title="Activar o desactivar columna de turnos en este TV"
              className={`px-2 py-1 rounded-md text-[11px] font-semibold border transition ${
                callerActive
                  ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                  : 'bg-neutral-900 border-neutral-800 text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {callerActive ? '🔔 ON' : '🔕 OFF'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-5 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header Principal */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-neutral-800/90 pb-5">
          <div>
            <div className="flex items-center gap-2.5 mb-1">
              <span
                className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${
                  isAgency
                    ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                }`}
              >
                {isAgency ? 'MODO AGENCIA (MASTER)' : `COMERCIO: ${profile.name || 'Local'}`}
              </span>
              <span className="text-xs text-neutral-500">{profile.email}</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              {isAgency ? 'Torre de Control Digital' : 'Mi Panel de Pantallas'}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <a
              href="/llamador"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 px-3.5 py-2 rounded-xl text-xs font-medium text-amber-300 transition"
            >
              🔔 Llamador (/llamador) ↗
            </a>

            <a
              href="/player"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 px-3.5 py-2 rounded-xl text-xs font-medium text-emerald-400 transition"
            >
              Simular TV (/player) ↗
            </a>

            <button
              onClick={handleLogout}
              className="bg-neutral-900 hover:bg-red-950/40 border border-neutral-700 hover:border-red-800 px-3.5 py-2 rounded-xl text-xs font-medium text-neutral-300 hover:text-red-300 transition"
            >
              Cerrar Sesión
            </button>
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

        {/* PANEL MASTER AGENCIA: KPIs + NAVEGACIÓN POR PESTAÑAS */}
        {isAgency && (
          <>
            {/* Barra de KPIs ejecutivos */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
              <div className="bg-neutral-900/90 border border-neutral-800 rounded-2xl p-4">
                <p className="text-xs text-neutral-400">Comercios Activos</p>
                <p className="text-2xl font-bold mt-1 text-white">{clients.length}</p>
                <p className="text-[11px] text-neutral-500 mt-0.5">Cuentas de clientes</p>
              </div>

              <div className="bg-neutral-900/90 border border-neutral-800 rounded-2xl p-4">
                <p className="text-xs text-neutral-400">Pantallas Conectadas</p>
                <div className="flex items-baseline gap-2 mt-1">
                  <p className="text-2xl font-bold text-emerald-400">{onlineScreensCount}</p>
                  <span className="text-xs text-neutral-500">/ {screens.length} totales</span>
                </div>
                <p className="text-[11px] text-neutral-500 mt-0.5">Monitoreo en tiempo real</p>
              </div>

              <div className="bg-neutral-900/90 border border-neutral-800 rounded-2xl p-4">
                <p className="text-xs text-neutral-400">Canales en Red</p>
                <p className="text-2xl font-bold mt-1 text-white">{channels.length}</p>
                <p className="text-[11px] text-neutral-500 mt-0.5">Listas de reproducción</p>
              </div>

              <div className="bg-neutral-900/90 border border-neutral-800 rounded-2xl p-4">
                <p className="text-xs text-neutral-400">Pautas Agencia Activas</p>
                <p className="text-2xl font-bold mt-1 text-indigo-400">{totalAgencyLockedAds}</p>
                <p className="text-[11px] text-neutral-500 mt-0.5">Espacios bloqueados</p>
              </div>
            </div>

            {/* Selector de pestañas del Master */}
            <nav className="flex flex-wrap items-center gap-2 bg-neutral-900 p-1.5 rounded-2xl border border-neutral-800 w-fit">
              <button
                type="button"
                onClick={() => setAgencyTab('live')}
                className={`px-4 py-2 rounded-xl text-xs font-semibold transition ${
                  agencyTab === 'live'
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                📡 Torre de Control (En Vivo)
              </button>
              <button
                type="button"
                onClick={() => setAgencyTab('editor')}
                className={`px-4 py-2 rounded-xl text-xs font-semibold transition ${
                  agencyTab === 'editor'
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                🎬 Editor de Canales y Pautas
              </button>
              <button
                type="button"
                onClick={() => setAgencyTab('clients')}
                className={`px-4 py-2 rounded-xl text-xs font-semibold transition ${
                  agencyTab === 'clients'
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                🏪 Comercios y Pantallas ({clients.length})
              </button>
            </nav>
          </>
        )}

        {/* ===================================================================== */}
        {/* PESTAÑA 1 (SOLO AGENCIA): TORRE DE CONTROL EN VIVO POR COMERCIO       */}
        {/* ===================================================================== */}
        {isAgency && agencyTab === 'live' && (
          <section className="space-y-6">
            {/* Barra de búsqueda y filtro de estado */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-neutral-900 border border-neutral-800 rounded-2xl p-4">
              <div className="flex flex-1 items-center gap-3">
                <input
                  type="text"
                  value={liveSearch}
                  onChange={(e) => setLiveSearch(e.target.value)}
                  placeholder="Buscar comercio o nombre de televisor..."
                  className="w-full sm:max-w-xs bg-neutral-950 border border-neutral-700 rounded-xl px-3.5 py-2 text-xs focus:outline-none focus:border-indigo-500"
                />

                <div className="flex items-center gap-1 bg-neutral-950 p-1 rounded-xl border border-neutral-800">
                  {(
                    [
                      { id: 'all', label: 'Todos' },
                      { id: 'online', label: 'En línea' },
                      { id: 'offline', label: 'Offline' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setLiveStatusFilter(opt.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                        liveStatusFilter === opt.id
                          ? 'bg-neutral-800 text-white'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setAgencyTab('clients')}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-4 py-2 rounded-xl text-xs transition shrink-0"
              >
                + Nuevo Comercio / Vincular TV
              </button>
            </div>

            {/* Grilla de Tarjetas de Comercios */}
            {clients.length === 0 && screens.length === 0 ? (
              <div className="bg-neutral-900 border border-dashed border-neutral-800 rounded-2xl p-12 text-center space-y-3">
                <p className="text-neutral-300 font-medium">
                  Todavía no tenés comercios ni televisores en la red
                </p>
                <p className="text-xs text-neutral-500 max-w-md mx-auto">
                  Creá tu primer local comercial y vinculá su pantalla para monitorear en vivo
                  lo que se está emitiendo.
                </p>
                <button
                  type="button"
                  onClick={() => setAgencyTab('clients')}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-4 py-2 rounded-xl text-xs transition"
                >
                  Crear Primer Comercio
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                {clients
                  .filter((client) => {
                    const clientScreens = screens.filter((s) => s.clientId === client.id);
                    const matchesSearch =
                      !liveSearch.trim() ||
                      client.name.toLowerCase().includes(liveSearch.toLowerCase()) ||
                      client.email.toLowerCase().includes(liveSearch.toLowerCase()) ||
                      clientScreens.some((s) =>
                        s.name.toLowerCase().includes(liveSearch.toLowerCase())
                      );
                    if (!matchesSearch) return false;

                    if (liveStatusFilter === 'online') {
                      return clientScreens.some(isScreenOnline);
                    }
                    if (liveStatusFilter === 'offline') {
                      return (
                        clientScreens.length === 0 ||
                        clientScreens.some((s) => !isScreenOnline(s))
                      );
                    }
                    return true;
                  })
                  .map((client) => {
                    const clientScreens = screens.filter((s) => s.clientId === client.id);
                    const clientChannels = channels.filter((c) => c.clientId === client.id);
                    const onlineCount = clientScreens.filter(isScreenOnline).length;

                    return (
                      <article
                        key={client.id}
                        className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 flex flex-col justify-between gap-5 shadow-lg"
                      >
                        {/* Encabezado de la tarjeta del comercio */}
                        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-800/80 pb-4">
                          <div>
                            <div className="flex items-center gap-2.5">
                              <h3 className="text-lg font-bold text-white">{client.name}</h3>
                              <span
                                className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${
                                  onlineCount > 0
                                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                                    : 'bg-neutral-800 text-neutral-400 border-neutral-700'
                                }`}
                              >
                                {onlineCount}/{clientScreens.length} TVs online
                              </span>
                            </div>
                            <p className="text-xs text-neutral-400 mt-0.5">
                              {client.email} • {clientChannels.length} canal(es)
                            </p>
                          </div>

                          <button
                            type="button"
                            onClick={() => openClientInEditor(client.id, clientChannels[0]?.id)}
                            className="bg-neutral-950 hover:bg-indigo-600/20 border border-neutral-700 hover:border-indigo-500/50 text-indigo-300 px-3.5 py-2 rounded-xl text-xs font-semibold transition"
                          >
                            Editar Programación →
                          </button>
                        </div>

                        {/* Monitores en vivo de los TVs del comercio */}
                        {clientScreens.length === 0 ? (
                          <div className="border border-dashed border-neutral-800 rounded-xl p-6 text-center space-y-2">
                            <p className="text-xs text-neutral-500">
                              Este comercio aún no tiene pantallas vinculadas.
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setNewScreenClientId(client.id);
                                setAgencyTab('clients');
                              }}
                              className="text-xs text-emerald-400 hover:underline"
                            >
                              + Vincular un TV a {client.name}
                            </button>
                          </div>
                        ) : (
                          <div
                            className={`grid gap-3.5 ${
                              clientScreens.length === 1
                                ? 'grid-cols-1'
                                : 'grid-cols-1 sm:grid-cols-2'
                            }`}
                          >
                            {clientScreens.map((scr) => renderLiveMonitorCard(scr))}
                          </div>
                        )}
                      </article>
                    );
                  })}

                {/* Tarjeta especial para pantallas propias de la Agencia sin comercio asignado */}
                {(() => {
                  const agencyScreens = screens.filter((s) => !s.clientId);
                  if (agencyScreens.length === 0) return null;
                  const onlineCount = agencyScreens.filter(isScreenOnline).length;

                  return (
                    <article className="bg-neutral-900 border border-indigo-500/30 rounded-2xl p-5 flex flex-col justify-between gap-5 shadow-lg">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-800/80 pb-4">
                        <div>
                          <div className="flex items-center gap-2.5">
                            <h3 className="text-lg font-bold text-indigo-200">
                              Pantallas Propias de Agencia
                            </h3>
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                              {onlineCount}/{agencyScreens.length} online
                            </span>
                          </div>
                          <p className="text-xs text-neutral-400 mt-0.5">
                            Televisores sin comercio asignado (demos o vía pública)
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={() => openClientInEditor('')}
                          className="bg-neutral-950 hover:bg-indigo-600/20 border border-neutral-700 hover:border-indigo-500/50 text-indigo-300 px-3.5 py-2 rounded-xl text-xs font-semibold transition"
                        >
                          Editar Canales →
                        </button>
                      </div>

                      <div
                        className={`grid gap-3.5 ${
                          agencyScreens.length === 1
                            ? 'grid-cols-1'
                            : 'grid-cols-1 sm:grid-cols-2'
                        }`}
                      >
                        {agencyScreens.map((scr) => renderLiveMonitorCard(scr))}
                      </div>
                    </article>
                  );
                })()}
              </div>
            )}
          </section>
        )}

        {/* ===================================================================== */}
        {/* PESTAÑA 3 (SOLO AGENCIA): ALTA DE COMERCIOS Y VINCULACIÓN DE TVs      */}
        {/* ===================================================================== */}
        {isAgency && agencyTab === 'clients' && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Alta de Comercios + Cartera */}
            <div className="lg:col-span-7 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Alta de Nuevo Comercio</h2>
                <p className="text-xs text-neutral-400 mt-0.5">
                  Crea un acceso independiente para el dueño del local y su canal inicial.
                </p>
              </div>

              <form
                onSubmit={handleCreateClientAccount}
                className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-neutral-950 border border-neutral-800 rounded-xl p-4"
              >
                <input
                  type="text"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  placeholder="Nombre (ej. Farmacia Central)"
                  className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                />
                <input
                  type="email"
                  value={newClientEmail}
                  onChange={(e) => setNewClientEmail(e.target.value)}
                  placeholder="Correo de acceso"
                  className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                />
                <input
                  type="text"
                  value={newClientPassword}
                  onChange={(e) => setNewClientPassword(e.target.value)}
                  placeholder="Contraseña (mín. 6)"
                  className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={isCreatingClient}
                  className="sm:col-span-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                >
                  {isCreatingClient ? 'Creando cuenta...' : '+ Crear Comercio y Canal Inicial'}
                </button>
              </form>

              <div className="space-y-3">
                <h3 className="text-sm font-medium text-neutral-400">
                  Cartera de Clientes ({clients.length})
                </h3>
                {clients.length === 0 ? (
                  <p className="text-sm text-neutral-500 py-4">
                    Aún no hay comercios creados.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {clients.map((c) => {
                      const cScreens = screens.filter((s) => s.clientId === c.id);
                      const cChannels = channels.filter((ch) => ch.clientId === c.id);
                      return (
                        <div
                          key={c.id}
                          className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
                        >
                          <div>
                            <p className="font-semibold text-sm text-white">{c.name}</p>
                            <p className="text-xs text-neutral-400">
                              {c.email} • {cScreens.length} TV(s) • {cChannels.length} canal(es)
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openClientInEditor(c.id, cChannels[0]?.id)}
                              className="px-3 py-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-xs text-indigo-300 font-medium"
                            >
                              Programación
                            </button>
                            <button
                              type="button"
                              onClick={() => setAgencyTab('live')}
                              className="px-3 py-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-xs text-emerald-300 font-medium"
                            >
                              Ver en Vivo
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Vincular y Asignar Pantallas */}
            <div className="lg:col-span-5 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Vincular Nuevo Televisor</h2>
                <p className="text-xs text-neutral-400 mt-0.5">
                  Ingresá el código de 6 dígitos que aparece en la pantalla del local.
                </p>
              </div>

              <form
                onSubmit={handlePairScreen}
                className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 space-y-3"
              >
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
                    placeholder="Nombre (ej. Sala Espera)"
                    className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                <select
                  value={newScreenClientId}
                  onChange={(e) => setNewScreenClientId(e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs"
                >
                  <option value="">Asignar a comercio: Ninguno (Agencia)</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      Asignar a comercio: {c.name}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={isPairing}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 rounded-lg text-sm transition"
                >
                  {isPairing ? 'Vinculando...' : 'Vincular Pantalla'}
                </button>
              </form>

              <div className="space-y-3">
                <h3 className="text-sm font-medium text-neutral-400">
                  Inventario de Pantallas ({screens.length})
                </h3>
                {screens.map((scr) => (
                  <div
                    key={scr.id}
                    className="bg-neutral-950 border border-neutral-800 rounded-xl p-3.5 space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm">{scr.name}</span>
                      <button
                        type="button"
                        onClick={() => handleUnpairScreen(scr.id)}
                        className="text-xs text-neutral-500 hover:text-red-400"
                      >
                        Desvincular
                      </button>
                    </div>
                    <select
                      value={scr.clientId || ''}
                      onChange={(e) =>
                        handleUpdateScreen(scr.id, { clientId: e.target.value })
                      }
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-2.5 py-1.5 text-xs text-indigo-300"
                    >
                      <option value="">Comercio: Sin asignar (Agencia)</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          Comercio: {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ===================================================================== */}
        {/* VISTA EDITOR DE CANALES Y PANTALLAS (PESTAÑA 2 AGENCIA + VISTA LOCAL)  */}
        {/* ===================================================================== */}
        {(!isAgency || agencyTab === 'editor') && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Columna Izquierda: Canales, Vista Previa y Playlist */}
            <section className="lg:col-span-7 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
              {/* Filtro rápido por comercio en el Editor (Solo Agencia) */}
              {isAgency && (
                <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-950 border border-neutral-800 rounded-xl p-3">
                  <span className="text-xs text-neutral-400">Filtrar canales por cliente:</span>
                  <select
                    value={clientFilterId}
                    onChange={(e) => {
                      setHasChanges(false);
                      setClientFilterId(e.target.value);
                    }}
                    className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-indigo-300"
                  >
                    <option value="all">Todos los comercios y canales</option>
                    <option value="agency_only">Solo propios de Agencia</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        Comercio: {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <h2 className="text-lg font-semibold">Canales y Programación</h2>

                <form onSubmit={handleCreateChannel} className="flex flex-wrap gap-2">
                  <input
                    type="text"
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    placeholder="Nuevo canal (ej. Promos)"
                    className="bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                  />
                  {isAgency && (
                    <select
                      value={newChannelClientId}
                      onChange={(e) => setNewChannelClientId(e.target.value)}
                      className="bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-sm"
                    >
                      <option value="">Canal General Agencia</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          Para: {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="submit"
                    className="bg-neutral-800 hover:bg-neutral-700 px-4 py-2 rounded-xl text-sm font-medium transition"
                  >
                    + Crear
                  </button>
                </form>
              </div>

              {/* Selector de canal activo */}
              {visibleChannels.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  {visibleChannels.map((ch) => {
                    const ownerLabel =
                      isAgency && ch.clientId ? clientNameMap[ch.clientId] : null;
                    return (
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
                          className="px-4 py-2 font-medium flex items-center gap-2"
                        >
                          <span>{ch.name}</span>
                          {ownerLabel && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">
                              {ownerLabel}
                            </span>
                          )}
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
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-neutral-500">
                  No hay canales en esta vista. Creá uno para comenzar a cargar anuncios.
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
                      {isAgency
                        ? 'Agregar pauta de Agencia (se bloqueará para el comercio)'
                        : 'Agregar contenido propio'}
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
                        const isAgencySlot = item.createdBy === 'agency';
                        const lockedForUser = !isAgency && isAgencySlot;

                        return (
                          <li
                            key={item.id}
                            onClick={() => setPreviewIndex(idx)}
                            className={`cursor-pointer flex items-center justify-between gap-3 bg-neutral-950 border rounded-xl p-3 transition ${
                              isCurrentInPreview
                                ? 'border-emerald-500/60 bg-emerald-950/10'
                                : isAgencySlot
                                ? 'border-indigo-500/30'
                                : 'border-neutral-800 hover:border-neutral-700'
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-neutral-800 text-neutral-300">
                                  {item.type}
                                </span>
                                {isAgencySlot && (
                                  <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                                    🔒 Pauta Agencia
                                  </span>
                                )}
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
                              {isAgency && isAgencySlot && (
                                <button
                                  type="button"
                                  onClick={() => handleReplicateAgencyAdToAllClients(item)}
                                  title="Inyectar esta pauta en todos los comercios"
                                  className="px-2 py-1 mr-1 rounded bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/40 text-indigo-300 text-[11px] font-medium"
                                >
                                  📢 Todos los locales
                                </button>
                              )}

                              {!lockedForUser ? (
                                <>
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
                                    onClick={() => handleRemoveItem(item)}
                                    className="p-1.5 text-red-400 hover:text-red-300 ml-1"
                                    title="Eliminar"
                                  >
                                    🗑
                                  </button>
                                </>
                              ) : (
                                <span
                                  className="text-xs text-neutral-500 px-2"
                                  title="Espacio reservado por la agencia"
                                >
                                  Bloqueado
                                </span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </section>

            {/* Columna Derecha: Pantallas vinculadas al filtro/local */}
            <section className="lg:col-span-5 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
              <h2 className="text-lg font-semibold">
                {isAgency ? `Pantallas (${visibleScreens.length})` : 'Mis Televisores'}
              </h2>

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
                    placeholder="Nombre (ej. Sala Espera)"
                    className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                {isAgency && (
                  <select
                    value={newScreenClientId}
                    onChange={(e) => setNewScreenClientId(e.target.value)}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs"
                  >
                    <option value="">Asignar a comercio: Ninguno (Agencia)</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        Asignar a comercio: {c.name}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="submit"
                  disabled={isPairing}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2 rounded-lg text-sm transition"
                >
                  {isPairing ? 'Vinculando...' : 'Vincular Pantalla'}
                </button>
              </form>

              {visibleScreens.length === 0 ? (
                <p className="text-sm text-neutral-500 text-center py-6">
                  No hay pantallas vinculadas en esta vista.
                </p>
              ) : (
                <div className="space-y-4">
                  {visibleScreens.map((scr) => {
                    const online = isScreenOnline(scr);
                    const callerActive = Boolean(scr.callerEnabled);
                    const screenChannels = isAgency
                      ? channels
                      : channels.filter((c) => c.clientId === profile.clientId);

                    return (
                      <div
                        key={scr.id}
                        className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 space-y-3"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-2.5 h-2.5 rounded-full ${
                                online ? 'bg-emerald-500' : 'bg-neutral-600'
                              }`}
                            />
                            <h3 className="font-semibold text-sm">{scr.name}</h3>
                          </div>
                          {isAgency && (
                            <button
                              type="button"
                              onClick={() => handleUnpairScreen(scr.id)}
                              className="text-xs text-neutral-500 hover:text-red-400"
                            >
                              Desvincular
                            </button>
                          )}
                        </div>

                        <p className="text-xs text-neutral-500">
                          Estado: {scr.currentStatus || scr.status || 'Activo'} • Código:{' '}
                          <span className="font-mono">{scr.pairingCode}</span>
                        </p>

                        {isAgency && (
                          <select
                            value={scr.clientId || ''}
                            onChange={(e) =>
                              handleUpdateScreen(scr.id, { clientId: e.target.value })
                            }
                            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-2.5 py-1.5 text-xs text-indigo-300"
                          >
                            <option value="">Comercio: Sin asignar (Agencia)</option>
                            {clients.map((c) => (
                              <option key={c.id} value={c.id}>
                                Comercio: {c.name}
                              </option>
                            ))}
                          </select>
                        )}

                        <div className="grid grid-cols-2 gap-2">
                          <select
                            value={scr.channelId || ''}
                            onChange={(e) =>
                              handleUpdateScreen(scr.id, { channelId: e.target.value })
                            }
                            className="bg-neutral-900 border border-neutral-700 rounded-lg px-2.5 py-1.5 text-xs"
                          >
                            <option value="">-- Sin canal --</option>
                            {screenChannels.map((c) => (
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

                        {/* Interruptor Modo Llamador (Farmacia / Clínica) */}
                        <button
                          type="button"
                          onClick={() =>
                            handleUpdateScreen(scr.id, { callerEnabled: !callerActive })
                          }
                          className={`w-full py-2 px-3 rounded-lg text-xs font-semibold border transition flex items-center justify-between ${
                            callerActive
                              ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                              : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          <span>🔔 Modo Llamador de Turnos (Pantalla Dividida)</span>
                          <span>{callerActive ? 'ACTIVADO' : 'APAGADO'}</span>
                        </button>

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
        )}
      </div>
    </div>
  );
}