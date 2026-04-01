import { useRef, useEffect } from "react";

const CHARS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

interface Column {
  y: number;
  speed: number;
  length: number;
  chars: string[];
  delay: number;
}

export function MatrixRain({ width = 18, height = 18 }: { width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const scale = window.devicePixelRatio || 1;
    canvas.width = width * scale;
    canvas.height = height * scale;
    ctx.scale(scale, scale);

    const fontSize = 7;
    const columns = Math.ceil(width / fontSize) * 4;

    const makeColumn = (): Column => ({
      y: -Math.random() * height * 2,
      speed: 1.5 + Math.random() * 3,
      length: 5 + Math.floor(Math.random() * 15),
      chars: Array.from({ length: 25 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]),
      delay: Math.random() * 100,
    });

    const cols: Column[] = Array.from({ length: columns }, makeColumn);
    // Stagger start positions for randomness
    cols.forEach((c) => { c.y = -Math.random() * height * 3; });

    let frame = 0;
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      frame++;

      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        if (frame < col.delay) continue;

        const x = (i * fontSize * 0.25) + Math.sin(i * 7) * 3;

        for (let j = 0; j < col.length; j++) {
          const charY = col.y - j * fontSize;
          if (charY < -fontSize || charY > height + fontSize) continue;

          // Randomly mutate characters occasionally
          if (Math.random() < 0.03) {
            col.chars[j % col.chars.length] = CHARS[Math.floor(Math.random() * CHARS.length)];
          }

          const char = col.chars[j % col.chars.length];

          if (j === 0) {
            // Head: bright white-green
            ctx.fillStyle = "rgba(180, 255, 180, 0.95)";
            ctx.font = `bold ${fontSize}px monospace`;
          } else {
            // Trail: green fading out
            const fade = 1 - j / col.length;
            const green = Math.floor(180 + fade * 75);
            ctx.fillStyle = `rgba(0, ${green}, 30, ${fade * 0.8})`;
            ctx.font = `${fontSize}px monospace`;
          }

          ctx.fillText(char, x, charY);
        }

        col.y += col.speed * fontSize * 0.15;

        // Reset when fully off screen
        if (col.y - col.length * fontSize > height) {
          cols[i] = makeColumn();
          cols[i].y = -Math.random() * height * 0.5;
          cols[i].delay = 0;
        }
      }
    };

    const interval = setInterval(draw, 50);
    return () => clearInterval(interval);
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width,
        height,
        flexShrink: 0,
      }}
    />
  );
}
