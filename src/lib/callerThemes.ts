import { CallerTheme } from '../types/signage';

export interface CallerThemeConfig {
  id: CallerTheme;
  label: string;
  description: string;
  swatches: [string, string, string];
  // Clases para el Televisor (/player)
  playerSidebarBg: string;
  playerBorder: string;
  playerHeaderTitle: string;
  playerCodeText: string;
  playerDot: string;
  playerCardIdle: string;
  playerCardFlash: string;
  playerLabelIdle: string;
  playerLabelFlash: string;
  playerDestIdle: string;
  playerDestFlash: string;
  playerHistoryCard: string;
  playerHistoryTicket: string;
  playerHistoryDest: string;
  // Clases para el Mostrador (/llamador)
  callerPageBg: string;
  callerCardBg: string;
  callerCardBorder: string;
  callerPrimaryBtn: string;
  callerAccentText: string;
  callerActiveBorder: string;
}

export const CALLER_THEMES: Record<CallerTheme, CallerThemeConfig> = {
  clinical: {
    id: 'clinical',
    label: 'Salud & Confianza Clínica',
    description: 'Azul noche profundo, cian clínico y verde salud',
    swatches: ['#0B1120', '#0EA5E9', '#10B981'],
    playerSidebarBg: 'bg-[#0B1120]',
    playerBorder: 'border-sky-900/70',
    playerHeaderTitle: 'text-sky-200',
    playerCodeText: 'text-sky-500/70',
    playerDot: 'bg-emerald-400',
    playerCardIdle: 'bg-[#111827] border-sky-500/50 text-white',
    playerCardFlash:
      'bg-emerald-500 border-white text-slate-950 scale-[1.02] shadow-[0_0_45px_rgba(16,185,129,0.65)]',
    playerLabelIdle: 'text-sky-400',
    playerLabelFlash: 'text-slate-950/80',
    playerDestIdle: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/35',
    playerDestFlash: 'bg-slate-950 text-emerald-400',
    playerHistoryCard: 'bg-[#111827]/90 border-sky-900/50',
    playerHistoryTicket: 'text-slate-100',
    playerHistoryDest: 'text-sky-400',
    callerPageBg: 'bg-[#0B1120] text-white',
    callerCardBg: 'bg-[#111827]',
    callerCardBorder: 'border-sky-900/60',
    callerPrimaryBtn: 'bg-sky-600 hover:bg-sky-500 shadow-sky-600/20 text-white',
    callerAccentText: 'text-sky-400',
    callerActiveBorder: 'border-sky-500/50',
  },
  broadcast: {
    id: 'broadcast',
    label: 'Broadcast & Retail Ejecutivo',
    description: 'Negro pizarra, índigo ejecutivo y acentos ámbar',
    swatches: ['#09090B', '#6366F1', '#F59E0B'],
    playerSidebarBg: 'bg-[#09090B]',
    playerBorder: 'border-zinc-800',
    playerHeaderTitle: 'text-zinc-200',
    playerCodeText: 'text-zinc-500',
    playerDot: 'bg-amber-400',
    playerCardIdle: 'bg-[#141418] border-amber-500/50 text-white',
    playerCardFlash:
      'bg-amber-400 border-white text-zinc-950 scale-[1.02] shadow-[0_0_45px_rgba(245,158,11,0.65)]',
    playerLabelIdle: 'text-amber-400',
    playerLabelFlash: 'text-zinc-950/80',
    playerDestIdle: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40',
    playerDestFlash: 'bg-zinc-950 text-amber-400',
    playerHistoryCard: 'bg-[#141418] border-zinc-800',
    playerHistoryTicket: 'text-zinc-100',
    playerHistoryDest: 'text-amber-400',
    callerPageBg: 'bg-[#09090B] text-white',
    callerCardBg: 'bg-[#141418]',
    callerCardBorder: 'border-zinc-800',
    callerPrimaryBtn: 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/20 text-white',
    callerAccentText: 'text-amber-400',
    callerActiveBorder: 'border-amber-500/50',
  },
  editorial: {
    id: 'editorial',
    label: 'Editorial & Calidez Orgánica',
    description: 'Marfil cálido, verde oliva salvia y terracota',
    swatches: ['#F8F7F4', '#4D5E46', '#D96B27'],
    playerSidebarBg: 'bg-[#F8F7F4]',
    playerBorder: 'border-[#DCD6CA]',
    playerHeaderTitle: 'text-[#1A1A1A]',
    playerCodeText: 'text-[#6E6A63]',
    playerDot: 'bg-[#D96B27]',
    playerCardIdle: 'bg-[#EAE5DC] border-[#4D5E46]/40 text-[#1A1A1A]',
    playerCardFlash:
      'bg-[#D96B27] border-[#1A1A1A] text-white scale-[1.02] shadow-[0_0_40px_rgba(217,107,39,0.45)]',
    playerLabelIdle: 'text-[#4D5E46]',
    playerLabelFlash: 'text-white/90',
    playerDestIdle: 'bg-[#4D5E46] text-white border border-[#4D5E46]',
    playerDestFlash: 'bg-[#1A1A1A] text-[#F8F7F4]',
    playerHistoryCard: 'bg-[#EAE5DC]/80 border-[#DCD6CA]',
    playerHistoryTicket: 'text-[#1A1A1A]',
    playerHistoryDest: 'text-[#4D5E46]',
    callerPageBg: 'bg-[#F8F7F4] text-[#1A1A1A]',
    callerCardBg: 'bg-[#EAE5DC]',
    callerCardBorder: 'border-[#DCD6CA]',
    callerPrimaryBtn: 'bg-[#4D5E46] hover:bg-[#3E4C38] shadow-[#4D5E46]/20 text-white',
    callerAccentText: 'text-[#D96B27]',
    callerActiveBorder: 'border-[#4D5E46]',
  },
};

export function getCallerTheme(theme?: CallerTheme): CallerThemeConfig {
  if (theme && CALLER_THEMES[theme]) {
    return CALLER_THEMES[theme];
  }
  return CALLER_THEMES.clinical;
}