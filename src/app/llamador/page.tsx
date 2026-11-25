'use client';

import React, { useEffect, useState, useCallback } from 'react';
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
import { CallerEntry, CallerState, Screen } from '../../types/signage';

const STORAGE_SCREEN_ID_KEY = 'signage_caller_screen_id';

function formatTicket(prefix: string, num: number): string {
  const cleanPrefix = prefix.trim().toUpperCase();
  const padded = String(Math.max(1, num)).padStart(3, '0');
  return cleanPrefix ? `${cleanPrefix}-${padded}` : padded;
}

export default function LlamadorPage() {
  // Vinculación con el televisor
  const [screenId, setScreenId] = useState<string>('');
  const [screen, setScreen] = useState<(Screen & { id: string }) | null>(null);
  const [codeInput, setCodeInput] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [booting, setBooting] = useState<boolean>(true);

  // Modo de operación: 'numeric' (Farmacia / Caja) | 'patient' (Clínica / Consultorio)
  const [mode, setMode] = useState<'numeric' | 'patient'>('numeric');

  // Controles Modo Numérico
  const [prefix, setPrefix] = useState<string>('A');
  const [currentNumber, setCurrentNumber] = useState<number>(0);
  const [counterStation, setCounterStation] = useState<string>('CAJA 1');

  // Controles Modo Paciente / Consultorio
  const [patientName, setPatientName] = useState<string>('');
  const [consultingRoom, setConsultingRoom] = useState<string>('CONSULTORIO 1');

  // Audio / Voz en el TV
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);

  // Feedback visual
  const [statusToast, setStatusToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );
  const [isSending, setIsSending] = useState<boolean>(false);

  const notify = (type: 'ok' | 'err', text: string) => {
    setStatusToast({ type, text });
    setTimeout(() => setStatusToast(null), 3500);
  };

  // Recuperar pantalla guardada en este mostrador
  useEffect(() => {
    const savedId = localStorage.getItem(STORAGE_SCREEN_ID_KEY);
    if (savedId) {
      setScreenId(savedId);
    }
    setBooting(false);
  }, []);

  // Escuchar en tiempo real el televisor vinculado
  useEffect(() => {
    if (!screenId) {
      setScreen(null);
      return;
    }

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

        if (data.callerState) {
          if (typeof data.callerState.lastNumber === 'number') {
            setCurrentNumber(data.callerState.lastNumber);
          }
          if (typeof data.callerState.prefix === 'string') {
            setPrefix(data.callerState.prefix);
          }
          if (data.callerState.defaultDestination) {
            setCounterStation(data.callerState.defaultDestination);
          }
          if (typeof data.callerState.voiceEnabled === 'boolean') {
            setVoiceEnabled(data.callerState.voiceEnabled);
          }
        }
      },
      () => {
        notify('err', 'Error de conexión con el televisor');
      }
    );

    return () => unsub();
  }, [screenId]);

  // Vincular mostrador con el código de 6 dígitos del TV
  const handleConnectScreen = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = codeInput.trim().toUpperCase();
    if (!cleanCode) return;

    setIsConnecting(true);
    try {
      const q = query(collection(db, 'screens'), where('pairingCode', '==', cleanCode));
      const snap = await getDocs(q);

      if (snap.empty) {
        notify('err', 'No existe ningún televisor con ese código');
        return;
      }

      const target = snap.docs[0];
      localStorage.setItem(STORAGE_SCREEN_ID_KEY, target.id);
      setScreenId(target.id);
      setCodeInput('');
      notify('ok', 'Mostrador vinculado al televisor');
    } catch {
      notify('err', 'Error al buscar el televisor');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    localStorage.removeItem(STORAGE_SCREEN_ID_KEY);
    setScreenId('');
    setScreen(null);
  };

  // Enviar nuevo llamado a Firestore
  const pushCall = useCallback(
    async (
      ticketText: string,
      destinationText: string,
      options?: {
        isRecall?: boolean;
        nextNumber?: number;
      }
    ) => {
      if (!screen || isSending) return;
      const cleanTicket = ticketText.trim().toUpperCase();
      const cleanDest = destinationText.trim().toUpperCase() || 'MOSTRADOR';
      if (!cleanTicket) return;

      setIsSending(true);
      try {
        const now = Date.now();
        const newEntry: CallerEntry = {
          id: `${now}-${Math.random().toString(36).slice(2, 6)}`,
          ticket: cleanTicket,
          destination: cleanDest,
          timestamp: now,
        };

        const prevCurrent = screen.callerState?.current || null;
        const prevHistory = screen.callerState?.history || [];

        const updatedHistory =
          options?.isRecall || !prevCurrent
            ? prevHistory
            : [prevCurrent, ...prevHistory].slice(0, 5);

        const nextCallerState: CallerState = {
          current: newEntry,
          history: updatedHistory,
          prefix: prefix.trim().toUpperCase(),
          lastNumber:
            typeof options?.nextNumber === 'number' ? options.nextNumber : currentNumber,
          defaultDestination: cleanDest,
          voiceEnabled,
          updatedAt: now,
        };

        await updateDoc(doc(db, 'screens', screen.id), {
          callerState: nextCallerState,
        });

        if (typeof options?.nextNumber === 'number') {
          setCurrentNumber(options.nextNumber);
        }
      } catch {
        notify('err', 'No se pudo enviar el llamado al TV');
      } finally {
        setIsSending(false);
      }
    },
    [screen, isSending, prefix, currentNumber, voiceEnabled]
  );

  // Acciones Modo Numérico (Farmacia / Caja)
  const handleCallNextNumber = useCallback(() => {
    const nextNum = currentNumber + 1;
    const ticket = formatTicket(prefix, nextNum);
    pushCall(ticket, counterStation, { nextNumber: nextNum });
  }, [currentNumber, prefix, counterStation, pushCall]);

  const handleCallPrevNumber = useCallback(() => {
    const prevNum = Math.max(1, currentNumber - 1);
    const ticket = formatTicket(prefix, prevNum);
    pushCall(ticket, counterStation, { nextNumber: prevNum });
  }, [currentNumber, prefix, counterStation, pushCall]);

  const handleRecallCurrent = useCallback(() => {
    const current = screen?.callerState?.current;
    if (!current) return;
    pushCall(current.ticket, current.destination, { isRecall: true });
    notify('ok', `Rellamando: ${current.ticket}`);
  }, [screen, pushCall]);

  // Acción Modo Paciente / Consultorio
  const handleCallPatient = (e: React.FormEvent) => {
    e.preventDefault();
    if (!patientName.trim()) return;
    pushCall(patientName, consultingRoom);
    setPatientName('');
  };

  // Limpiar pantalla de turnos en el TV
  const handleClearQueue = async () => {
    if (!screen) return;
    try {
      const resetState: CallerState = {
        current: null,
        history: [],
        prefix: prefix.trim().toUpperCase(),
        lastNumber: 0,
        defaultDestination: counterStation.trim().toUpperCase(),
        voiceEnabled,
        updatedAt: Date.now(),
      };
      await updateDoc(doc(db, 'screens', screen.id), {
        callerState: resetState,
      });
      setCurrentNumber(0);
      notify('ok', 'Cola de turnos reiniciada a 0');
    } catch {
      notify('err', 'Error al limpiar los turnos');
    }
  };

  // Atajos de teclado físico tipo Llamador Clásico (Teclado Numérico USB)
  useEffect(() => {
    if (!screen || mode !== 'numeric') return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT';

      if (e.code === 'NumpadAdd' || (!isTyping && (e.key === '+' || e.key === 'Enter'))) {
        e.preventDefault();
        handleCallNextNumber();
      } else if (e.code === 'NumpadMultiply' || (!isTyping && e.key === '*')) {
        e.preventDefault();
        handleRecallCurrent();
      } else if (e.code === 'NumpadSubtract' || (!isTyping && e.key === '-')) {
        e.preventDefault();
        handleCallPrevNumber();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [screen, mode, handleCallNextNumber, handleRecallCurrent, handleCallPrevNumber]);

  if (booting) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-400 flex items-center justify-center">
        Iniciando terminal de turnos...
      </div>
    );
  }

  // Pantalla de vinculación inicial del mostrador
  if (!screenId || !screen) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-6">
        <form
          onSubmit={handleConnectScreen}
          className="w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-2xl p-8 shadow-2xl space-y-5"
        >
          <div>
            <span className="inline-block px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium mb-2">
              Terminal de Mostrador
            </span>
            <h1 className="text-2xl font-bold">Llamador de Turnos</h1>
            <p className="text-sm text-neutral-400 mt-1">
              Ingresá el código de 6 dígitos del televisor donde querés emitir los llamados.
            </p>
          </div>

          <input
            type="text"
            maxLength={6}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            placeholder="EJ: A1B2C3"
            className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3.5 text-center text-xl font-mono tracking-widest uppercase focus:outline-none focus:border-emerald-500"
            autoFocus
          />

          <button
            type="submit"
            disabled={isConnecting}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 rounded-xl transition"
          >
            {isConnecting ? 'Conectando...' : 'Conectar con Televisor'}
          </button>

          {statusToast && (
            <p
              className={`text-center text-sm ${
                statusToast.type === 'ok' ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {statusToast.text}
            </p>
          )}
        </form>
      </div>
    );
  }

  const activeCall = screen.callerState?.current || null;
  const callHistory = screen.callerState?.history || [];

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Cabecera */}
        <header className="flex flex-wrap items-center justify-between gap-4 bg-neutral-900 border border-neutral-800 rounded-2xl p-4 md:p-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-medium text-emerald-400 uppercase tracking-wider">
                Conectado a TV: {screen.name}
              </span>
              <span className="text-xs font-mono text-neutral-500">({screen.pairingCode})</span>
            </div>
            <h1 className="text-xl font-bold mt-1">Consola de Llamado al Público</h1>
          </div>

          <div className="flex items-center gap-2.5">
            <label className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 px-3 py-2 rounded-xl text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={voiceEnabled}
                onChange={(e) => setVoiceEnabled(e.target.checked)}
                className="accent-emerald-500"
              />
              <span>Voz + Timbre en TV</span>
            </label>

            <button
              type="button"
              onClick={handleDisconnect}
              className="bg-neutral-950 hover:bg-neutral-800 border border-neutral-700 px-3.5 py-2 rounded-xl text-xs text-neutral-300 transition"
            >
              Cambiar TV
            </button>
          </div>
        </header>

        {/* Aviso si el modo llamador todavía está apagado en el panel */}
        {!screen.callerEnabled && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-200 px-4 py-3 rounded-xl text-xs md:text-sm">
            ⚠️ <strong>Aviso:</strong> Este televisor tiene la columna de turnos oculta. Activala
            en el panel principal tocando el botón <strong>&ldquo;🔔 Llamador: OFF&rdquo;</strong> en la
            tarjeta de <strong>{screen.name}</strong>.
          </div>
        )}

        {statusToast && (
          <div
            className={`px-4 py-2.5 rounded-xl text-sm font-medium border ${
              statusToast.type === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}
          >
            {statusToast.text}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Columna Izquierda: Botonera de Llamado */}
          <section className="lg:col-span-7 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6">
            {/* Selector de Modo */}
            <div className="grid grid-cols-2 gap-2 bg-neutral-950 p-1.5 rounded-xl border border-neutral-800">
              <button
                type="button"
                onClick={() => setMode('numeric')}
                className={`py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition ${
                  mode === 'numeric'
                    ? 'bg-emerald-600 text-white'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                🔢 Turno Numérico (Farmacia)
              </button>
              <button
                type="button"
                onClick={() => setMode('patient')}
                className={`py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition ${
                  mode === 'patient'
                    ? 'bg-indigo-600 text-white'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                🩺 Por Nombre (Clínica)
              </button>
            </div>

            {mode === 'numeric' ? (
              <div className="space-y-5">
                {/* Configuración de Letra, Puesto y Número manual */}
                <div className="grid grid-cols-3 gap-3 bg-neutral-950 border border-neutral-800 rounded-xl p-4">
                  <div>
                    <label className="block text-[11px] text-neutral-400 mb-1">
                      Letra / Fila
                    </label>
                    <input
                      type="text"
                      maxLength={3}
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                      placeholder="A"
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm font-mono uppercase text-center"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-neutral-400 mb-1">
                      Puesto / Caja
                    </label>
                    <input
                      type="text"
                      value={counterStation}
                      onChange={(e) => setCounterStation(e.target.value)}
                      placeholder="CAJA 1"
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm uppercase"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-neutral-400 mb-1">
                      N° Actual
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={9999}
                      value={currentNumber}
                      onChange={(e) => setCurrentNumber(Math.max(0, Number(e.target.value)))}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm font-mono text-center"
                    />
                  </div>
                </div>

                {/* Botón Gigante Llamar Siguiente */}
                <button
                  type="button"
                  onClick={handleCallNextNumber}
                  disabled={isSending}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 active:scale-[0.99] text-white rounded-2xl py-7 px-6 shadow-xl shadow-emerald-600/20 transition flex flex-col items-center justify-center gap-1"
                >
                  <span className="text-xs uppercase tracking-widest text-emerald-100">
                    Llamar Siguiente (Tecla + o Enter)
                  </span>
                  <span className="text-3xl md:text-4xl font-black tracking-tight">
                    {formatTicket(prefix, currentNumber + 1)} →{' '}
                    {counterStation.trim().toUpperCase() || 'MOSTRADOR'}
                  </span>
                </button>

                {/* Botones secundarios tipo llamador clásico */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={handleRecallCurrent}
                    disabled={!activeCall || isSending}
                    className="bg-amber-600/20 hover:bg-amber-600/30 disabled:opacity-40 border border-amber-500/40 text-amber-200 font-semibold py-3.5 px-4 rounded-xl text-sm transition"
                  >
                    🔔 Rellamar Actual (Tecla *)
                  </button>

                  <button
                    type="button"
                    onClick={handleCallPrevNumber}
                    disabled={currentNumber <= 1 || isSending}
                    className="bg-neutral-950 hover:bg-neutral-800 disabled:opacity-40 border border-neutral-800 text-neutral-300 font-medium py-3.5 px-4 rounded-xl text-sm transition"
                  >
                    ← Número Anterior (Tecla -)
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCallPatient} className="space-y-4">
                <div className="space-y-3 bg-neutral-950 border border-neutral-800 rounded-xl p-4">
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">
                      Nombre y Apellido del Paciente
                    </label>
                    <input
                      type="text"
                      required
                      value={patientName}
                      onChange={(e) => setPatientName(e.target.value)}
                      placeholder="Ej: María Gómez"
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">
                      Consultorio / Box / Sector
                    </label>
                    <input
                      type="text"
                      required
                      value={consultingRoom}
                      onChange={(e) => setConsultingRoom(e.target.value)}
                      placeholder="Ej: CONSULTORIO 4"
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-sm uppercase focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSending || !patientName.trim()}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold py-4 rounded-xl text-base shadow-lg shadow-indigo-600/20 transition"
                >
                  📢 Llamar Paciente en Pantalla
                </button>

                {activeCall && (
                  <button
                    type="button"
                    onClick={handleRecallCurrent}
                    className="w-full bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/40 text-amber-200 font-semibold py-3 rounded-xl text-sm transition"
                  >
                    🔔 Rellamar a {activeCall.ticket}
                  </button>
                )}
              </form>
            )}
          </section>

          {/* Columna Derecha: Lo que está viendo el público ahora */}
          <section className="lg:col-span-5 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 flex flex-col justify-between gap-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
                  En Pantalla Ahora
                </h2>
                <button
                  type="button"
                  onClick={handleClearQueue}
                  className="text-xs text-neutral-500 hover:text-red-400 transition"
                >
                  Reiniciar cola
                </button>
              </div>

              <div className="bg-neutral-950 border-2 border-emerald-500/40 rounded-2xl p-6 text-center space-y-2">
                {activeCall ? (
                  <>
                    <span className="inline-block text-[11px] uppercase tracking-widest px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
                      Turno Actual
                    </span>
                    <p className="text-4xl font-black tracking-tight text-white">
                      {activeCall.ticket}
                    </p>
                    <p className="text-lg font-semibold text-emerald-400">
                      {activeCall.destination}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-neutral-500 py-6">
                    Todavía no se llamó ningún turno
                  </p>
                )}
              </div>

              {/* Últimos llamados */}
              <div className="space-y-2 pt-2">
                <h3 className="text-xs font-medium text-neutral-400">Últimos llamados</h3>
                {callHistory.length === 0 ? (
                  <p className="text-xs text-neutral-600">Sin historial reciente</p>
                ) : (
                  <ul className="space-y-1.5">
                    {callHistory.map((item) => (
                      <li
                        key={item.id}
                        className="flex items-center justify-between bg-neutral-950 border border-neutral-800/80 rounded-xl px-3.5 py-2 text-xs"
                      >
                        <span className="font-bold text-neutral-200">{item.ticket}</span>
                        <span className="text-neutral-400">{item.destination}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-3.5 text-[11px] text-neutral-400 leading-relaxed">
              💡 <strong>Tip de mostrador:</strong> Podés usar un teclado numérico USB común.
              Apretá <strong className="text-white">+</strong> para avanzar turno y{' '}
              <strong className="text-white">*</strong> para volver a tocar el timbre.
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}