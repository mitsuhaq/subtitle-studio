/**
 * Pixel-art "S" logo for the header. 16×16 pixel grid rendered with a gold
 * linear gradient and a subtle inner glow. `shape-rendering="crispEdges"` keeps
 * pixels crunchy at every scale.
 */

const S_GRID = [
  "................",
  "................",
  "....########....",
  "...##########...",
  "..####....####..",
  "..####..........",
  "..####..........",
  "...########.....",
  "....########....",
  ".......######...",
  "..........####..",
  ".####.....####..",
  "..####...####...",
  "...##########...",
  "....########....",
  "................",
];

interface Props {
  size?: number;
  className?: string;
}

export function Logo({ size = 32, className = "" }: Props) {
  const rects = [];
  for (let y = 0; y < S_GRID.length; y++) {
    for (let x = 0; x < S_GRID[y].length; x++) {
      if (S_GRID[y][x] === "#") {
        rects.push(
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width="1"
            height="1"
            fill="url(#logoGold)"
          />,
        );
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label="Subtitle Studio"
    >
      <defs>
        <linearGradient id="logoGold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f8e89a" />
          <stop offset="50%" stopColor="#f4d03f" />
          <stop offset="100%" stopColor="#a98a2b" />
        </linearGradient>
      </defs>
      {rects}
    </svg>
  );
}
