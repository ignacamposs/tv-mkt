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
  // Sesión y Rol (Agencia vs Comercio)
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loginEmail, setLoginEmail] = useState<string>('');
  const [loginPassword, setLoginPassword] = useState<string>('');
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

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
    const timer = setInterval(() => setNow(Date.now()), 15000);
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
          // Primer ingreso del administrador creado en Firebase Console -> se registra como Agencia
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

  // Suscripción en tiempo real a canales (filtrados según rol)
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

  // Suscripción en tiempo real a pantallas (filtradas según rol)
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

      // 1. Crear ficha del comercio
      const clientDoc = await addDoc(collection(db, 'clients'), {
        name: newClientName.trim(),
        email: newClientEmail.trim(),
        ownerUid: clientUid,
        active: true,
        createdAt: Date.now(),
      });

      // 2. Guardar perfil con rol 'client'
      const clientUserProfile: UserProfile = {
        uid: clientUid,
        email: newClientEmail.trim(),
        role: 'client',
        clientId: clientDoc.id,
        name: newClientName.trim(),
      };
      await setDoc(doc(db, 'users', clientUid), clientUserProfile);

      // 3. Crear canal inicial exclusivo para ese comercio
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

    // El comercio no puede mover spots de la agencia ni desplazarlos
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

  // Replicar un spot bloqueado de Agencia en todos los canales de comercios
  const handleReplicateAgencyAdToAllClients = async (adItem: MediaItem) => {
    if (profile?.role !== 'agency') return;
    const clientChannels = channels.filter((c) => Boolean(c.clientId));

    if (clientChannels.length === 0) {
      showToast('err', 'Todavía no hay canales de comercios creados');
      return;
    }

    try {
      const lockedAd: MediaItem = {
        ...adItem,
        createdBy: 'agency',
      };

      await Promise.all(
        clientChannels.map((ch) => {
          const existing = ch.items || [];
          const filtered = existing.filter((i) => i.id !== lockedAd.id);
          const merged = [lockedAd, ...filtered].map((item, idx) => ({
            ...item,
            order: idx,
          }));
          return updateDoc(doc(db, 'channels', ch.id), { items: merged });
        })
      );

      showToast(
        'ok',
        `Pauta inyectada en ${clientChannels.length} canal(es) de comercios automáticamente`
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

  // Pantalla de carga inicial de sesión
  if (authLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-400 flex items-center justify-center">
        Verificando credenciales...
      </div>
    );
  }

  // Pantalla de Login (Agencia y Comercios)
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

  // Filtros visuales para Agencia
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

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-6 md:p-10">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-neutral-800 pb-6">
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
              {isAgency ? 'Red de Cartelería Digital' : 'Mi Panel de Pantallas'}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/player"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 px-4 py-2 rounded-xl text-sm font-medium text-emerald-400 transition"
            >
              Simular TV (/player) ↗
            </a>

            <button
              onClick={handleLogout}
              className="bg-neutral-900 hover:bg-red-950/40 border border-neutral-700 hover:border-red-800 px-4 py-2 rounded-xl text-sm font-medium text-neutral-300 hover:text-red-300 transition"
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

        {/* SECCIÓN EXCLUSIVA AGENCIA: Gestión de Comercios (Subcuentas) */}
        {isAgency && (
          <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-5">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Comercios y Subcuentas ({clients.length})</h2>
                <p className="text-xs text-neutral-400">
                  Creá accesos individuales para cada local y filtrá sus pantallas o canales.
                </p>
              </div>

              {/* Filtro rápido por comercio */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-400">Filtrar vista:</span>
                <select
                  value={clientFilterId}
                  onChange={(e) => setClientFilterId(e.target.value)}
                  className="bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-sm"
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
            </div>

            {/* Formulario alta de nuevo comercio */}
            <form
              onSubmit={handleCreateClientAccount}
              className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-neutral-950 border border-neutral-800 rounded-xl p-4"
            >
              <input
                type="text"
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                placeholder="Nombre comercio (ej. Gym Norte)"
                className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm"
              />
              <input
                type="email"
                value={newClientEmail}
                onChange={(e) => setNewClientEmail(e.target.value)}
                placeholder="Email de acceso del local"
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
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2 px-4 rounded-lg text-sm transition"
              >
                {isCreatingClient ? 'Creando...' : '+ Crear Comercio'}
              </button>
            </form>

            {clients.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {clients.map((c) => {
                  const screenCount = screens.filter((s) => s.clientId === c.id).length;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() =>
                        setClientFilterId((prev) => (prev === c.id ? 'all' : c.id))
                      }
                      className={`text-left px-3.5 py-2 rounded-xl border text-xs transition ${
                        clientFilterId === c.id
                          ? 'bg-indigo-600/20 border-indigo-500 text-indigo-200'
                          : 'bg-neutral-950 border-neutral-800 text-neutral-300 hover:border-neutral-700'
                      }`}
                    >
                      <div className="font-semibold">{c.name}</div>
                      <div className="text-neutral-500">
                        {c.email} • {screenCount} TV(s)
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Columna Izquierda: Canales, Vista Previa y Playlist */}
          <section className="lg:col-span-7 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
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
                        : 'w-52 sm:w-60 aspect-9/16'
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

                {/* Barra de progreso y controles */}
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

          {/* Columna Derecha: Pantallas */}
          <section className="lg:col-span-5 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
            <h2 className="text-lg font-semibold">
              {isAgency ? `Pantallas de la Red (${visibleScreens.length})` : 'Mis Televisores'}
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
                  placeholder="Nombre (ej. Vidriera)"
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
                  const lastSeenMs = getTimestampMillis(scr.lastSeen);
                  const isOnline = now > 0 && lastSeenMs > 0 && now - lastSeenMs < 75000;
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
                              isOnline ? 'bg-emerald-500' : 'bg-neutral-600'
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

                      {/* Asignación de Comercio (Solo Agencia) */}
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