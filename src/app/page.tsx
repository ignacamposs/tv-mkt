import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-neutral-900 border border-neutral-800 rounded-3xl p-8 text-center space-y-6 shadow-2xl">
        <div>
          <span className="inline-block px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium mb-3">
            Sistema Activo
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Cartelería Digital</h1>
          <p className="text-sm text-neutral-400 mt-1">
            Seleccioná el modo de uso para este dispositivo
          </p>
        </div>

        <div className="space-y-3">
          <Link
            href="/dashboard"
            className="block w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3.5 rounded-xl transition"
          >
            Panel de Control (Admin)
          </Link>

          <Link
            href="/player"
            className="block w-full bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-semibold py-3.5 rounded-xl transition"
          >
            Reproductor de Pantalla (TV)
          </Link>
        </div>
      </div>
    </main>
  );
}