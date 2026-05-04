/**
 * Pixel-art diamond logo for Zonthor Studio. 16×16 grid rendered with a gold
 * linear gradient + diagonal inner highlight to read as a faceted gemstone
 * rather than a flat rhombus. `shape-rendering="crispEdges"` keeps pixels
 * crunchy at every scale.
 */

// Solid diamond — same silhouette as the bundle .icns so the brand reads
// consistently from Dock to in-app header.
const DIAMOND_GRID = [
  "................",
  "................",
  "....########....",
  "...##########...",
  "..############..",
  ".##############.",
  ".##############.",
  "..############..",
  "...##########...",
  "....########....",
  ".....######.....",
  "......####......",
  ".......##.......",
  "................",
  "................",
  "................",
];

interface Props {
  size?: number;
  className?: string;
}

export function Logo({ size = 32, className = "" }: Props) {
  const base: JSX.Element[] = [];
  for (let y = 0; y < DIAMOND_GRID.length; y++) {
    for (let x = 0; x < DIAMOND_GRID[y].length; x++) {
      if (DIAMOND_GRID[y][x] === "#") {
        base.push(
          <rect
            key={`b-${x}-${y}`}
            x={x}
            y={y}
            width="1"
            height="1"
            fill="url(#diamondBody)"
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
      aria-label="Zonthor Studio"
    >
      <defs>
        <linearGradient id="diamondBody" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f8e89a" />
          <stop offset="50%" stopColor="#f4d03f" />
          <stop offset="100%" stopColor="#a98a2b" />
        </linearGradient>
      </defs>
      {base}
    </svg>
  );
}
