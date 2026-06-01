import { invoke } from '@tauri-apps/api/core';
import { register as registerHotkey } from '@tauri-apps/plugin-global-shortcut';
import { renderMarkdown } from './markdown.js';
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
  primaryMonitor,
} from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

// ========== 窗口尺寸 ==========
const WINDOW_PAD = 8;
const BALL_SIZE = 96;
const BALL_WINDOW = {
  width: BALL_SIZE + WINDOW_PAD * 2,
  height: BALL_SIZE + WINDOW_PAD * 2,
};
const PANEL_WIDTH = 400;
const PANEL_GAP = 16;
const PANEL_LEFT = WINDOW_PAD + BALL_SIZE + PANEL_GAP;
const PANEL_SIDE_OFFSET = PANEL_WIDTH + PANEL_GAP;
const PANEL_WINDOW_WIDTH = PANEL_LEFT + PANEL_WIDTH + WINDOW_PAD;
const PANEL_MIN_WINDOW_HEIGHT = 520;
const PANEL_MAX_WINDOW_HEIGHT = 820;
const PRESS_TO_DRAG_DELAY_MS = 150;
const HOVER_ACTION_DELAY_MS = 500;
const DOCK_EDGE_THRESHOLD = 20;
const DOCK_VISIBLE_WIDTH = 64;

// ========== 状态 ==========
let currentMode = 'ball';
let lastText = '';
let lastAnswer = '';
let latestRequestId = 0;
let lastRememberTargetAt = 0;
let lastBallPosition = null;
let overlayState = null;
let selectionState = null;
let ballActionInProgress = false;
let catAnimationTimer = null;
let catAnimationToken = 0;
let catAnimationResolve = null;
let isBallDragging = false;
let ballPressState = null;
let ballHoverTimer = null;
let ballHoverTriggered = false;
let ballHoverAnimationActive = false;
let ballHoverHoldActive = false;
let dockedBallSide = null;
let panelAnchorPosition = null;
let panelLayout = null;

// ========== DOM 元素 ==========
const $ball = document.getElementById('floating-ball');
const $catSprite = document.getElementById('cat-sprite');
const $panel = document.getElementById('panel');
const $header = document.getElementById('panel-header');
const $placeholder = document.getElementById('placeholder');
const $loading = document.getElementById('loading');
const $loadingText = document.getElementById('loading-text');
const $result = document.getElementById('result');
const $error = document.getElementById('error');
const $modeIndicator = document.getElementById('mode-indicator');
const $btnPaste = document.getElementById('btn-paste');
const $btnSettings = document.getElementById('btn-settings');
const $btnCopy = document.getElementById('btn-copy');
const $btnRetry = document.getElementById('btn-retry');
const $btnClose = document.getElementById('btn-close');
const $settingsPanel = document.getElementById('settings-panel');
const $apiKey = document.getElementById('api-key');
const $ocrApiKey = document.getElementById('ocr-api-key');
const $ocrConsent = document.getElementById('ocr-consent');
const $answerLanguage = document.getElementById('answer-language');
const $systemPrompt = document.getElementById('system-prompt');
const $btnSaveSettings = document.getElementById('btn-save-settings');
const $btnResetPrompt = document.getElementById('btn-reset-prompt');
const $settingsStatus = document.getElementById('settings-status');
const $overlay = document.getElementById('selection-overlay');
const $selectionBox = document.getElementById('selection-box');

// ========== 初始化 ==========
async function init() {
  document.body.classList.add('mode-ball');
  preloadCatFrames();
  await loadSettings();
  setupEventListeners();
  setupBallDrag();
  setupBallHover();
  setupPanelDrag();
  setupSelectionOverlay();
  setupTargetWindowTracking();
  setupHotkeys();
  await enterBallMode({ preserveCurrentPosition: true });
}

// ========== 设置 ==========
const DEFAULT_PROMPT = '你是一个网页内容解释助手。请用简洁明了的语言解释以下网页文字内容，帮助用户快速理解。如果内容是外语，请翻译并解释。回答请使用{language}。';

const LANGUAGE_NAMES = {
  'zh-CN': '中文', 'zh-TW': '繁體中文', 'en': 'English',
  'ja': '日本語', 'ko': '한국어', 'fr': 'Français',
  'de': 'Deutsch', 'es': 'Español', 'ru': 'Русский',
};

async function loadSettings() {
  try {
    const settings = await invoke('load_settings');
    $apiKey.value = settings.api_key || '';
    $ocrApiKey.value = settings.ocr_api_key || '';
    $ocrConsent.checked = Boolean(settings.ocr_consent);
    $answerLanguage.value = settings.answer_language || 'zh-CN';
    $systemPrompt.value = settings.system_prompt || '';
  } catch (e) {
    console.error('加载设置失败:', e);
  }
}

async function saveSettings() {
  try {
    await invoke('save_settings', {
      settings: {
        api_key: $apiKey.value.trim(),
        ocr_api_key: $ocrApiKey.value.trim(),
        ocr_consent: $ocrConsent.checked,
        answer_language: $answerLanguage.value,
        system_prompt: $systemPrompt.value.trim(),
      }
    });
    $settingsStatus.textContent = '设置已保存';
    setTimeout(() => { $settingsStatus.textContent = ''; }, 2000);
  } catch (e) {
    $settingsStatus.textContent = '保存失败: ' + e;
  }
}

function getSystemPrompt() {
  const custom = $systemPrompt.value.trim();
  if (custom) return custom;
  const langName = LANGUAGE_NAMES[$answerLanguage.value] || '中文';
  return DEFAULT_PROMPT.replace('{language}', langName);
}

// ========== 事件监听 ==========
function setupEventListeners() {
  // 左键短按由 pointerup 判定。阻止浏览器 click 冒泡，避免重复执行。
  $ball.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // 悬浮球右键 → OCR 框选
  $ball.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelBallHoverAction({ resetTriggered: true });
    playCatAnimation('select').then((completed) => {
      if (completed) startSelectionMode();
    });
  });

  // 粘贴按钮
  $btnPaste.addEventListener('click', async () => {
    try {
      const text = await invoke('get_clipboard_text');
      if (text && text.trim()) {
        explainText(text.trim());
      } else {
        showError('剪贴板为空，请先在其他窗口复制文字 (Ctrl+C)');
      }
    } catch (e) {
      showError('剪贴板为空，请先在其他窗口复制文字 (Ctrl+C)');
    }
  });

  // 关闭按钮
  $btnClose.addEventListener('click', () => hidePanel());

  // 设置按钮
  $btnSettings.addEventListener('click', () => {
    const isVisible = $settingsPanel.style.display !== 'none';
    $settingsPanel.style.display = isVisible ? 'none' : 'block';
    fitPanelWindow();
  });

  // 保存设置
  $btnSaveSettings.addEventListener('click', saveSettings);

  // 重置提示词
  $btnResetPrompt.addEventListener('click', () => {
    $systemPrompt.value = '';
    $settingsStatus.textContent = '已恢复默认提示词';
    setTimeout(() => { $settingsStatus.textContent = ''; }, 2000);
    fitPanelWindow();
  });

  // 复制结果
  $btnCopy.addEventListener('click', async () => {
    if (lastAnswer) {
      try {
        await navigator.clipboard.writeText(lastAnswer);
        $btnCopy.classList.add('is-success');
        setTimeout(() => { $btnCopy.classList.remove('is-success'); }, 1500);
      } catch (e) {
        showError('复制失败: ' + e);
      }
    }
  });

  // 重试
  $btnRetry.addEventListener('click', () => {
    if (lastText) explainText(lastText);
  });

  // ESC 键
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (currentMode === 'overlay') {
      cancelSelectionMode();
    } else {
      hidePanel();
    }
  });

  // 点击面板外部关闭
  document.addEventListener('click', (e) => {
    if (currentMode !== 'panel') return;
    if (!$panel.contains(e.target) && !$ball.contains(e.target)) hidePanel();
  });
}

// ========== 热键 ==========
async function setupHotkeys() {
  try {
    await registerHotkey('Alt+Shift+A', () => toggleSelectMode());
  } catch (e) {
    console.error('热键注册失败:', e);
  }
}

// ========== 悬浮球拖拽 ==========
function setupBallDrag() {
  $ball.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (currentMode !== 'ball' || ballPressState) return;

    e.preventDefault();
    e.stopPropagation();
    cancelBallHoverAction({ resetTriggered: true, resumeIdle: true });
    $ball.setPointerCapture?.(e.pointerId);

    const pressState = {
      pointerId: e.pointerId,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      latestScreenX: e.screenX,
      latestScreenY: e.screenY,
      lastScreenX: e.screenX,
      dragTimer: null,
      dragging: false,
      startPositionPromise: getLogicalWindowPosition(),
      boundsPromise: getWorkAreaBounds(),
      startPosition: null,
      bounds: null,
      pendingPosition: null,
      moveScheduled: false,
      moveInFlight: false,
      moveCompletionPromise: Promise.resolve(),
    };
    ballPressState = pressState;
    pressState.dragTimer = setTimeout(
      () => beginBallDrag(pressState),
      PRESS_TO_DRAG_DELAY_MS,
    );
  });

  $ball.addEventListener('pointerup', (e) => {
    const pressState = ballPressState;
    if (!pressState || e.pointerId !== pressState.pointerId) return;

    e.preventDefault();
    e.stopPropagation();
    clearTimeout(pressState.dragTimer);
    if (pressState.dragging) {
      finishBallDrag(pressState, e);
      return;
    }

    ballPressState = null;
    $ball.releasePointerCapture?.(e.pointerId);
    triggerBallPrimaryAction();
  });

  $ball.addEventListener('pointercancel', (e) => {
    const pressState = ballPressState;
    if (!pressState || e.pointerId !== pressState.pointerId) return;

    clearTimeout(pressState.dragTimer);
    if (pressState.dragging) {
      finishBallDrag(pressState, e);
      return;
    }

    ballPressState = null;
    startCatIdle();
  });

  $ball.addEventListener('pointermove', (e) => {
    const pressState = ballPressState;
    if (!pressState || e.pointerId !== pressState.pointerId) return;

    pressState.latestScreenX = e.screenX;
    pressState.latestScreenY = e.screenY;
    if (!pressState.dragging) return;

    setCatDirection(e.screenX - pressState.lastScreenX);
    pressState.lastScreenX = e.screenX;
    queueBallDragPosition(pressState);
  });
}

function setupBallHover() {
  $ball.addEventListener('pointerenter', scheduleBallHoverAction);
  $ball.addEventListener('pointerleave', () => {
    cancelBallHoverAction({ resetTriggered: true, resumeIdle: true });
  });
}

function scheduleBallHoverAction() {
  clearBallHoverTimer();
  if (
    currentMode !== 'ball'
    || isBallDragging
    || ballPressState
    || dockedBallSide
    || ballHoverTriggered
  ) {
    return;
  }

  ballHoverTimer = setTimeout(() => {
    ballHoverTimer = null;
    if (
      currentMode !== 'ball'
      || isBallDragging
      || ballPressState
      || dockedBallSide
    ) {
      return;
    }

    ballHoverTriggered = true;
    ballHoverAnimationActive = true;
    playCatAnimation('hoverScratch').then((completed) => {
      ballHoverAnimationActive = false;
      ballHoverHoldActive = completed && ballHoverTriggered && currentMode === 'ball';
    });
  }, HOVER_ACTION_DELAY_MS);
}

function clearBallHoverTimer() {
  if (!ballHoverTimer) return;
  clearTimeout(ballHoverTimer);
  ballHoverTimer = null;
}

function cancelBallHoverAction({ resetTriggered = false, resumeIdle = false } = {}) {
  clearBallHoverTimer();
  if (resetTriggered) ballHoverTriggered = false;
  if (!ballHoverAnimationActive && !ballHoverHoldActive) return;

  ballHoverAnimationActive = false;
  ballHoverHoldActive = false;
  if (resumeIdle) {
    startCatIdle();
  } else {
    stopCatAnimation();
  }
}

async function beginBallDrag(pressState) {
  if (ballPressState !== pressState || pressState.dragging) return;

  const [startPosition, bounds] = await Promise.all([
    pressState.startPositionPromise,
    pressState.boundsPromise,
  ]);
  if (ballPressState !== pressState) return;

  pressState.startPosition = getUndockedBallPosition(startPosition, bounds, dockedBallSide);
  pressState.bounds = bounds;
  clearDockedBallSide();
  cancelBallHoverAction();
  pressState.dragging = true;
  isBallDragging = true;
  $ball.classList.add('is-dragging');
  pressState.moveCompletionPromise = appWindow.setPosition(
    new LogicalPosition(
      Math.round(pressState.startPosition.x),
      Math.round(pressState.startPosition.y),
    ),
  );
  await pressState.moveCompletionPromise;
  if (ballPressState !== pressState || !pressState.dragging) return;

  lastBallPosition = pressState.startPosition;
  playCatAnimation('run');
  queueBallDragPosition(pressState);
}

function getBallDragPosition(pressState) {
  return clampPosition(
    {
      x: pressState.startPosition.x + pressState.latestScreenX - pressState.startScreenX,
      y: pressState.startPosition.y + pressState.latestScreenY - pressState.startScreenY,
    },
    BALL_WINDOW,
    pressState.bounds,
  );
}

function queueBallDragPosition(pressState) {
  if (ballPressState !== pressState || !pressState.dragging) return;

  pressState.pendingPosition = getBallDragPosition(pressState);
  if (pressState.moveScheduled || pressState.moveInFlight) return;

  pressState.moveScheduled = true;
  requestAnimationFrame(() => flushBallDragPosition(pressState));
}

async function flushBallDragPosition(pressState) {
  pressState.moveScheduled = false;
  if (ballPressState !== pressState || !pressState.dragging || !pressState.pendingPosition) return;

  const position = pressState.pendingPosition;
  pressState.pendingPosition = null;
  pressState.moveInFlight = true;
  try {
    pressState.moveCompletionPromise = appWindow.setPosition(
      new LogicalPosition(Math.round(position.x), Math.round(position.y)),
    );
    await pressState.moveCompletionPromise;
    if (ballPressState === pressState && pressState.dragging) {
      lastBallPosition = position;
    }
  } catch (err) {
    console.error('悬浮球拖拽失败:', err);
  } finally {
    pressState.moveInFlight = false;
    if (pressState.pendingPosition) queueBallDragPosition(pressState);
  }
}

async function finishBallDrag(pressState, e) {
  pressState.latestScreenX = e.screenX;
  pressState.latestScreenY = e.screenY;
  const position = getBallDragPosition(pressState);
  const docked = getDockedBallPosition(position, pressState.bounds);
  const finalPosition = docked ? docked.position : position;
  pressState.dragging = false;
  pressState.pendingPosition = null;
  ballPressState = null;
  isBallDragging = false;
  $ball.releasePointerCapture?.(e.pointerId);
  setDockedBallSide(docked?.side || null);

  try {
    await pressState.moveCompletionPromise.catch(() => {});
    await appWindow.setPosition(
      new LogicalPosition(Math.round(finalPosition.x), Math.round(finalPosition.y)),
    );
    lastBallPosition = finalPosition;
  } catch (err) {
    console.error('悬浮球拖拽失败:', err);
  } finally {
    $ball.classList.remove('is-dragging');
    startCatIdle();
  }
}

function triggerBallPrimaryAction() {
  if (ballActionInProgress) return;

  playCatAnimation('click').then((completed) => {
    if (completed) handleBallPrimaryAction();
  });
}

const CAT_ANIMATIONS = {
  idle: { frames: createIdleCatFrames(), frameDuration: 300, loop: true },
  run: { frames: createCatFrames('run', 8), frameDuration: 90, loop: true },
  click: { frames: createCatFrames('click', 6), frameDuration: 105, loop: false },
  select: { frames: createCatFrames('select', 6), frameDuration: 115, loop: false },
  hoverScratch: {
    frames: createCatFrames('hover_scratch', 6),
    frameDuration: 170,
    loop: false,
    holdLastFrame: true,
  },
};

const DOCK_CAT_FRAMES = {
  left: '/cat/frames/dock_left.png',
  right: '/cat/frames/dock_right.png',
};

function createIdleCatFrames() {
  const idle = createCatFrames('idle', 8);
  const wave = createCatFrames('idle_wave', 7);
  return [
    idle[0], idle[1], idle[0], idle[2], idle[0], idle[3],
    idle[0], idle[4], idle[0], idle[5], idle[0], idle[6],
    idle[0], idle[7], idle[0], idle[1], idle[0], idle[3],
    idle[0], idle[0], idle[1], idle[0], idle[2], idle[0],
    ...wave,
    idle[0], idle[1], idle[0], idle[6], idle[0], idle[7],
  ];
}

function createCatFrames(name, count) {
  return Array.from(
    { length: count },
    (_, index) => `/cat/frames/${name}_${String(index + 1).padStart(2, '0')}.png`,
  );
}

function preloadCatFrames() {
  for (const animation of Object.values(CAT_ANIMATIONS)) {
    for (const src of animation.frames) {
      const image = new Image();
      image.src = src;
    }
  }
  for (const src of Object.values(DOCK_CAT_FRAMES)) {
    const image = new Image();
    image.src = src;
  }
}

function stopCatAnimation() {
  catAnimationToken += 1;
  if (catAnimationTimer) {
    clearTimeout(catAnimationTimer);
    catAnimationTimer = null;
  }
  if (catAnimationResolve) {
    const resolve = catAnimationResolve;
    catAnimationResolve = null;
    resolve(false);
  }
}

function playCatAnimation(name) {
  const animation = CAT_ANIMATIONS[name];
  if (!animation) return Promise.resolve(false);

  stopCatAnimation();
  const token = catAnimationToken;
  let frameIndex = 0;

  return new Promise((resolve) => {
    catAnimationResolve = resolve;

    const advance = () => {
      if (token !== catAnimationToken) return;

      $catSprite.src = animation.frames[frameIndex];
      frameIndex += 1;

      if (frameIndex >= animation.frames.length) {
        if (animation.loop) {
          frameIndex = 0;
        } else {
          catAnimationTimer = null;
          catAnimationResolve = null;
          resolve(true);
          if (!animation.holdLastFrame) startCatIdle();
          return;
        }
      }

      catAnimationTimer = setTimeout(advance, animation.frameDuration);
    };

    advance();
  });
}

function startCatIdle() {
  if (currentMode === 'ball' && !isBallDragging) {
    if (dockedBallSide) {
      stopCatAnimation();
      $catSprite.src = DOCK_CAT_FRAMES[dockedBallSide];
      return;
    }
    playCatAnimation('idle');
  }
}

function setCatDirection(deltaX) {
  if (Math.abs(deltaX) < 1) return;
  $ball.classList.toggle('facing-left', deltaX < 0);
}

// ========== 面板拖拽 ==========
function setupPanelDrag() {
  $header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.icon-btn')) return;
    e.preventDefault();
    appWindow.startDragging().catch(err => {
      console.error('面板拖拽失败:', err);
    });
  });
}

// ========== 原生窗口布局 ==========
function setBodyMode(mode) {
  document.body.classList.toggle('mode-ball', mode === 'ball');
  document.body.classList.toggle('mode-panel', mode === 'panel');
  document.body.classList.toggle('mode-overlay', mode === 'overlay');
}

async function getScaleFactor() {
  try {
    return await appWindow.scaleFactor();
  } catch {
    return window.devicePixelRatio || 1;
  }
}

async function getLogicalWindowPosition() {
  const scale = await getScaleFactor();
  const position = await appWindow.outerPosition();
  return {
    x: position.x / scale,
    y: position.y / scale,
  };
}

function toLogicalRect(rect, scale) {
  return {
    x: rect.position.x / scale,
    y: rect.position.y / scale,
    width: rect.size.width / scale,
    height: rect.size.height / scale,
  };
}

async function getBestMonitor() {
  return await currentMonitor() || await primaryMonitor() || (await availableMonitors())[0] || null;
}

async function getWorkAreaBounds() {
  const monitor = await getBestMonitor();
  if (!monitor) {
    return { x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight };
  }

  const scale = monitor.scaleFactor || await getScaleFactor();
  const area = monitor.workArea || { position: monitor.position, size: monitor.size };
  return toLogicalRect(area, scale);
}

function clampPosition(position, size, bounds) {
  const maxX = bounds.x + Math.max(0, bounds.width - size.width);
  const maxY = bounds.y + Math.max(0, bounds.height - size.height);
  return {
    x: Math.min(Math.max(position.x, bounds.x), maxX),
    y: Math.min(Math.max(position.y, bounds.y), maxY),
  };
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getPanelSide(anchorPosition, bounds) {
  const availableLeft = anchorPosition.x - bounds.x;
  const availableRight = bounds.x + bounds.width - (anchorPosition.x + BALL_WINDOW.width);

  if (availableRight >= PANEL_SIDE_OFFSET) return 'right';
  if (availableLeft >= PANEL_SIDE_OFFSET) return 'left';
  return availableRight >= availableLeft ? 'right' : 'left';
}

function getPanelLayout(anchorPosition, size, bounds) {
  const side = getPanelSide(anchorPosition, bounds);
  const position = {
    x: side === 'left' ? anchorPosition.x - PANEL_SIDE_OFFSET : anchorPosition.x,
    y: clampNumber(
      anchorPosition.y,
      bounds.y,
      bounds.y + Math.max(0, bounds.height - size.height),
    ),
  };
  const ballLeft = WINDOW_PAD + (side === 'left' ? PANEL_SIDE_OFFSET : 0);
  const ballTop = anchorPosition.y - position.y + WINDOW_PAD;
  const pointerTop = clampNumber(
    ballTop + BALL_SIZE / 2 - WINDOW_PAD - 14,
    24,
    Math.max(24, size.height - WINDOW_PAD * 2 - 52),
  );

  return {
    side,
    position,
    ballLeft,
    ballTop,
    panelLeft: side === 'left' ? WINDOW_PAD : PANEL_LEFT,
    pointerTop,
  };
}

function applyPanelLayout(layout) {
  panelLayout = layout;
  document.body.classList.toggle('panel-side-left', layout.side === 'left');
  document.documentElement.style.setProperty('--ball-left', `${layout.ballLeft}px`);
  document.documentElement.style.setProperty('--ball-top', `${layout.ballTop}px`);
  document.documentElement.style.setProperty('--panel-left', `${layout.panelLeft}px`);
  document.documentElement.style.setProperty('--panel-pointer-top', `${layout.pointerTop}px`);
}

function resetPanelLayout() {
  panelLayout = null;
  panelAnchorPosition = null;
  document.body.classList.remove('panel-side-left');
  document.documentElement.style.removeProperty('--ball-left');
  document.documentElement.style.removeProperty('--ball-top');
  document.documentElement.style.removeProperty('--panel-left');
  document.documentElement.style.removeProperty('--panel-pointer-top');
}

async function getCurrentPanelAnchorPosition() {
  if (currentMode !== 'panel' || !panelLayout) {
    return await getLogicalWindowPosition();
  }

  const position = await getLogicalWindowPosition();
  return {
    x: position.x + panelLayout.ballLeft - WINDOW_PAD,
    y: position.y + panelLayout.ballTop - WINDOW_PAD,
  };
}

async function setPanelWindowFrame(anchorPosition, size, bounds = null) {
  const workArea = bounds || await getWorkAreaBounds();
  panelAnchorPosition = anchorPosition;
  const layout = getPanelLayout(anchorPosition, size, workArea);
  applyPanelLayout(layout);
  await setWindowFrame(layout.position, size);
}

function getDockedBallPosition(position, bounds) {
  const maxX = bounds.x + Math.max(0, bounds.width - BALL_WINDOW.width);
  if (position.x <= bounds.x + DOCK_EDGE_THRESHOLD) {
    return {
      side: 'left',
      position: {
        x: bounds.x - BALL_WINDOW.width + DOCK_VISIBLE_WIDTH,
        y: position.y,
      },
    };
  }

  if (position.x >= maxX - DOCK_EDGE_THRESHOLD) {
    return {
      side: 'right',
      position: {
        x: bounds.x + bounds.width - DOCK_VISIBLE_WIDTH,
        y: position.y,
      },
    };
  }

  return null;
}

function getUndockedBallPosition(position, bounds, side) {
  if (!side) return position;

  const maxX = bounds.x + Math.max(0, bounds.width - BALL_WINDOW.width);
  return clampPosition(
    {
      x: side === 'left' ? bounds.x : maxX,
      y: position.y,
    },
    BALL_WINDOW,
    bounds,
  );
}

function setDockedBallSide(side) {
  dockedBallSide = side;
  if (side) $ball.classList.remove('facing-left');
  $ball.classList.toggle('docked-left', side === 'left');
  $ball.classList.toggle('docked-right', side === 'right');
}

function clearDockedBallSide() {
  setDockedBallSide(null);
}

async function setWindowFrame(position, size) {
  await appWindow.setPosition(new LogicalPosition(Math.round(position.x), Math.round(position.y)));
  await appWindow.setSize(new LogicalSize(Math.round(size.width), Math.round(size.height)));
}

async function enterBallMode({ preserveCurrentPosition = false } = {}) {
  if (preserveCurrentPosition || !lastBallPosition) {
    lastBallPosition = await getLogicalWindowPosition();
  }

  await appWindow.setFocusable(false);
  cancelBallHoverAction({ resetTriggered: true });
  currentMode = 'ball';
  resetPanelLayout();
  setBodyMode('ball');
  $panel.classList.remove('is-visible');
  $settingsPanel.style.display = 'none';
  $overlay.style.display = 'none';
  $ball.classList.remove('active');
  $modeIndicator.textContent = '就绪';
  $modeIndicator.classList.remove('active');

  const bounds = await getWorkAreaBounds();
  const position = clampPosition(lastBallPosition, BALL_WINDOW, bounds);
  lastBallPosition = position;
  await setWindowFrame(position, BALL_WINDOW);
  startCatIdle();
}

async function enterPanelMode(positionOverride = null) {
  if (currentMode === 'overlay') return;

  cancelBallHoverAction({ resetTriggered: true });
  stopCatAnimation();
  clearDockedBallSide();
  const currentPosition = positionOverride
    || (currentMode === 'panel'
      ? await getCurrentPanelAnchorPosition()
      : await getLogicalWindowPosition());
  lastBallPosition = currentPosition;

  await appWindow.setFocusable(true);
  currentMode = 'panel';
  setBodyMode('panel');
  $panel.classList.add('is-visible');
  $overlay.style.display = 'none';
  $ball.classList.remove('active');
  $modeIndicator.textContent = '就绪';
  $modeIndicator.classList.remove('active');

  const initialSize = { width: PANEL_WINDOW_WIDTH, height: PANEL_MIN_WINDOW_HEIGHT };
  const bounds = await getWorkAreaBounds();
  await setPanelWindowFrame(currentPosition, initialSize, bounds);
  await appWindow.setFocus();
  fitPanelWindow();
}

async function fitPanelWindow() {
  if (currentMode !== 'panel') return;

  await nextFrame();
  if (currentMode !== 'panel') return;

  const bounds = await getWorkAreaBounds();
  const maxHeight = Math.min(PANEL_MAX_WINDOW_HEIGHT, bounds.height);
  const panelHeight = Math.ceil(Math.min($panel.scrollHeight, maxHeight - WINDOW_PAD * 2));
  const height = Math.max(PANEL_MIN_WINDOW_HEIGHT, panelHeight + WINDOW_PAD * 2);
  const size = { width: PANEL_WINDOW_WIDTH, height };
  const anchorPosition = await getCurrentPanelAnchorPosition();

  await setPanelWindowFrame(anchorPosition, size, bounds);
}

function showPanel() {
  enterPanelMode();
}

async function hidePanel() {
  if (currentMode === 'overlay') {
    await cancelSelectionMode();
    return;
  }

  if (currentMode === 'panel') {
    lastBallPosition = await getCurrentPanelAnchorPosition();
  }

  await enterBallMode();
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// ========== 悬浮球动作 ==========
async function handleBallPrimaryAction() {
  if (ballActionInProgress) return;
  ballActionInProgress = true;

  const clipboardMarker = `__ASK_FAST__${Date.now()}__${Math.random().toString(36).slice(2)}__`;
  let clipboardSaved = false;
  let text = '';
  let operationError = null;
  let restoreError = null;

  try {
    await rememberTargetWindow(true);
    await invoke('save_clipboard');
    clipboardSaved = true;
    await invoke('set_clipboard_text', { text: clipboardMarker });
    await invoke('copy_selected_text');
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
      text = await invoke('get_clipboard_text');
    } catch (e) {
      text = '';
    }
  } catch (e) {
    operationError = e;
  } finally {
    if (clipboardSaved) {
      try {
        await invoke('restore_clipboard');
      } catch (e) {
        restoreError = e;
      }
    }
    ballActionInProgress = false;
  }

  if (restoreError) {
    showPanel();
    showError('恢复剪贴板失败，请重试: ' + restoreError);
  } else if (operationError) {
    showPanel();
    showError('操作失败: ' + operationError);
  } else if (text && text !== clipboardMarker && text.trim()) {
    explainText(text.trim());
  } else {
    showPanel();
    showError('未选中文字。请先在其他窗口选中文字，再点击悬浮球。');
  }
}

// ========== 模式切换 / 框选 OCR ==========
function setupTargetWindowTracking() {
  const trackTargetWindow = () => {
    rememberTargetWindow(false);
  };

  $ball.addEventListener('pointerenter', () => rememberTargetWindow(true));
  $ball.addEventListener('pointermove', trackTargetWindow);

  window.setInterval(() => {
    if (currentMode === 'ball') {
      rememberTargetWindow(false);
    }
  }, 800);
}

async function rememberTargetWindow(force) {
  if (currentMode !== 'ball') return;

  const now = Date.now();
  if (!force && now - lastRememberTargetAt < 150) return;
  lastRememberTargetAt = now;

  try {
    await invoke('remember_target_window');
  } catch (e) {
    console.debug('remember_target_window failed:', e);
  }
}

function toggleSelectMode() {
  if (currentMode === 'overlay') {
    cancelSelectionMode();
  } else {
    startSelectionMode();
  }
}

async function startSelectionMode() {
  if (currentMode === 'overlay') return;

  if (!$ocrConsent.checked) {
    showPanel();
    showError('使用框选 OCR 前，请在设置中确认允许将截图发送到 OCR.Space。');
    return;
  }

  if (!$ocrApiKey.value.trim()) {
    showPanel();
    showError('使用框选 OCR 前，请先在设置中配置 OCR.Space API Key。');
    return;
  }

  const previousMode = currentMode;
  const previousPosition = currentMode === 'panel'
    ? await getCurrentPanelAnchorPosition()
    : await getLogicalWindowPosition();
  const monitor = await getBestMonitor();
  if (!monitor) {
    showPanel();
    showError('未找到显示器，无法进入框选模式。');
    return;
  }

  const scale = monitor.scaleFactor || await getScaleFactor();
  const monitorBounds = toLogicalRect({ position: monitor.position, size: monitor.size }, scale);

  overlayState = {
    previousMode,
    previousPosition,
    scale,
    physicalOrigin: {
      x: monitor.position.x,
      y: monitor.position.y,
    },
  };

  stopCatAnimation();
  currentMode = 'overlay';
  await appWindow.setFocusable(true);
  setBodyMode('overlay');
  $panel.classList.remove('is-visible');
  $settingsPanel.style.display = 'none';
  $overlay.style.display = 'block';
  $selectionBox.style.display = 'none';
  $ball.classList.add('active');
  $modeIndicator.textContent = '框选模式';
  $modeIndicator.classList.add('active');

  await setWindowFrame(
    { x: monitorBounds.x, y: monitorBounds.y },
    { width: monitorBounds.width, height: monitorBounds.height },
  );
}

function setupSelectionOverlay() {
  $overlay.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelSelectionMode();
  });

  $overlay.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.button !== 0) return;

    selectionState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
    };

    $selectionBox.style.left = e.clientX + 'px';
    $selectionBox.style.top = e.clientY + 'px';
    $selectionBox.style.width = '0px';
    $selectionBox.style.height = '0px';
    $selectionBox.style.display = 'block';
    $overlay.setPointerCapture?.(e.pointerId);
  });

  $overlay.addEventListener('pointermove', (e) => {
    if (!selectionState || e.pointerId !== selectionState.pointerId) return;
    drawSelectionBox(e.clientX, e.clientY);
  });

  $overlay.addEventListener('pointerup', async (e) => {
    if (!selectionState || e.pointerId !== selectionState.pointerId) return;
    const rect = getSelectionRect(e.clientX, e.clientY);
    selectionState = null;

    if (rect.w < 10 || rect.h < 10) {
      await cancelSelectionMode();
      return;
    }

    const screenRect = toPhysicalScreenRect(rect);
    const previousPosition = overlayState?.previousPosition || null;
    await leaveSelectionMode({ restorePrevious: false });
    await ocrRegion(screenRect, previousPosition);
  });

  $overlay.addEventListener('pointercancel', () => {
    cancelSelectionMode();
  });
}

function drawSelectionBox(clientX, clientY) {
  const x = Math.min(clientX, selectionState.startX);
  const y = Math.min(clientY, selectionState.startY);
  const w = Math.abs(clientX - selectionState.startX);
  const h = Math.abs(clientY - selectionState.startY);

  $selectionBox.style.left = x + 'px';
  $selectionBox.style.top = y + 'px';
  $selectionBox.style.width = w + 'px';
  $selectionBox.style.height = h + 'px';
}

function getSelectionRect(clientX, clientY) {
  return {
    x: Math.min(clientX, selectionState.startX),
    y: Math.min(clientY, selectionState.startY),
    w: Math.abs(clientX - selectionState.startX),
    h: Math.abs(clientY - selectionState.startY),
  };
}

function toPhysicalScreenRect(rect) {
  const scale = overlayState?.scale || 1;
  const origin = overlayState?.physicalOrigin || { x: 0, y: 0 };
  return {
    x: Math.round(origin.x + rect.x * scale),
    y: Math.round(origin.y + rect.y * scale),
    w: Math.round(rect.w * scale),
    h: Math.round(rect.h * scale),
  };
}

async function cancelSelectionMode() {
  await leaveSelectionMode({ restorePrevious: true });
}

async function leaveSelectionMode({ restorePrevious }) {
  const state = overlayState;
  selectionState = null;
  $overlay.style.display = 'none';
  $selectionBox.style.display = 'none';
  $ball.classList.remove('active');
  $modeIndicator.textContent = '就绪';
  $modeIndicator.classList.remove('active');

  if (!restorePrevious) {
    currentMode = 'ball';
    setBodyMode('ball');
    return;
  }

  overlayState = null;
  if (state?.previousMode === 'panel') {
    await enterPanelMode(state.previousPosition);
  } else {
    lastBallPosition = state?.previousPosition || lastBallPosition;
    await enterBallMode();
  }
}

async function ocrRegion(rect, panelPosition) {
  const requestId = ++latestRequestId;

  try {
    const imageDataUrl = await captureRegionWithoutApp(rect, panelPosition);

    if (requestId !== latestRequestId) return;
    showLoading('正在识别文字...');

    const ocrText = await invoke('ocr_image', {
      imageDataUrl,
      apiKey: $ocrApiKey.value.trim() || null,
    });

    if (requestId !== latestRequestId) return;
    if (!ocrText || ocrText.trim().length === 0) {
      showError('未识别到任何文字。');
      return;
    }

    const text = truncateText(ocrText);
    lastText = text;
    showLoading('正在解释...');

    const answer = await invoke('explain_text', {
      text,
      systemPrompt: getSystemPrompt(),
      apiKey: $apiKey.value.trim() || null,
    });

    if (requestId !== latestRequestId) return;
    lastAnswer = answer;
    showResult(answer);
  } catch (e) {
    if (requestId !== latestRequestId) return;
    showError(e.toString());
  } finally {
    overlayState = null;
  }
}

async function captureRegionWithoutApp(rect, panelPosition) {
  await appWindow.hide();
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    return await invoke('capture_screen_region', {
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
  } finally {
    await appWindow.show();
    await enterPanelMode(panelPosition);
  }
}

// ========== 文字解释 ==========
async function explainText(text) {
  if (!text || text.trim().length === 0) return;
  text = truncateText(text);
  lastText = text;

  const requestId = ++latestRequestId;
  showPanel();
  showLoading('正在解释...');

  try {
    const answer = await invoke('explain_text', {
      text,
      systemPrompt: getSystemPrompt(),
      apiKey: $apiKey.value.trim() || null,
    });

    if (requestId !== latestRequestId) return;
    lastAnswer = answer;
    showResult(answer);
  } catch (e) {
    if (requestId !== latestRequestId) return;
    showError(e.toString());
  }
}

function truncateText(text) {
  return Array.from(text.trim()).slice(0, 8000).join('');
}

// ========== UI 状态 ==========
function showLoading(text) {
  $placeholder.style.display = 'none';
  $result.style.display = 'none';
  $error.style.display = 'none';
  $loading.style.display = 'flex';
  $loadingText.textContent = text;
  $btnCopy.disabled = true;
  $btnRetry.disabled = true;
  fitPanelWindow();
}

function showResult(html) {
  $loading.style.display = 'none';
  $error.style.display = 'none';
  $placeholder.style.display = 'none';
  $result.style.display = 'block';
  $result.innerHTML = renderMarkdown(html);
  $btnCopy.disabled = false;
  $btnRetry.disabled = false;
  fitPanelWindow();
}

function showError(msg) {
  showPanel();
  $loading.style.display = 'none';
  $result.style.display = 'none';
  $placeholder.style.display = 'none';
  $error.style.display = 'block';
  $error.textContent = msg;
  $btnRetry.disabled = false;
  fitPanelWindow();
}

// ========== 启动 ==========
init();
