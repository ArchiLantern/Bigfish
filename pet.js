'use strict';
const img = document.getElementById('pet');
const bubble = document.getElementById('bubble');

const FRAMES = {
  idle: ['assets/pet/idle.png'],
  eat: ['assets/pet/eat-1.png', 'assets/pet/eat-2.png', 'assets/pet/eat-3.png', 'assets/pet/eat-4.png'],
  'walk-left': ['assets/pet/walk-left-1.png', 'assets/pet/walk-left-2.png'],
  'walk-right': ['assets/pet/walk-right-1.png', 'assets/pet/walk-right-2.png'],
  sleep: ['assets/pet/sleep.png'],
};
const FRAME_MS = { idle: 0, eat: 220, 'walk-left': 240, 'walk-right': 240, sleep: 0 };

let state = 'idle';
let frameIndex = 0;
let animTimer = null;

function setState(s) {
  if (!FRAMES[s]) return;
  state = s;
  frameIndex = 0;
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  img.src = FRAMES[s][0];
  img.classList.toggle('animate-bob', s === 'idle');
  if (FRAMES[s].length > 1 && FRAME_MS[s] > 0) {
    animTimer = setInterval(() => {
      frameIndex = (frameIndex + 1) % FRAMES[s].length;
      img.src = FRAMES[s][frameIndex];
    }, FRAME_MS[s]);
  }
}

// drag to move; a click (no movement) summons the main window
let dragging = false;
let moved = false;
let startX = 0;
let startY = 0;

window.addEventListener('mousedown', (e) => {
  dragging = true;
  moved = false;
  startX = e.screenX;
  startY = e.screenY;
  document.body.style.cursor = 'grabbing';
  window.petAPI.dragStart(startX, startY);
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (Math.abs(e.screenX - startX) + Math.abs(e.screenY - startY) > 5) moved = true;
  window.petAPI.dragMove(e.screenX, e.screenY);
});
window.addEventListener('mouseup', () => {
  if (dragging && !moved) window.petAPI.clicked();
  dragging = false;
  document.body.style.cursor = 'grab';
});

window.petAPI.onSay((msg) => {
  bubble.textContent = msg;
  bubble.classList.add('show');
  setTimeout(() => bubble.classList.remove('show'), 4000);
});
window.petAPI.onState((s) => setState(s));

// 点击穿透只在 Windows 上可靠；Linux 上开启会导致整个桌宠点不到。
// 用 navigator.platform 判断（渲染进程里拿不到 process.platform）
const isWindows = /Win/i.test(navigator.platform || '');
if (isWindows) {
  // Click-through: only the pet image and the visible bubble capture the mouse;
  // the transparent surroundings pass clicks through to the desktop.
  let lastInteractive = false;
  function isInteractivePoint(x, y) {
    const r = img.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    if (bubble.classList.contains('show')) {
      const br = bubble.getBoundingClientRect();
      if (x >= br.left && x <= br.right && y >= br.top && y <= br.bottom) return true;
    }
    return false;
  }
  window.addEventListener('mousemove', (e) => {
    const interactive = isInteractivePoint(e.clientX, e.clientY);
    if (interactive !== lastInteractive) {
      lastInteractive = interactive;
      window.petAPI.setIgnoreMouse(!interactive);
    }
  });
}

setState('idle');
