import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 90; // ~11 fps — slow, choppy, "Claude vibe"

interface Props {
  className?: string;
  size?: number;
}

export function PixelSpinner({ className = "", size = 14 }: Props) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setI((x) => (x + 1) % FRAMES.length),
      FRAME_MS,
    );
    return () => window.clearInterval(id);
  }, []);
  return (
    <span
      className={`font-mono leading-none select-none tabular-nums ${className}`}
      style={{ fontSize: size, lineHeight: 1 }}
      aria-label="Загрузка"
    >
      {FRAMES[i]}
    </span>
  );
}
