import { pct } from "../lib/format";

interface Props {
  value: number;
  total: number;
  label?: string;
  pulsing?: boolean;
}

export function ProgressBar({ value, total, label, pulsing = false }: Props) {
  const percent = pct(value, total);
  return (
    <div>
      <div className="h-2 w-full bg-white/[0.05] rounded-full overflow-hidden border border-white/[0.05]">
        <div
          className={[
            "h-full bg-gradient-to-r from-gold-600 via-gold-500 to-gold-300",
            "transition-[width] duration-200 ease-out",
            pulsing ? "animate-gold-pulse" : "",
          ].join(" ")}
          style={{ width: `${percent}%` }}
        />
      </div>
      {label && (
        <div className="mt-1.5 text-[11px] text-zinc-500 flex justify-between">
          <span>{label}</span>
          <span className="text-gold-200/80">{percent.toFixed(0)}%</span>
        </div>
      )}
    </div>
  );
}
