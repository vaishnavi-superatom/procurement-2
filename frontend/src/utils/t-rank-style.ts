// T-rank colours, shared by the T-rank badge and the charts (review, 18 Oct: the
// chart dots "should also be the same colour"). T4 is cyan rather than an orange
// next to T3's amber; validated as a set on white (CVD ΔE ≥ 7.3, with labels).
export const T_RANK_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  T1: { bg: '#DCFCE7', fg: '#16A34A', label: 'T1' },
  T2: { bg: '#EBEEFA', fg: '#3A59CD', label: 'T2' },
  T3: { bg: '#FEF3C7', fg: '#B45309', label: 'T3' },
  T4: { bg: '#CFFAFE', fg: '#0891B2', label: 'T4' },
  NOT_ACCEPTED: { bg: '#F1F5F9', fg: '#475569', label: 'Not accepted' },
};
