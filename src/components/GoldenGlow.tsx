export function GoldenGlow() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute -top-40 -left-32 w-[520px] h-[520px] rounded-full blur-[120px] opacity-30 animate-gold-pulse"
        style={{
          background:
            "radial-gradient(closest-side, rgba(244,208,63,0.55), rgba(212,175,55,0) 70%)",
        }}
      />
      <div
        className="absolute -bottom-40 -right-24 w-[640px] h-[640px] rounded-full blur-[140px] opacity-25"
        style={{
          background:
            "radial-gradient(closest-side, rgba(212,175,55,0.45), rgba(212,175,55,0) 70%)",
        }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(255,255,255,0.02)_0%,_transparent_60%)]" />
    </div>
  );
}
