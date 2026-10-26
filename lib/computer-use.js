var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// vendor/computer-use/windows-native-B7Ig34Q0.js
var windows_native_B7Ig34Q0_exports = {};
__export(windows_native_B7Ig34Q0_exports, {
  createProductionWindowsOps: () => createProductionWindowsOps
});
import { execFileSync } from "node:child_process";
import koffi from "koffi";
function flipRows(pixels, rowBytes, height) {
  if (rowBytes <= 0 || height <= 1) return;
  const scratch = Buffer.alloc(rowBytes);
  for (let top = 0, bottom = height - 1; top < bottom; top += 1, bottom -= 1) {
    const topAt = top * rowBytes;
    const bottomAt = bottom * rowBytes;
    pixels.copy(scratch, 0, topAt, topAt + rowBytes);
    pixels.copy(pixels, topAt, bottomAt, bottomAt + rowBytes);
    scratch.copy(pixels, bottomAt, 0, rowBytes);
  }
}
function cursorDrawPlacement(pointer, hotspot, size, bounds, margin = 12) {
  if (size.width <= 0 || size.height <= 0) return void 0;
  if (![
    pointer.x,
    pointer.y,
    hotspot.x,
    hotspot.y,
    margin,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height
  ].every(Number.isFinite)) return void 0;
  if (pointer.x < bounds.x - margin || pointer.x > bounds.x + bounds.width + margin) return void 0;
  if (pointer.y < bounds.y - margin || pointer.y > bounds.y + bounds.height + margin) return void 0;
  return {
    x: Math.round(pointer.x - bounds.x - hotspot.x),
    y: Math.round(pointer.y - bounds.y - hotspot.y)
  };
}
function resolveCursorAlpha(cursor) {
  const { width, height, color, mask } = cursor;
  const pixels = width * height;
  if (pixels <= 0) return Buffer.alloc(0);
  let hasAlpha = false;
  for (let index = 3; index < pixels * 4; index += 4) if ((color[index] ?? 0) !== 0) {
    hasAlpha = true;
    break;
  }
  if (hasAlpha || mask === void 0) return color;
  const out = Buffer.alloc(pixels * 4);
  for (let at = 0; at < pixels * 4; at += 4) {
    if ((mask[at] ?? 0) !== 0) continue;
    out[at] = color[at] ?? 0;
    out[at + 1] = color[at + 1] ?? 0;
    out[at + 2] = color[at + 2] ?? 0;
    out[at + 3] = 255;
  }
  return out;
}
function compositeCursor(target, targetWidth, targetHeight, cursor, cursorWidth, cursorHeight, at) {
  if (targetWidth <= 0 || targetHeight <= 0 || cursorWidth <= 0 || cursorHeight <= 0) return;
  for (let row = 0; row < cursorHeight; row += 1) {
    const y = at.y + row;
    if (y < 0 || y >= targetHeight) continue;
    for (let column = 0; column < cursorWidth; column += 1) {
      const x = at.x + column;
      if (x < 0 || x >= targetWidth) continue;
      const source = (row * cursorWidth + column) * 4;
      const alpha = cursor[source + 3] ?? 0;
      if (alpha === 0) continue;
      const destination = (y * targetWidth + x) * 4;
      if (alpha === 255) {
        target[destination] = cursor[source] ?? 0;
        target[destination + 1] = cursor[source + 1] ?? 0;
        target[destination + 2] = cursor[source + 2] ?? 0;
        target[destination + 3] = 255;
        continue;
      }
      const opacity = alpha / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        const under = target[destination + channel] ?? 0;
        const over = cursor[source + channel] ?? 0;
        target[destination + channel] = Math.round(under * (1 - opacity) + over * opacity);
      }
      target[destination + 3] = 255;
    }
  }
}
function isNull(value) {
  return value === null || value === void 0 || value === 0 || value === 0n;
}
function dpiContext(value) {
  if (typeof value === "bigint") return value === 0n ? void 0 : value;
  if (typeof value === "number" && value !== 0) return value;
}
function hwndId(value) {
  const id = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isSafeInteger(id) || id === 0) return void 0;
  return id;
}
function low32(value) {
  if (typeof value === "bigint") return Number(BigInt.asIntN(32, value));
  if (typeof value === "number" && Number.isFinite(value)) return value | 0;
  return 0;
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function bind(libraries) {
  const { user32, gdi32, kernel32, shell32, advapi32, dwmapi } = libraries;
  const enumProc = koffi.proto("int __stdcall DshCuEnumWindowsProc(void *hwnd, intptr lParam)");
  const childProc = koffi.proto("int __stdcall DshCuEnumChildProc(void *hwnd, intptr lParam)");
  let setThreadDpi;
  try {
    setThreadDpi = user32.func("intptr __stdcall SetThreadDpiAwarenessContext(intptr dpiContext)");
  } catch {
    setThreadDpi = void 0;
  }
  let getDpiForMonitor;
  try {
    getDpiForMonitor = koffi.load("shcore.dll").func("int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)");
  } catch {
    getDpiForMonitor = void 0;
  }
  return {
    GetForegroundWindow: user32.func("void * __stdcall GetForegroundWindow()"),
    GetWindowRect: user32.func("int __stdcall GetWindowRect(void *hWnd, _Out_ DSH_CU_RECT *lpRect)"),
    GetWindowTextLengthW: user32.func("int __stdcall GetWindowTextLengthW(void *hWnd)"),
    GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)"),
    GetWindowThreadProcessId: user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)"),
    IsWindowVisible: user32.func("int __stdcall IsWindowVisible(void *hWnd)"),
    IsIconic: user32.func("int __stdcall IsIconic(void *hWnd)"),
    EnumWindows: user32.func("int __stdcall EnumWindows(DshCuEnumWindowsProc *lpEnumFunc, intptr lParam)"),
    EnumChildWindows: user32.func("int __stdcall EnumChildWindows(void *hWndParent, DshCuEnumChildProc *lpEnumFunc, intptr lParam)"),
    GetClassNameW: user32.func("int __stdcall GetClassNameW(void *hWnd, uint16_t *lpClassName, int nMaxCount)"),
    GetWindow: user32.func("void * __stdcall GetWindow(void *hWnd, uint32 uCmd)"),
    GetWindowLongPtrW: user32.func("intptr __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)"),
    ShowWindow: user32.func("int __stdcall ShowWindow(void *hWnd, int nCmdShow)"),
    SetForegroundWindow: user32.func("int __stdcall SetForegroundWindow(void *hWnd)"),
    MonitorFromWindow: user32.func("void * __stdcall MonitorFromWindow(void *hwnd, uint32 dwFlags)"),
    GetMonitorInfoW: user32.func("int __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ uint8_t *lpmi)"),
    GetSystemMetrics: user32.func("int __stdcall GetSystemMetrics(int nIndex)"),
    GetCursorPos: user32.func("int __stdcall GetCursorPos(_Out_ DSH_CU_POINT *lpPoint)"),
    SetCursorPos: user32.func("int __stdcall SetCursorPos(int X, int Y)"),
    GetCursorInfo: user32.func("int __stdcall GetCursorInfo(_Inout_ uint8_t *pci)"),
    GetIconInfo: user32.func("int __stdcall GetIconInfo(void *hIcon, _Out_ uint8_t *piconinfo)"),
    SetThreadDpiAwarenessContext: setThreadDpi,
    GetDpiForMonitor: getDpiForMonitor,
    GetDC: user32.func("void * __stdcall GetDC(void *hWnd)"),
    ReleaseDC: user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)"),
    CreateCompatibleDC: gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)"),
    CreateCompatibleBitmap: gdi32.func("void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)"),
    SelectObject: gdi32.func("void * __stdcall SelectObject(void *hdc, void *h)"),
    BitBlt: gdi32.func("int __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)"),
    GetDIBits: gdi32.func("int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, _Out_ uint8_t *lpvBits, _Inout_ DSH_CU_BITMAPINFOHEADER *lpbmi, uint32 usage)"),
    DeleteObject: gdi32.func("int __stdcall DeleteObject(void *ho)"),
    DeleteDC: gdi32.func("int __stdcall DeleteDC(void *hdc)"),
    GetObjectW: gdi32.func("int __stdcall GetObjectW(void *h, int c, _Out_ uint8_t *pv)"),
    SendInput: user32.func("uint32 __stdcall SendInput(uint32 cInputs, DSH_CU_INPUT *pInputs, int cbSize)"),
    OpenClipboard: user32.func("int __stdcall OpenClipboard(void *hWndNewOwner)"),
    EmptyClipboard: user32.func("int __stdcall EmptyClipboard()"),
    SetClipboardData: user32.func("void * __stdcall SetClipboardData(uint32 uFormat, void *hMem)"),
    CloseClipboard: user32.func("int __stdcall CloseClipboard()"),
    GetClipboardData: user32.func("void * __stdcall GetClipboardData(uint32 uFormat)"),
    GlobalAlloc: kernel32.func("void * __stdcall GlobalAlloc(uint32 uFlags, uintptr dwBytes)"),
    GlobalLock: kernel32.func("void * __stdcall GlobalLock(void *hMem)"),
    GlobalUnlock: kernel32.func("int __stdcall GlobalUnlock(void *hMem)"),
    GlobalSize: kernel32.func("uintptr __stdcall GlobalSize(void *hMem)"),
    RtlMoveMemory: kernel32.func("void __stdcall RtlMoveMemory(void *Destination, void *Source, uintptr Length)"),
    OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)"),
    CloseHandle: kernel32.func("int __stdcall CloseHandle(void *hObject)"),
    QueryFullProcessImageNameW: kernel32.func("int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)"),
    OpenProcessToken: advapi32.func("int __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)"),
    GetTokenInformation: advapi32.func("int __stdcall GetTokenInformation(void *TokenHandle, int TokenInformationClass, _Out_ uint8_t *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)"),
    GetSidSubAuthorityCount: advapi32.func("uint8_t * __stdcall GetSidSubAuthorityCount(void *pSid)"),
    GetSidSubAuthority: advapi32.func("uint32 * __stdcall GetSidSubAuthority(void *pSid, uint32 nSubAuthority)"),
    ShellExecuteW: shell32.func("intptr __stdcall ShellExecuteW(void *hwnd, str16 lpOperation, str16 lpFile, str16 lpParameters, str16 lpDirectory, int nShowCmd)"),
    DwmGetWindowAttribute: dwmapi.func("int __stdcall DwmGetWindowAttribute(void *hwnd, uint32 dwAttribute, _Out_ uint8_t *pvAttribute, uint32 cbAttribute)"),
    enumProc,
    childProc
  };
}
function windowText(api, hwnd) {
  const length = api.GetWindowTextLengthW(hwnd);
  if (length <= 0) return "";
  const buffer = Buffer.alloc((length + 1) * 2);
  api.GetWindowTextW(hwnd, buffer, length + 1);
  return buffer.toString("utf16le", 0, length * 2);
}
function classNameOf(api, hwnd) {
  const buffer = Buffer.alloc(512);
  const length = api.GetClassNameW(hwnd, buffer, 256);
  if (length <= 0) return "";
  return buffer.toString("utf16le", 0, length * 2);
}
function pidOf(api, hwnd) {
  const pid = [0];
  api.GetWindowThreadProcessId(hwnd, pid);
  return pid[0] ?? 0;
}
function processBaseName(api, pid) {
  if (pid === 0) return void 0;
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (isNull(handle)) return void 0;
  try {
    const chars = Buffer.alloc(2048);
    const size = [1024];
    if (api.QueryFullProcessImageNameW(handle, 0, chars, size) === 0) return void 0;
    const count = size[0] ?? 0;
    const full = chars.toString("utf16le", 0, count * 2);
    return (full.split(/[\\/]/u).at(-1) ?? full).replace(/\.exe$/iu, "");
  } finally {
    api.CloseHandle(handle);
  }
}
function integrityRid(api, pid) {
  try {
    return integrityRidUnchecked(api, pid);
  } catch {
    return;
  }
}
function integrityRidUnchecked(api, pid) {
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (isNull(handle)) return void 0;
  const token = [null];
  try {
    if (api.OpenProcessToken(handle, TOKEN_QUERY, token) === 0) return void 0;
    const tokenHandle = token[0];
    try {
      const needed = [0];
      api.GetTokenInformation(tokenHandle, TokenIntegrityLevel, null, 0, needed);
      const size = needed[0] ?? 0;
      if (size < 8) return void 0;
      const info = Buffer.alloc(size);
      if (api.GetTokenInformation(tokenHandle, TokenIntegrityLevel, info, size, needed) === 0) return void 0;
      const sid = info.readBigUInt64LE(0);
      const countPtr = api.GetSidSubAuthorityCount(sid);
      const count = koffi.decode(countPtr, "uint8");
      if (count < 1) return void 0;
      const ridPtr = api.GetSidSubAuthority(sid, count - 1);
      return koffi.decode(ridPtr, "uint32");
    } finally {
      api.CloseHandle(tokenHandle);
    }
  } finally {
    api.CloseHandle(handle);
  }
}
function explorerFolder(hwnd) {
  const script = `
$shell = New-Object -ComObject Shell.Application
foreach ($window in @($shell.Windows())) {
  if ([int64]$window.HWND -eq ${String(hwnd)}) {
    $window.Document.Folder.Self.Path
    break
  }
}
`;
  try {
    const path = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      script
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2e3
    }).trim();
    return path === "" ? void 0 : path;
  } catch {
    return;
  }
}
function sendMouse(api, flags, x, y, data = 0) {
  const absolute = (flags & MOUSEEVENTF_ABSOLUTE) !== 0;
  const left = api.GetSystemMetrics(SM_XVIRTUALSCREEN);
  const top = api.GetSystemMetrics(SM_YVIRTUALSCREEN);
  const width = Math.max(1, api.GetSystemMetrics(SM_CXVIRTUALSCREEN));
  const height = Math.max(1, api.GetSystemMetrics(SM_CYVIRTUALSCREEN));
  const input = {
    type: INPUT_MOUSE,
    u: { mi: {
      dx: absolute ? Math.round((x - left) * 65535 / Math.max(1, width - 1)) : x,
      dy: absolute ? Math.round((y - top) * 65535 / Math.max(1, height - 1)) : y,
      mouseData: data >>> 0,
      dwFlags: flags,
      time: 0,
      dwExtraInfo: 0
    } }
  };
  if (api.SendInput(1, [input], INPUT.size) !== 1) throw new Error("computer-use: pointer input failed");
}
function postKey(api, virtualKey, down, extended) {
  const input = {
    type: INPUT_KEYBOARD,
    u: { ki: {
      wVk: virtualKey,
      wScan: 0,
      dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0),
      time: 0,
      dwExtraInfo: 0
    } }
  };
  if (api.SendInput(1, [input], INPUT.size) !== 1) throw new Error("computer-use: keyboard input failed");
}
function withClipboard(api, write) {
  if (api.OpenClipboard(null) === 0) throw new Error("computer-use: OpenClipboard failed");
  try {
    write();
  } finally {
    api.CloseClipboard();
  }
}
function enumTopLevel(api) {
  const hwnds = [];
  const callback = koffi.register((hwnd) => {
    hwnds.push(hwnd);
    return 1;
  }, koffi.pointer(api.enumProc));
  try {
    api.EnumWindows(callback, 0);
  } finally {
    koffi.unregister(callback);
  }
  return hwnds;
}
function coreWindowPid(api, hwnd) {
  let found = 0;
  const callback = koffi.register((child) => {
    if (classNameOf(api, child) !== "Windows.UI.Core.CoreWindow") return 1;
    found = pidOf(api, child);
    return 0;
  }, koffi.pointer(api.childProc));
  try {
    api.EnumChildWindows(hwnd, callback, 0);
  } finally {
    koffi.unregister(callback);
  }
  return found === 0 ? void 0 : found;
}
function frameOf(api, hwnd) {
  const extended = Buffer.alloc(16);
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, extended, 16) === 0) {
    const left = extended.readInt32LE(0);
    const top = extended.readInt32LE(4);
    const right = extended.readInt32LE(8);
    const bottom = extended.readInt32LE(12);
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }
  const rect = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0
  };
  if (api.GetWindowRect(hwnd, rect) === 0) return void 0;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
}
function cloaked(api, hwnd) {
  const flag = Buffer.alloc(4);
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, flag, 4) !== 0) return false;
  return flag.readUInt32LE(0) !== 0;
}
function bitmapSize(api, bitmap) {
  const info = Buffer.alloc(BITMAP.size);
  if (api.GetObjectW(bitmap, BITMAP.size, info) === 0) return void 0;
  const decoded = koffi.decode(info, BITMAP);
  if (decoded.bmWidth <= 0 || decoded.bmHeight <= 0) return void 0;
  return {
    width: decoded.bmWidth,
    height: decoded.bmHeight
  };
}
function bitmapPixels(api, dc, bitmap, size) {
  const rowBytes = size.width * 4;
  const pixels = Buffer.alloc(rowBytes * size.height);
  const header = {
    biSize: 40,
    biWidth: size.width,
    biHeight: size.height,
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0,
    biSizeImage: pixels.length,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0
  };
  if (api.GetDIBits(dc, bitmap, 0, size.height, pixels, header, 0) === 0) return void 0;
  flipRows(pixels, rowBytes, size.height);
  return pixels;
}
function readCursor(api) {
  const info = Buffer.alloc(CURSORINFO.size);
  info.writeUInt32LE(CURSORINFO.size, 0);
  if (api.GetCursorInfo(info) === 0) return void 0;
  const cursor = koffi.decode(info, CURSORINFO);
  if ((cursor.flags & CURSOR_SHOWING) === 0 || isNull(cursor.hCursor)) return void 0;
  const icon = Buffer.alloc(ICONINFO.size);
  if (api.GetIconInfo(cursor.hCursor, icon) === 0) return void 0;
  const decoded = koffi.decode(icon, ICONINFO);
  return {
    pointer: {
      x: cursor.ptScreenPos.x,
      y: cursor.ptScreenPos.y
    },
    hotspot: {
      x: decoded.xHotspot,
      y: decoded.yHotspot
    },
    color: decoded.hbmColor,
    mask: decoded.hbmMask
  };
}
function drawCursor(api, dc, pixels, width, height, bounds) {
  const cursor = readCursor(api);
  if (cursor === void 0) return;
  try {
    const size = bitmapSize(api, cursor.color);
    if (size === void 0) return;
    const placement = cursorDrawPlacement(cursor.pointer, cursor.hotspot, size, bounds);
    if (placement === void 0) return;
    const color = bitmapPixels(api, dc, cursor.color, size);
    if (color === void 0) return;
    const mask = isNull(cursor.mask) ? void 0 : bitmapPixels(api, dc, cursor.mask, size);
    compositeCursor(pixels, width, height, resolveCursorAlpha({
      width: size.width,
      height: size.height,
      color,
      ...mask === void 0 ? {} : { mask }
    }), size.width, size.height, placement);
  } finally {
    if (!isNull(cursor.color)) api.DeleteObject(cursor.color);
    if (!isNull(cursor.mask)) api.DeleteObject(cursor.mask);
  }
}
function monitorOf(api, hwnd, fallback) {
  const handle = api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (isNull(handle)) return {
    monitor: fallback,
    dpi: 96
  };
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  if (api.GetMonitorInfoW(handle, info) === 0) return {
    monitor: fallback,
    dpi: 96
  };
  const left = info.readInt32LE(4);
  const top = info.readInt32LE(8);
  const right = info.readInt32LE(12);
  const bottom = info.readInt32LE(16);
  const monitor = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
  const readDpi = api.GetDpiForMonitor;
  if (readDpi === void 0) return {
    monitor,
    dpi: 96
  };
  const dpiX = [0];
  if (readDpi(handle, MDT_EFFECTIVE_DPI, dpiX, [0]) !== 0) return {
    monitor,
    dpi: 96
  };
  const dpi = dpiX[0] ?? 0;
  return {
    monitor,
    dpi: dpi > 0 ? dpi : 96
  };
}
function stylesOf(api, hwnd) {
  const style = low32(api.GetWindowLongPtrW(hwnd, GWL_STYLE));
  const extended = low32(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  return {
    popup: (style & WS_POPUP) !== 0,
    toolWindow: (extended & WS_EX_TOOLWINDOW) !== 0
  };
}
function cachedAppName(api, cache2, pid) {
  const cached = cache2.get(pid);
  if (cached !== void 0) return cached;
  const name2 = processBaseName(api, pid) ?? "unknown";
  cache2.set(pid, name2);
  return name2;
}
function createProductionWindowsOps() {
  if (process.arch === "x64" && INPUT.size !== 40) throw new Error(`computer-use: INPUT size ${String(INPUT.size)} is not 40`);
  if (process.arch === "x64" && (CURSORINFO.size !== 24 || ICONINFO.size !== 32 || BITMAP.size !== 32)) throw new Error("computer-use: cursor structs are not laid out for x64");
  const api = bind({
    user32: koffi.load("user32.dll"),
    gdi32: koffi.load("gdi32.dll"),
    kernel32: koffi.load("kernel32.dll"),
    shell32: koffi.load("shell32.dll"),
    advapi32: koffi.load("advapi32.dll"),
    dwmapi: koffi.load("dwmapi.dll")
  });
  const selfRid = integrityRid(api, process.pid);
  function perMonitor(fn) {
    const set = api.SetThreadDpiAwarenessContext;
    if (set === void 0) return fn();
    const restore = dpiContext(set(DPI_PER_MONITOR_V2)) ?? dpiContext(set(DPI_PER_MONITOR));
    if (restore === void 0) return fn();
    try {
      return fn();
    } finally {
      set(restore);
    }
  }
  function placePointer(x, y) {
    sendMouse(api, 49153, x, y);
    const pos = {
      x: 0,
      y: 0
    };
    if (api.GetCursorPos(pos) === 0 || pos.x !== x || pos.y !== y) {
      if (api.SetCursorPos(x, y) === 0) throw new Error("computer-use: pointer input failed");
    }
  }
  function listWindows() {
    return perMonitor(() => {
      const names = /* @__PURE__ */ new Map();
      const windows = [];
      for (const hwnd of enumTopLevel(api)) {
        const id = hwndId(hwnd);
        if (id === void 0) continue;
        const frame = frameOf(api, hwnd);
        if (frame === void 0) continue;
        const className = classNameOf(api, hwnd);
        const pid = pidOf(api, hwnd);
        const appPid = className === "ApplicationFrameWindow" ? coreWindowPid(api, hwnd) ?? pid : pid;
        const styles = stylesOf(api, hwnd);
        const display = monitorOf(api, hwnd, frame);
        windows.push({
          hwnd: id,
          pid: appPid,
          ownerHwnd: hwndId(api.GetWindow(hwnd, GW_OWNER)) ?? 0,
          className,
          appName: cachedAppName(api, names, appPid),
          title: windowText(api, hwnd),
          visible: api.IsWindowVisible(hwnd) !== 0,
          iconic: api.IsIconic(hwnd) !== 0,
          cloaked: cloaked(api, hwnd),
          toolWindow: styles.toolWindow,
          popup: styles.popup,
          frame,
          monitor: display.monitor,
          monitorDpi: display.dpi
        });
      }
      return {
        foregroundHwnd: hwndId(api.GetForegroundWindow()) ?? 0,
        windows
      };
    });
  }
  function isForeground(hwnd) {
    return hwndId(api.GetForegroundWindow()) === hwndId(hwnd);
  }
  function windowPointer(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return void 0;
    for (const hwnd of enumTopLevel(api)) if (hwndId(hwnd) === id) return hwnd;
  }
  function becomeForeground(target) {
    if (api.IsIconic(target) !== 0) api.ShowWindow(target, SW_RESTORE);
    postKey(api, VK_MENU, true, false);
    try {
      api.SetForegroundWindow(target);
      if (!isForeground(target)) {
        sleepSync(FOREGROUND_RETRY_MS);
        if (!isForeground(target)) return false;
      }
      return true;
    } finally {
      postKey(api, VK_MENU, false, false);
    }
  }
  return {
    listWindows,
    capturePng(bounds) {
      return perMonitor(() => {
        const width = Math.max(1, Math.round(bounds.width));
        const height = Math.max(1, Math.round(bounds.height));
        const originX = Math.round(bounds.x);
        const originY = Math.round(bounds.y);
        const region = {
          x: originX,
          y: originY,
          width,
          height
        };
        const screenDc = api.GetDC(null);
        if (isNull(screenDc)) throw new Error("computer-use: screen capture failed");
        const memory = api.CreateCompatibleDC(screenDc);
        const bitmap = api.CreateCompatibleBitmap(screenDc, width, height);
        const previous = api.SelectObject(memory, bitmap);
        try {
          if (api.BitBlt(memory, 0, 0, width, height, screenDc, originX, originY, SRCCOPY) === 0) throw new Error("computer-use: screen capture failed");
          const header = {
            biSize: 40,
            biWidth: width,
            biHeight: height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: width * height * 4,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0
          };
          const pixels = Buffer.alloc(width * height * 4);
          if (api.GetDIBits(memory, bitmap, 0, height, pixels, header, 0) === 0) throw new Error("computer-use: screen capture failed");
          flipRows(pixels, width * 4, height);
          drawCursor(api, memory, pixels, width, height, region);
          return encodeBgraPng(width, height, pixels, false);
        } finally {
          api.SelectObject(memory, previous);
          api.DeleteObject(bitmap);
          api.DeleteDC(memory);
          api.ReleaseDC(null, screenDc);
        }
      });
    },
    targetBlocksInput() {
      const hwnd = api.GetForegroundWindow();
      if (isNull(hwnd) || selfRid === void 0) return false;
      const rid = integrityRid(api, pidOf(api, hwnd));
      return rid !== void 0 && rid > selfRid;
    },
    movePointer(x, y) {
      perMonitor(() => {
        placePointer(x, y);
      });
    },
    mouseButton(button, down) {
      const flags = button === "right" ? down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP : down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
      perMonitor(() => {
        sendMouse(api, flags, 0, 0);
      });
    },
    scrollWheel(x, y, delta) {
      perMonitor(() => {
        placePointer(x, y);
        sendMouse(api, MOUSEEVENTF_WHEEL, 0, 0, delta);
      });
    },
    key(virtualKey, down, extended = false) {
      postKey(api, virtualKey, down, extended);
    },
    readClipboardText() {
      let text = "";
      withClipboard(api, () => {
        const handle = api.GetClipboardData(CF_UNICODETEXT);
        if (isNull(handle)) return;
        const locked = api.GlobalLock(handle);
        if (isNull(locked)) return;
        try {
          const size = Number(api.GlobalSize(handle));
          if (!Number.isFinite(size) || size < 2) return;
          const bytes = Buffer.alloc(size);
          api.RtlMoveMemory(bytes, locked, size);
          text = bytes.toString("utf16le").replace(/\0[\s\S]*$/u, "");
        } finally {
          api.GlobalUnlock(handle);
        }
      });
      return text;
    },
    setClipboardText(text) {
      const bytes = Buffer.from(`${text}\0`, "utf16le");
      const memory = api.GlobalAlloc(GMEM_MOVEABLE, bytes.length);
      if (isNull(memory)) throw new Error("computer-use: clipboard allocation failed");
      const locked = api.GlobalLock(memory);
      if (isNull(locked)) throw new Error("computer-use: clipboard allocation failed");
      api.RtlMoveMemory(locked, bytes, bytes.length);
      api.GlobalUnlock(memory);
      withClipboard(api, () => {
        api.EmptyClipboard();
        if (isNull(api.SetClipboardData(CF_UNICODETEXT, memory))) throw new Error("computer-use: SetClipboardData failed");
      });
    },
    copyImageFile(path) {
      const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile(${JSON.stringify(path)})
try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }
`;
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-STA",
        "-Command",
        script
      ], {
        windowsHide: true,
        timeout: 5e3
      });
    },
    listWindowApps() {
      const names = /* @__PURE__ */ new Set();
      for (const hwnd of enumTopLevel(api)) {
        if (api.IsWindowVisible(hwnd) === 0) continue;
        const name2 = processBaseName(api, pidOf(api, hwnd));
        if (name2 !== void 0 && name2 !== "") names.add(name2);
      }
      return [...names];
    },
    activateApp(name2) {
      const wanted = name2.trim().toLowerCase();
      if (wanted === "") return false;
      return perMonitor(() => {
        let target;
        for (const hwnd of enumTopLevel(api)) {
          if (api.IsWindowVisible(hwnd) === 0) continue;
          const app = (processBaseName(api, pidOf(api, hwnd)) ?? "").toLowerCase();
          const title = windowText(api, hwnd).toLowerCase();
          if (app === wanted || title.includes(wanted)) {
            target = hwnd;
            break;
          }
        }
        if (target === void 0) return false;
        if (!becomeForeground(target)) throw new Error(`computer-use: failed to activate ${name2}`);
        return true;
      });
    },
    foregroundWindowId() {
      return hwndId(api.GetForegroundWindow()) ?? 0;
    },
    focusWindow(hwnd) {
      return perMonitor(() => {
        const target = windowPointer(hwnd);
        if (target === void 0) return false;
        return becomeForeground(target);
      });
    },
    launch(target, parameters) {
      const result = Number(api.ShellExecuteW(null, "open", target, parameters ?? null, null, SW_SHOWNORMAL));
      if (!Number.isFinite(result) || result <= 32) throw new Error(`computer-use: failed to open ${target}`);
    },
    explorerFolder
  };
}
var SRCCOPY, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEEVENTF_ABSOLUTE, INPUT_MOUSE, INPUT_KEYBOARD, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, CF_UNICODETEXT, GMEM_MOVEABLE, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, PROCESS_QUERY_LIMITED_INFORMATION, TOKEN_QUERY, TokenIntegrityLevel, SW_SHOWNORMAL, SW_RESTORE, GW_OWNER, GWL_STYLE, GWL_EXSTYLE, WS_POPUP, WS_EX_TOOLWINDOW, DWMWA_EXTENDED_FRAME_BOUNDS, DWMWA_CLOAKED, MONITOR_DEFAULTTONEAREST, MDT_EFFECTIVE_DPI, VK_MENU, CURSOR_SHOWING, DPI_PER_MONITOR_V2, DPI_PER_MONITOR, FOREGROUND_RETRY_MS, POINT, MOUSEINPUT, KEYBDINPUT, INPUT_UNION, INPUT, CURSORINFO, ICONINFO, BITMAP;
var init_windows_native_B7Ig34Q0 = __esm({
  "vendor/computer-use/windows-native-B7Ig34Q0.js"() {
    init_backend_18yEf5Jq();
    SRCCOPY = 13369376;
    MOUSEEVENTF_LEFTDOWN = 2;
    MOUSEEVENTF_LEFTUP = 4;
    MOUSEEVENTF_RIGHTDOWN = 8;
    MOUSEEVENTF_RIGHTUP = 16;
    MOUSEEVENTF_WHEEL = 2048;
    MOUSEEVENTF_ABSOLUTE = 32768;
    INPUT_MOUSE = 0;
    INPUT_KEYBOARD = 1;
    KEYEVENTF_EXTENDEDKEY = 1;
    KEYEVENTF_KEYUP = 2;
    CF_UNICODETEXT = 13;
    GMEM_MOVEABLE = 2;
    SM_XVIRTUALSCREEN = 76;
    SM_YVIRTUALSCREEN = 77;
    SM_CXVIRTUALSCREEN = 78;
    SM_CYVIRTUALSCREEN = 79;
    PROCESS_QUERY_LIMITED_INFORMATION = 4096;
    TOKEN_QUERY = 8;
    TokenIntegrityLevel = 25;
    SW_SHOWNORMAL = 1;
    SW_RESTORE = 9;
    GW_OWNER = 4;
    GWL_STYLE = -16;
    GWL_EXSTYLE = -20;
    WS_POPUP = 2147483648;
    WS_EX_TOOLWINDOW = 128;
    DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    DWMWA_CLOAKED = 14;
    MONITOR_DEFAULTTONEAREST = 2;
    MDT_EFFECTIVE_DPI = 0;
    VK_MENU = 18;
    CURSOR_SHOWING = 1;
    DPI_PER_MONITOR_V2 = -4;
    DPI_PER_MONITOR = -3;
    FOREGROUND_RETRY_MS = 50;
    koffi.struct("DSH_CU_RECT", {
      left: "int32",
      top: "int32",
      right: "int32",
      bottom: "int32"
    });
    POINT = koffi.struct("DSH_CU_POINT", {
      x: "int32",
      y: "int32"
    });
    koffi.struct("DSH_CU_BITMAPINFOHEADER", {
      biSize: "uint32",
      biWidth: "int32",
      biHeight: "int32",
      biPlanes: "uint16",
      biBitCount: "uint16",
      biCompression: "uint32",
      biSizeImage: "uint32",
      biXPelsPerMeter: "int32",
      biYPelsPerMeter: "int32",
      biClrUsed: "uint32",
      biClrImportant: "uint32"
    });
    MOUSEINPUT = koffi.struct("DSH_CU_MOUSEINPUT", {
      dx: "int32",
      dy: "int32",
      mouseData: "uint32",
      dwFlags: "uint32",
      time: "uint32",
      dwExtraInfo: "uintptr"
    });
    KEYBDINPUT = koffi.struct("DSH_CU_KEYBDINPUT", {
      wVk: "uint16",
      wScan: "uint16",
      dwFlags: "uint32",
      time: "uint32",
      dwExtraInfo: "uintptr"
    });
    INPUT_UNION = koffi.union("DSH_CU_INPUT_UNION", {
      mi: MOUSEINPUT,
      ki: KEYBDINPUT
    });
    INPUT = koffi.struct("DSH_CU_INPUT", {
      type: "uint32",
      u: INPUT_UNION
    });
    CURSORINFO = koffi.struct("DSH_CU_CURSORINFO", {
      cbSize: "uint32",
      flags: "uint32",
      hCursor: "void *",
      ptScreenPos: POINT
    });
    ICONINFO = koffi.struct("DSH_CU_ICONINFO", {
      fIcon: "int32",
      xHotspot: "uint32",
      yHotspot: "uint32",
      hbmMask: "void *",
      hbmColor: "void *"
    });
    BITMAP = koffi.struct("DSH_CU_BITMAP", {
      bmType: "int32",
      bmWidth: "int32",
      bmHeight: "int32",
      bmWidthBytes: "int32",
      bmPlanes: "uint16",
      bmBitsPixel: "uint16",
      bmBits: "void *"
    });
  }
});

// vendor/computer-use/backend-18yEf5Jq.js
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { crc32, deflateSync } from "node:zlib";
function activeCaptureExcludeWindowIds() {
  return captureExclude.getStore() ?? [];
}
function runWithCaptureExcludeWindowIds(excludeWindowIds, fn) {
  return captureExclude.run(excludeWindowIds, fn);
}
function normalizeHotkeyKey(key) {
  return key.trim().toLowerCase();
}
function isForbiddenScreenshotHotkey(keys) {
  const normalized = keys.map(normalizeHotkeyKey).filter((key) => key.length > 0);
  const hasMeta = normalized.some((key) => META_KEYS.has(key));
  const hasShift = normalized.some((key) => SHIFT_KEYS.has(key));
  const hasShot = normalized.some((key) => SCREENSHOT_KEYS.has(key));
  return hasMeta && hasShift && hasShot;
}
function assertAllowedHotkey(keys) {
  if (isForbiddenScreenshotHotkey(keys)) throw new Error("computer-use: system screenshot shortcuts are forbidden");
}
function requireClickModifiers(modifiers) {
  if (modifiers === void 0 || modifiers.length === 0) return void 0;
  const seen = /* @__PURE__ */ new Set();
  const accepted = [];
  for (const token of modifiers) {
    const key = normalizeHotkeyKey(token);
    const kind = CLICK_MODIFIER_KIND[key];
    if (kind === void 0) throw new Error(`computer-use: click modifiers must be shift, cmd, option, or control; got ${JSON.stringify(token)}`);
    if (seen.has(kind)) continue;
    seen.add(kind);
    accepted.push(key);
  }
  return accepted;
}
function mapFractionToGlobal(fraction, screen) {
  const [fx, fy] = fraction;
  return {
    x: screen.bounds.x + fx * screen.bounds.width,
    y: screen.bounds.y + fy * screen.bounds.height
  };
}
function mapNormalizedToGlobal(position, screen) {
  const [nx, ny] = position;
  return mapFractionToGlobal([nx / COORDINATE_SPACE, ny / COORDINATE_SPACE], screen);
}
function requireNormalizedPosition(position) {
  if (position.length !== 2) throw new Error("position must be [x, y] with exactly two coordinates in the 0\u20131000 space");
  const x = position[0];
  const y = position[1];
  if (x === void 0 || y === void 0 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1e3 || y < 0 || y > 1e3) throw new Error("position coordinates must be finite numbers in the 0\u20131000 space");
  return [x, y];
}
function requirePixelPosition(position, attached) {
  if (position.length !== 2) throw new Error(`position must be [x, y] with exactly two coordinates in the attached ${String(attached.width)}x${String(attached.height)} pixel space`);
  const x = position[0];
  const y = position[1];
  if (x === void 0 || y === void 0 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > attached.width || y < 0 || y > attached.height) throw new Error(`position coordinates must be finite numbers in the attached ${String(attached.width)}x${String(attached.height)} pixel space`);
  return [x, y];
}
function modelPositionToHid(position, mode, attached) {
  if (mode === "millifraction") return requireNormalizedPosition(position);
  if (attached === void 0) throw new Error("computer-use: pixel coordinates require an attached screenshot raster");
  const [x, y] = requirePixelPosition(position, attached);
  return [x / attached.width * COORDINATE_SPACE, y / attached.height * COORDINATE_SPACE];
}
function macosSckCaptureHelperPath() {
  const beside = fileURLToPath(new URL("./macos-sck-capture", import.meta.url));
  if (existsSync(beside)) return beside;
  return fileURLToPath(new URL("../lib/macos-sck-capture", import.meta.url));
}
function sanitizeExcludeWindowIds(excludeWindowIds) {
  return excludeWindowIds.filter((id) => Number.isInteger(id) && id > 0);
}
function jxaKeySet(keys) {
  return `{ ${keys.map((key) => `${JSON.stringify(key)}: true`).join(", ")} }`;
}
function inspectForegroundScript(excludeWindowIds) {
  const ids = sanitizeExcludeWindowIds(excludeWindowIds);
  return `ObjC.import('AppKit')
ObjC.import('CoreGraphics')
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['@', ['I', 'I']])
const exclude = ${ids.length === 0 ? "{}" : `{ ${ids.map((id) => `${String(id)}: true`).join(", ")} }`}
const crossPidLayers = ${jxaKeySet(CROSS_PID_TRANSIENT_LAYERS)}
const chromeLayers = ${jxaKeySet(CHROME_WINDOW_LAYERS)}
const chromeOwners = ${jxaKeySet(CHROME_WINDOW_OWNERS)}
const pad = ${String(48)}
const windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0)) || []
const primary = $.NSScreen.screens.objectAtIndex(0).frame
const primaryHeight = primary.size.height
function screenAt(x, y, w, h) {
  var cx = x + w / 2
  var cy = y + h / 2
  var screens = $.NSScreen.screens.js
  for (var i = 0; i < screens.length; i++) {
    var f = screens[i].frame
    // AppKit frames use a bottom-left origin; window bounds and the screencapture
    // region flag share the main display's top-left origin, so flip the frame here.
    var sx = f.origin.x
    var sy = primaryHeight - f.origin.y - f.size.height
    if (cx >= sx && cx < sx + f.size.width && cy >= sy && cy < sy + f.size.height) {
      return {
        index: i,
        x: sx,
        y: sy,
        width: f.size.width,
        height: f.size.height,
        scale: Number(screens[i].backingScaleFactor),
      }
    }
  }
  return null
}
function screenIndex(x, y, w, h) {
  var screen = screenAt(x, y, w, h)
  return screen ? screen.index : -1
}
function screenScale(x, y, w, h) {
  var screen = screenAt(x, y, w, h)
  if (screen && screen.scale > 0) return screen.scale
  var main = $.NSScreen.mainScreen
  var fallback = main ? Number(main.backingScaleFactor) : 1
  return fallback > 0 ? fallback : 1
}
function overlaps(ax, ay, aw, ah, bx, by, bw, bh, extra) {
  return ax - extra < bx + bw && ax + aw + extra > bx
    && ay - extra < by + bh && ay + ah + extra > by
}
function relatedOwner(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  if (a === b) return true
  return b.indexOf(a + ' ') === 0 || a.indexOf(b + ' ') === 0
}
function relatedBundle(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  if (a === b) return true
  return b.indexOf(a + '.') === 0 || a.indexOf(b + '.') === 0
}
function familyPids(ownerPid) {
  var pids = {}
  pids[ownerPid] = true
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications.js
  var loc = ''
  var bundle = ''
  for (var i = 0; i < apps.length; i++) {
    if (Number(apps[i].processIdentifier) === ownerPid) {
      loc = ObjC.unwrap(apps[i].localizedName)
      bundle = ObjC.unwrap(apps[i].bundleIdentifier)
      break
    }
  }
  if (typeof loc !== 'string') loc = ''
  if (typeof bundle !== 'string') bundle = ''
  for (var j = 0; j < apps.length; j++) {
    var app = apps[j]
    var pid = Number(app.processIdentifier)
    if (!(pid > 0) || pids[pid]) continue
    var n = ObjC.unwrap(app.localizedName)
    var b = ObjC.unwrap(app.bundleIdentifier)
    if (relatedOwner(loc, n) || relatedBundle(bundle, b)) pids[pid] = true
  }
  return pids
}
var found = null
var ownerPid = 0
var ownerScreen = -1
var minEdge = ${String(64)}
for (var i = 0; i < windows.length; i++) {
  var w = windows[i]
  if (!w) continue
  var id = Number(w.kCGWindowNumber)
  if (!(id > 0) || exclude[id]) continue
  if (Number(w.kCGWindowLayer) !== 0) continue
  var name = w.kCGWindowOwnerName
  if (typeof name !== 'string' || name.length === 0) continue
  var b = w.kCGWindowBounds
  var x = b ? Number(b.X) : NaN
  var y = b ? Number(b.Y) : NaN
  var width = b ? Number(b.Width) : NaN
  var height = b ? Number(b.Height) : NaN
  var owner = screenAt(x, y, width, height)
  var scale = owner ? owner.scale : screenScale(x, y, width, height)
  if (!(width >= minEdge) || !(height >= minEdge) || !(scale > 0)) continue
  ownerPid = Number(w.kCGWindowOwnerPID)
  ownerScreen = owner ? owner.index : -1
  found = {
    appName: name,
    windowId: id,
    x: x,
    y: y,
    width: width,
    height: height,
    scale: scale,
  }
  // The owning display rect lets the caller clip the capture region the same way the
  // screencapture region flag does, so raster, ribbon, and click mapping stay one rectangle.
  if (owner) {
    found.screen = { x: owner.x, y: owner.y, width: owner.width, height: owner.height }
  }
  var title = w.kCGWindowName
  if (typeof title === 'string' && title.trim().length > 0) found.windowTitle = title.trim()
  break
}
if (found) {
  var family = familyPids(ownerPid)
  var transients = []
  var minX = found.x
  var minY = found.y
  var maxX = found.x + found.width
  var maxY = found.y + found.height
  for (var j = 0; j < windows.length; j++) {
    var t = windows[j]
    if (!t) continue
    var tid = Number(t.kCGWindowNumber)
    if (!(tid > 0) || exclude[tid] || tid === found.windowId) continue
    var tLayer = Number(t.kCGWindowLayer)
    if (chromeLayers[tLayer] || tLayer < 0) continue
    var tOwner = t.kCGWindowOwnerName
    if (typeof tOwner === 'string' && chromeOwners[tOwner]) continue
    var tb = t.kCGWindowBounds
    var tx = tb ? Number(tb.X) : NaN
    var ty = tb ? Number(tb.Y) : NaN
    var tw = tb ? Number(tb.Width) : NaN
    var th = tb ? Number(tb.Height) : NaN
    if (!(tw > 0) || !(th > 0) || Number(t.kCGWindowAlpha) === 0) continue
    if (screenIndex(tx, ty, tw, th) !== ownerScreen) continue
    var tPid = Number(t.kCGWindowOwnerPID)
    var inFamily = family[tPid] || relatedOwner(found.appName, tOwner)
    if (!inFamily) {
      if (!crossPidLayers[tLayer]) continue
      if (!overlaps(found.x, found.y, found.width, found.height, tx, ty, tw, th, pad)) continue
    }
    transients.push(tid)
    if (tx < minX) minX = tx
    if (ty < minY) minY = ty
    if (tx + tw > maxX) maxX = tx + tw
    if (ty + th > maxY) maxY = ty + th
  }
  found.x = minX
  found.y = minY
  found.width = maxX - minX
  found.height = maxY - minY
  if (transients.length > 0) found.transients = transients
}
JSON.stringify(found)
`;
}
function openAppScript(name2) {
  return `ObjC.import('AppKit')
const needle = ${JSON.stringify(name2)}
const needleLower = needle.toLowerCase()
const apps = $.NSWorkspace.sharedWorkspace.runningApplications.js
const matches = []
const seen = {}
for (var i = 0; i < apps.length; i++) {
  var app = apps[i]
  if (app.activationPolicy !== 0) continue
  var localized = ObjC.unwrap(app.localizedName)
  var bundle = ObjC.unwrap(app.bundleIdentifier)
  var nameOk = typeof localized === 'string' && localized.trim().toLowerCase() === needleLower
  var bundleOk = typeof bundle === 'string' && bundle.trim().toLowerCase() === needleLower
  if (!nameOk && !bundleOk) continue
  var key = typeof bundle === 'string' && bundle.length > 0 ? bundle : ('name:' + String(localized))
  if (seen[key]) continue
  seen[key] = true
  matches.push({
    app: app,
    name: typeof localized === 'string' && localized.trim().length > 0 ? localized.trim() : needle,
  })
}
if (matches.length > 1) {
  JSON.stringify({ kind: 'ambiguous', names: matches.map(function (m) { return m.name }) })
} else if (matches.length === 1) {
  matches[0].app.activateWithOptions_(2)
  JSON.stringify({ kind: 'activated', name: matches[0].name })
} else {
  JSON.stringify({ kind: 'launch', name: needle })
}
`;
}
function isFinderApp(appName) {
  const name2 = appName.trim();
  return name2 === "Finder" || name2 === "\u8BBF\u8FBE";
}
async function runCommand(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, [...args], {
      encoding: "utf8",
      signal: options.signal,
      timeout: 3e4,
      maxBuffer: 10485760
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    throw new Error(`computer-use: ${file} failed: ${errorDetail(error)}`);
  }
}
function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}
function mediaTypeOf(data) {
  if (data.length >= 8 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  throw new Error("computer-use: capture produced an unsupported image");
}
function parseTransientIds(value) {
  if (!Array.isArray(value)) return void 0;
  const ids = [];
  for (const entry of value) {
    const id = Number(entry);
    if (!Number.isInteger(id) || id < 1) continue;
    ids.push(id);
  }
  return ids.length === 0 ? void 0 : ids;
}
function parseDisplayBounds(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const row = value;
  const x = Number(row.x);
  const y = Number(row.y);
  const width = Number(row.width);
  const height = Number(row.height);
  if (![
    x,
    y,
    width,
    height
  ].every(Number.isFinite) || width <= 0 || height <= 0) return void 0;
  return {
    x,
    y,
    width,
    height
  };
}
function parseFrontmost(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "null") return void 0;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return void 0;
    const row = parsed;
    if (typeof row.appName !== "string") return void 0;
    const appName = row.appName.trim();
    if (appName === "") return void 0;
    const windowTitle = typeof row.windowTitle === "string" ? row.windowTitle.trim() : "";
    const windowId = Number(row.windowId);
    const x = Number(row.x);
    const y = Number(row.y);
    const width = Number(row.width);
    const height = Number(row.height);
    const scale = Number(row.scale);
    const transientWindowIds = parseTransientIds(row.transients);
    const displayBounds = parseDisplayBounds(row.screen);
    const hasSurface = Number.isInteger(windowId) && windowId > 0 && [
      x,
      y,
      width,
      height,
      scale
    ].every(Number.isFinite) && width > 0 && height > 0 && scale > 0;
    return {
      appName,
      ...windowTitle === "" ? {} : { windowTitle },
      ...hasSurface ? {
        windowId,
        bounds: {
          x,
          y,
          width,
          height
        },
        scale,
        ...transientWindowIds === void 0 ? {} : { transientWindowIds },
        ...displayBounds === void 0 ? {} : { displayBounds }
      } : {}
    };
  } catch {
    return;
  }
}
function clipToDisplay(bounds, display) {
  if (display === void 0) return bounds;
  const x = Math.max(bounds.x, display.x);
  const y = Math.max(bounds.y, display.y);
  const right = Math.min(bounds.x + bounds.width, display.x + display.width);
  const bottom = Math.min(bounds.y + bounds.height, display.y + display.height);
  if (!(right > x) || !(bottom > y)) return void 0;
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}
function screenFromFrontmost(parsed) {
  if (parsed.windowId === void 0 || parsed.bounds === void 0 || parsed.scale === void 0) return;
  const bounds = clipToDisplay(parsed.bounds, parsed.displayBounds);
  if (bounds === void 0) return void 0;
  return {
    index: 0,
    bounds,
    scale: parsed.scale,
    windowId: parsed.windowId,
    ...parsed.transientWindowIds === void 0 ? {} : { transientWindowIds: parsed.transientWindowIds }
  };
}
function foregroundFromFrontmost(parsed) {
  return {
    appName: parsed.appName,
    ...parsed.windowTitle === void 0 ? {} : { windowTitle: parsed.windowTitle }
  };
}
function parseFinderFolder(stdout) {
  const path = stdout.trim();
  if (path === "" || !path.startsWith("/")) return void 0;
  return path;
}
function parseDefaultBrowserBundle(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === "") return void 0;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "string") return void 0;
    const bundle = parsed.trim();
    return bundle === "" ? void 0 : bundle;
  } catch {
    return;
  }
}
function isAbortError(error, signal) {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}
function parseAppNames(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("computer-use: failed to list apps");
  }
  if (!Array.isArray(parsed)) throw new Error("computer-use: failed to list apps");
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of parsed) {
    if (typeof entry !== "string") throw new Error("computer-use: failed to list apps");
    const name2 = entry.trim();
    if (name2 === "" || seen.has(name2)) continue;
    seen.add(name2);
    names.push(name2);
  }
  return names;
}
function looksLikeBundleId(name2) {
  return /^[A-Za-z0-9-]+\.[A-Za-z0-9.-]+$/u.test(name2);
}
function parseOpenAppDecision(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("computer-use: open_app failed: unreadable activate result");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("computer-use: open_app failed: unreadable activate result");
  const row = parsed;
  if (row.kind === "ambiguous") return {
    kind: "ambiguous",
    names: Array.isArray(row.names) ? row.names.filter((entry) => typeof entry === "string" && entry.trim() !== "") : []
  };
  if ((row.kind === "activated" || row.kind === "launch") && typeof row.name === "string" && row.name.trim() !== "") return {
    kind: row.kind,
    name: row.name.trim()
  };
  throw new Error("computer-use: open_app failed: unreadable activate result");
}
function regionCaptureSpec(bounds) {
  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  return `${String(x)},${String(y)},${String(width)},${String(height)}`;
}
function keyCode(token) {
  const key = token.trim().toLowerCase();
  const code = KEY_CODES[key];
  if (code === void 0) throw new Error(`computer-use: unknown key "${token}"`);
  return code;
}
function jxa(script) {
  return [
    "-l",
    "JavaScript",
    "-e",
    script
  ];
}
function hidScript(body) {
  return `${HID_RUNTIME}
${body}
`;
}
function copyImageScript(input) {
  return `ObjC.import('AppKit')
var pb = $.NSPasteboard.generalPasteboard
var discarded = pb.clearContents
var data = $.NSData.dataWithContentsOfFile($.NSString.stringWithString(${JSON.stringify(input.path)}))
if (!data) throw new Error('clipboard image file is missing')
pb.setDataForType(data, $.NSString.stringWithString(${JSON.stringify(PASTEBOARD_TYPE[input.mediaType])}))
`;
}
function roundedPoint(position, screen) {
  const point = mapNormalizedToGlobal(position, screen);
  return {
    x: Math.round(point.x),
    y: Math.round(point.y)
  };
}
async function runHidScript(run, script, signal) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-computer-use-hid-"));
  const file = join(dir, "hid.js");
  try {
    await writeFile(file, script, "utf8");
    await run(OSASCRIPT, [
      "-l",
      "JavaScript",
      file
    ], { signal });
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
}
function createMacosDesktopBackend(run = runCommand, excludedRegionCapture) {
  const hid = async (body, signal) => {
    await runHidScript(run, hidScript(body), signal);
  };
  return {
    withGuiTurn: (run2) => run2(),
    async listScreens(signal) {
      const parsed = parseFrontmost((await run(OSASCRIPT, jxa(inspectForegroundScript(activeCaptureExcludeWindowIds())), { signal })).stdout);
      if (parsed === void 0) return [];
      const screen = screenFromFrontmost(parsed);
      return screen === void 0 ? [] : [screen];
    },
    async capture(screen, signal) {
      const dir = await mkdtemp(join(tmpdir(), "dsh-computer-use-"));
      const file = join(dir, "screen.jpg");
      const excludeWindowIds = activeCaptureExcludeWindowIds();
      const overlayCapture = async (region, ids) => {
        try {
          if (excludedRegionCapture !== void 0) {
            await excludedRegionCapture({
              region,
              excludeWindowIds: ids,
              output: file,
              ...signal === void 0 ? {} : { signal }
            });
            return;
          }
          await run(macosSckCaptureHelperPath(), [
            `--region=${region}`,
            `--exclude=${ids.join(",")}`,
            `--out=${file}`
          ], { signal });
        } catch (error) {
          throw new Error(`computer-use: overlay-exclude capture failed: ${errorDetail(error)}`);
        }
      };
      try {
        const region = regionCaptureSpec(screen.bounds);
        if (excludeWindowIds.length === 0) await run(SCREENCAPTURE, [
          "-x",
          "-C",
          "-R",
          region,
          "-t",
          "jpg",
          file
        ], { signal });
        else await overlayCapture(region, excludeWindowIds);
        const data = await readFile(file);
        return {
          data,
          mediaType: mediaTypeOf(data)
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("computer-use: overlay-exclude capture failed:")) throw error;
        throw new Error(`computer-use: screen capture failed (Screen Recording permission is required): ${errorDetail(error)}`);
      } finally {
        await rm(dir, {
          recursive: true,
          force: true
        });
      }
    },
    async inspectForeground(signal) {
      try {
        const parsed = parseFrontmost((await run(OSASCRIPT, jxa(inspectForegroundScript(activeCaptureExcludeWindowIds())), { signal })).stdout);
        if (parsed === void 0) return FOCUS_FALLBACK_FOREGROUND;
        const foreground = foregroundFromFrontmost(parsed);
        if (!isFinderApp(parsed.appName)) return foreground;
        try {
          const finderFolder = parseFinderFolder((await run(OSASCRIPT, ["-e", FINDER_FOLDER_SCRIPT], { signal })).stdout);
          return finderFolder === void 0 ? foreground : {
            ...foreground,
            finderFolder
          };
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          return foreground;
        }
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        return FOCUS_FALLBACK_FOREGROUND;
      }
    },
    async listApps(signal) {
      return parseAppNames((await run(OSASCRIPT, jxa(LIST_APPS_SCRIPT), { signal })).stdout.trim());
    },
    async openApp(input, signal) {
      const name2 = input.name.trim();
      if (name2 === "") throw new Error("computer-use: open_app requires a name");
      try {
        const decision = parseOpenAppDecision((await run(OSASCRIPT, jxa(openAppScript(name2)), { signal })).stdout);
        if (decision.kind === "ambiguous") {
          const listed = decision.names.length === 0 ? name2 : decision.names.join(", ");
          throw new Error(`computer-use: app name "${name2}" matches multiple applications: ${listed}`);
        }
        if (decision.kind === "activated") return {
          kind: "activated",
          name: decision.name
        };
        await run(OPEN, looksLikeBundleId(name2) ? ["-b", name2] : ["-a", name2], { signal });
        return {
          kind: "launched",
          name: name2
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("computer-use:")) throw error;
        throw new Error(`computer-use: open_app failed for ${name2}: ${errorDetail(error)}`);
      }
    },
    async click(input, signal) {
      const point = roundedPoint(input.position, input.screen);
      const button = input.button === "right" ? 1 : 0;
      const modifiers = input.modifiers ?? [];
      const body = modifiers.length === 0 ? `clickAt(${point.x}, ${point.y}, ${button}, ${input.count})` : `clickWithModifiers(${point.x}, ${point.y}, ${button}, ${input.count}, ${JSON.stringify(modifiers.map(keyCode))})`;
      try {
        await hid(body, signal);
      } catch (error) {
        throw new Error(`computer-use: pointer input failed (Accessibility permission is required): ${errorDetail(error)}`);
      }
    },
    async typeText(input, signal) {
      const point = roundedPoint(input.position, input.screen);
      const lines = [`clickAt(${point.x}, ${point.y}, 0, 1)`, "sleep(120)"];
      if (input.replace) lines.push("selectAll()", "sleep(40)");
      if (input.text.length > 0) lines.push(`pasteText(${JSON.stringify(input.text)})`);
      if (input.submit) lines.push("pressEnter()");
      try {
        await hid(lines.join("\n"), signal);
      } catch (error) {
        throw new Error(`computer-use: keyboard input failed (Accessibility permission is required): ${errorDetail(error)}`);
      }
    },
    async scroll(input, signal) {
      const point = roundedPoint(input.position, input.screen);
      const dy = input.direction === "up" ? input.scrollLevel : -input.scrollLevel;
      try {
        await hid(`scrollAt(${point.x}, ${point.y}, ${dy})`, signal);
      } catch (error) {
        throw new Error(`computer-use: scroll input failed (Accessibility permission is required): ${errorDetail(error)}`);
      }
    },
    async hotkey(input, signal) {
      try {
        const codes = input.keys.map(keyCode);
        await hid(`chord(${JSON.stringify(codes)})`, signal);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("computer-use: unknown key")) throw error;
        throw new Error(`computer-use: hotkey input failed (Accessibility permission is required): ${errorDetail(error)}`);
      }
    },
    async longPress(input, signal) {
      const point = roundedPoint(input.position, input.screen);
      const durationMs = Math.round(input.durationSeconds * 1e3);
      try {
        await hid(`longPressAt(${point.x}, ${point.y}, ${String(durationMs)})`, signal);
      } catch (error) {
        throw new Error(`computer-use: pointer input failed (Accessibility permission is required): ${errorDetail(error)}`);
      }
    },
    async drag(input, signal) {
      const start = roundedPoint(input.startPosition, input.startScreen);
      const end = roundedPoint(input.endPosition, input.endScreen);
      try {
        await hid(`dragFromTo(${start.x}, ${start.y}, ${end.x}, ${end.y})`, signal);
      } catch (error) {
        throw new Error(`computer-use: pointer input failed (Accessibility permission is required): ${errorDetail(error)}`);
      }
    },
    async openInBrowser(input, signal) {
      try {
        if (input.url !== void 0) {
          await run(OPEN, [input.url], { signal });
          return;
        }
        const bundle = parseDefaultBrowserBundle((await run(OSASCRIPT, jxa(DEFAULT_BROWSER_SCRIPT), { signal })).stdout);
        if (bundle === void 0) throw new Error("could not resolve the default browser");
        await run(OPEN, ["-b", bundle], { signal });
      } catch (error) {
        const target = input.url === void 0 ? "the default browser" : input.url;
        throw new Error(`computer-use: open failed for ${target}: ${errorDetail(error)}`);
      }
    },
    async openInFinder(input, signal) {
      try {
        await run(OPEN, input.revealOnly ? ["-R", input.path] : [input.path], { signal });
      } catch (error) {
        throw new Error(`computer-use: open failed for ${input.path}: ${errorDetail(error)}`);
      }
    },
    async copyImageToClipboard(input, signal) {
      try {
        await runHidScript(run, copyImageScript(input), signal);
      } catch (error) {
        throw new Error(`computer-use: clipboard copy failed: ${errorDetail(error)}`);
      }
    }
  };
}
function createUnsupportedDesktopBackend() {
  const fail = () => Promise.reject(/* @__PURE__ */ new Error(UNSUPPORTED_DESKTOP_MESSAGE));
  return {
    listScreens: fail,
    capture: fail,
    inspectForeground: fail,
    listApps: fail,
    openApp: fail,
    click: fail,
    typeText: fail,
    scroll: fail,
    hotkey: fail,
    longPress: fail,
    drag: fail,
    openInBrowser: fail,
    openInFinder: fail,
    copyImageToClipboard: fail,
    withGuiTurn: (run) => run()
  };
}
async function delay(ms, signal) {
  if (ms <= 0) {
    signal.throwIfAborted();
    return;
  }
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : /* @__PURE__ */ new Error("computer-use: wait aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function excludeSet(ids) {
  const exclude = /* @__PURE__ */ new Set();
  for (const id of ids) if (Number.isInteger(id) && id > 0) exclude.add(id);
  return exclude;
}
function sameMonitor(left, right) {
  return left.monitor.x === right.monitor.x && left.monitor.y === right.monitor.y && left.monitor.width === right.monitor.width && left.monitor.height === right.monitor.height;
}
function intersects(left, right, pad) {
  return left.x - pad < right.x + right.width && left.x + left.width + pad > right.x && left.y - pad < right.y + right.height && left.y + left.height + pad > right.y;
}
function positiveFrame(frame) {
  return frame.width > 0 && frame.height > 0;
}
function ownedBy(byHwnd, candidate, ownerHwnd) {
  let current = candidate.ownerHwnd;
  const seen = /* @__PURE__ */ new Set();
  while (current !== 0 && !seen.has(current)) {
    if (current === ownerHwnd) return true;
    seen.add(current);
    current = byHwnd.get(current)?.ownerHwnd ?? 0;
  }
  return false;
}
function eligibleOwner(window, exclude) {
  if (exclude.has(window.hwnd)) return false;
  if (!window.visible || window.iconic || window.cloaked || window.toolWindow) return false;
  if (SHELL_CLASSES.has(window.className) || CROSS_PID_TRANSIENT_CLASSES.has(window.className)) return false;
  if (window.frame.width < 64 || window.frame.height < 64) return false;
  return true;
}
function includeTransient(candidate, owner, byHwnd) {
  const samePid = candidate.pid === owner.pid;
  if (samePid && ownedBy(byHwnd, candidate, owner.hwnd)) return true;
  const hits = intersects(owner.frame, candidate.frame, 48);
  if (samePid && candidate.popup && hits) return true;
  return !samePid && CROSS_PID_TRANSIENT_CLASSES.has(candidate.className) && hits;
}
function selectWindowsObservation(snapshot, excludeWindowIds) {
  const exclude = excludeSet(excludeWindowIds);
  const foreground = snapshot.windows.find((window) => window.hwnd === snapshot.foregroundHwnd);
  const owner = foreground !== void 0 && eligibleOwner(foreground, exclude) ? foreground : snapshot.windows.find((window) => eligibleOwner(window, exclude));
  if (owner === void 0) return void 0;
  const byHwnd = new Map(snapshot.windows.map((window) => [window.hwnd, window]));
  let minX = owner.frame.x;
  let minY = owner.frame.y;
  let maxX = owner.frame.x + owner.frame.width;
  let maxY = owner.frame.y + owner.frame.height;
  const transientWindowIds = [];
  for (const candidate of snapshot.windows) {
    if (candidate.hwnd === owner.hwnd || exclude.has(candidate.hwnd)) continue;
    if (!candidate.visible || candidate.iconic || candidate.cloaked) continue;
    if (SHELL_CLASSES.has(candidate.className) || !positiveFrame(candidate.frame)) continue;
    if (!sameMonitor(candidate, owner)) continue;
    if (!includeTransient(candidate, owner, byHwnd)) continue;
    transientWindowIds.push(candidate.hwnd);
    if (candidate.frame.x < minX) minX = candidate.frame.x;
    if (candidate.frame.y < minY) minY = candidate.frame.y;
    if (candidate.frame.x + candidate.frame.width > maxX) maxX = candidate.frame.x + candidate.frame.width;
    if (candidate.frame.y + candidate.frame.height > maxY) maxY = candidate.frame.y + candidate.frame.height;
  }
  return {
    appName: owner.appName,
    windowTitle: owner.title.trim(),
    bounds: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    },
    scale: owner.monitorDpi > 0 ? owner.monitorDpi / 96 : 1,
    windowId: owner.hwnd,
    transientWindowIds,
    focused: snapshot.foregroundHwnd === owner.hwnd || transientWindowIds.includes(snapshot.foregroundHwnd)
  };
}
function windowsVirtualKey(key) {
  const token = key.trim().toLowerCase();
  const named = KEY_NAMES[token];
  if (named !== void 0) return named;
  if (/^[a-z]$/u.test(token)) return token.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/u.test(token)) return token.charCodeAt(0);
  const fn = /^f([1-9]|1[0-2])$/u.exec(token);
  if (fn !== null) return 112 + Number(fn[1]) - 1;
  throw new Error(`computer-use: unknown key ${JSON.stringify(key)}`);
}
function windowsKeyIsExtended(key) {
  return EXTENDED_KEY_NAMES.has(key.trim().toLowerCase());
}
function postedKey(key) {
  return {
    vk: windowsVirtualKey(key),
    extended: windowsKeyIsExtended(key)
  };
}
function postedVk(vk) {
  return {
    vk,
    extended: false
  };
}
function encodeBgraPng(width, height, bgra, bottomUp) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = bottomUp ? height - 1 - y : y;
    const dest = y * (rowBytes + 1);
    raw[dest] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = sourceY * rowBytes + x * 4;
      const pixel = dest + 1 + x * 4;
      raw[pixel] = bgra[source + 2] ?? 0;
      raw[pixel + 1] = bgra[source + 1] ?? 0;
      raw[pixel + 2] = bgra[source] ?? 0;
      raw[pixel + 3] = 255;
    }
  }
  const signature = Buffer.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name2 = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name2, data])) >>> 0);
  return Buffer.concat([
    length,
    name2,
    data,
    crc
  ]);
}
function liveSignal(signal) {
  return signal ?? new AbortController().signal;
}
function pointOf(position, screen) {
  const mapped = mapNormalizedToGlobal(position, screen);
  return {
    x: Math.round(mapped.x),
    y: Math.round(mapped.y)
  };
}
function assertInput(ops) {
  if (ops.targetBlocksInput()) throw new Error(ELEVATED_WINDOW);
}
function restoreObservedFocus(host, observed) {
  if (observed === void 0) return;
  const foreground = host.foregroundWindowId();
  if (foreground === observed.windowId || observed.transientWindowIds.includes(foreground)) return;
  if (host.focusWindow(observed.windowId)) return;
  throw new Error(`computer-use: keyboard focus could not be moved to ${observed.appName}; click inside the window, then retry hotkey`);
}
async function clickAt(ops, button, count, point, signal) {
  ops.movePointer(point.x, point.y);
  await delay(POINTER_MOVE_SETTLE_MS, signal);
  for (let index = 0; index < count; index += 1) {
    ops.mouseButton(button, true);
    await delay(BUTTON_HOLD_MS, signal);
    ops.mouseButton(button, false);
    if (index + 1 < count) await delay(DOUBLE_CLICK_GAP_MS, signal);
  }
}
async function chord(ops, keys, signal) {
  const modifiers = keys.filter((key) => MODIFIER_VKS.has(key.vk));
  const rest = keys.filter((key) => !MODIFIER_VKS.has(key.vk));
  for (const key of modifiers) ops.key(key.vk, true, key.extended);
  if (modifiers.length > 0) await delay(MODIFIER_GAP_MS, signal);
  for (const key of rest) ops.key(key.vk, true, key.extended);
  for (const key of [...rest].reverse()) ops.key(key.vk, false, key.extended);
  for (const key of [...modifiers].reverse()) ops.key(key.vk, false, key.extended);
}
function observationOf(ops) {
  return selectWindowsObservation(ops.listWindows(), activeCaptureExcludeWindowIds());
}
function screenFromObservation(selected) {
  return {
    index: 0,
    bounds: selected.bounds,
    scale: selected.scale,
    windowId: selected.windowId,
    ...selected.transientWindowIds.length === 0 ? {} : { transientWindowIds: selected.transientWindowIds }
  };
}
async function production() {
  productionOps ??= (await Promise.resolve().then(() => (init_windows_native_B7Ig34Q0(), windows_native_B7Ig34Q0_exports))).createProductionWindowsOps();
  return productionOps;
}
function createWindowsDesktopBackend(ops) {
  const use = async () => ops ?? await production();
  let observed;
  return {
    withGuiTurn: (run) => run(),
    async listScreens(signal) {
      signal?.throwIfAborted();
      const selected = observationOf(await use());
      observed = selected;
      if (selected === void 0) return [];
      return [screenFromObservation(selected)];
    },
    async capture(screen, signal) {
      signal?.throwIfAborted();
      try {
        return {
          data: (await use()).capturePng(screen.bounds),
          mediaType: "image/png"
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("computer-use:")) throw error;
        throw new Error(`computer-use: screen capture failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async inspectForeground(signal) {
      signal?.throwIfAborted();
      const host = await use();
      const selected = observationOf(host);
      if (selected === void 0) return FOCUS_FALLBACK_FOREGROUND;
      const folder = selected.appName.toLowerCase() === "explorer" ? host.explorerFolder(selected.windowId) : void 0;
      return {
        appName: selected.appName,
        ...selected.windowTitle === "" ? {} : { windowTitle: selected.windowTitle },
        ...folder === void 0 ? {} : { finderFolder: folder },
        ...selected.focused ? {} : { focusNote: UNFOCUSED_WINDOW_NOTE }
      };
    },
    async listApps(signal) {
      signal?.throwIfAborted();
      return (await use()).listWindowApps();
    },
    async openApp(input, signal) {
      signal?.throwIfAborted();
      const host = await use();
      if (host.activateApp(input.name)) return {
        kind: "activated",
        name: input.name
      };
      host.launch(input.name);
      return {
        kind: "launched",
        name: input.name
      };
    },
    async click(input, signal) {
      const host = await use();
      assertInput(host);
      await clickAt(host, input.button, input.count, pointOf(input.position, input.screen), liveSignal(signal));
    },
    async typeText(input, signal) {
      const host = await use();
      assertInput(host);
      const abort = liveSignal(signal);
      await clickAt(host, "left", 1, pointOf(input.position, input.screen), abort);
      if (input.replace) await chord(host, [postedVk(17), postedVk(65)], abort);
      const previous = host.readClipboardText();
      try {
        host.setClipboardText(input.text);
        await delay(CLIPBOARD_SETTLE_MS, abort);
        await chord(host, [postedVk(17), postedVk(86)], abort);
        await delay(PASTE_SETTLE_MS, abort);
        if (input.submit) {
          await delay(CLIPBOARD_SETTLE_MS, abort);
          await chord(host, [postedVk(13)], abort);
        }
      } finally {
        host.setClipboardText(previous);
      }
    },
    async scroll(input, signal) {
      const host = await use();
      assertInput(host);
      const point = pointOf(input.position, input.screen);
      const abort = liveSignal(signal);
      const step = (input.direction === "up" ? 1 : -1) * SCROLL_NOTCH;
      for (let index = 0; index < input.scrollLevel; index += 1) {
        host.scrollWheel(point.x, point.y, step);
        await delay(SCROLL_STEP_MS, abort);
      }
    },
    async hotkey(input, signal) {
      signal?.throwIfAborted();
      const host = await use();
      restoreObservedFocus(host, observed);
      assertInput(host);
      await chord(host, input.keys.map(postedKey), liveSignal(signal));
    },
    async longPress(input, signal) {
      const host = await use();
      assertInput(host);
      const point = pointOf(input.position, input.screen);
      const abort = liveSignal(signal);
      host.movePointer(point.x, point.y);
      await delay(POINTER_MOVE_SETTLE_MS, abort);
      host.mouseButton("left", true);
      try {
        await delay(Math.round(input.durationSeconds * 1e3), abort);
      } finally {
        host.mouseButton("left", false);
      }
    },
    async drag(input, signal) {
      const host = await use();
      assertInput(host);
      const start = pointOf(input.startPosition, input.startScreen);
      const end = pointOf(input.endPosition, input.endScreen);
      const abort = liveSignal(signal);
      host.movePointer(start.x, start.y);
      await delay(POINTER_MOVE_SETTLE_MS, abort);
      host.mouseButton("left", true);
      await delay(BUTTON_HOLD_MS, abort);
      for (let step = 1; step <= DRAG_STEPS; step += 1) {
        const t = step / DRAG_STEPS;
        host.movePointer(Math.round(start.x + (end.x - start.x) * t), Math.round(start.y + (end.y - start.y) * t));
        await delay(DRAG_STEP_MS, abort);
      }
      host.mouseButton("left", false);
    },
    async openInBrowser(input, signal) {
      signal?.throwIfAborted();
      (await use()).launch(input.url ?? "https://");
    },
    async openInFinder(input, signal) {
      signal?.throwIfAborted();
      const host = await use();
      if (input.revealOnly) host.launch("explorer.exe", `/select,"${input.path}"`);
      else host.launch(input.path);
    },
    async copyImageToClipboard(input, signal) {
      signal?.throwIfAborted();
      (await use()).copyImageFile(input.path);
    }
  };
}
function createPlatformBackend(platform = process.platform, excludedRegionCapture) {
  if (platform === "darwin") return createMacosDesktopBackend(void 0, excludedRegionCapture);
  if (platform === "win32") return createWindowsDesktopBackend();
  return createUnsupportedDesktopBackend();
}
var captureExclude, COORDINATE_SPACE, META_KEYS, SHIFT_KEYS, SCREENSHOT_KEYS, CLICK_MODIFIER_KIND, execFileAsync, SCREENCAPTURE, OSASCRIPT, OPEN, LIST_APPS_SCRIPT, FINDER_FOLDER_SCRIPT, DEFAULT_BROWSER_SCRIPT, CROSS_PID_TRANSIENT_LAYERS, CHROME_WINDOW_LAYERS, CHROME_WINDOW_OWNERS, KEY_CODES, HID_RUNTIME, PASTEBOARD_TYPE, UNSUPPORTED_DESKTOP_MESSAGE, SHELL_CLASSES, CROSS_PID_TRANSIENT_CLASSES, ELEVATED_WINDOW, KEY_NAMES, EXTENDED_KEY_NAMES, MODIFIER_VKS, POINTER_MOVE_SETTLE_MS, BUTTON_HOLD_MS, DOUBLE_CLICK_GAP_MS, DRAG_STEPS, DRAG_STEP_MS, SCROLL_NOTCH, SCROLL_STEP_MS, MODIFIER_GAP_MS, CLIPBOARD_SETTLE_MS, PASTE_SETTLE_MS, productionOps, FOCUS_NOTE, UNFOCUSED_WINDOW_NOTE, FOCUS_FALLBACK_FOREGROUND;
var init_backend_18yEf5Jq = __esm({
  "vendor/computer-use/backend-18yEf5Jq.js"() {
    captureExclude = new AsyncLocalStorage();
    COORDINATE_SPACE = 1e3;
    META_KEYS = /* @__PURE__ */ new Set([
      "cmd",
      "command",
      "meta",
      "win",
      "windows",
      "super"
    ]);
    SHIFT_KEYS = /* @__PURE__ */ new Set(["shift"]);
    SCREENSHOT_KEYS = /* @__PURE__ */ new Set([
      "3",
      "4",
      "5"
    ]);
    CLICK_MODIFIER_KIND = {
      shift: "shift",
      cmd: "cmd",
      command: "cmd",
      meta: "cmd",
      win: "cmd",
      windows: "cmd",
      super: "cmd",
      option: "option",
      alt: "option",
      control: "control",
      ctrl: "control"
    };
    execFileAsync = promisify(execFile);
    SCREENCAPTURE = "/usr/sbin/screencapture";
    OSASCRIPT = "/usr/bin/osascript";
    OPEN = "/usr/bin/open";
    LIST_APPS_SCRIPT = `ObjC.import('AppKit')
const apps = $.NSWorkspace.sharedWorkspace.runningApplications.js
const names = []
const seen = {}
for (var i = 0; i < apps.length; i++) {
  var app = apps[i]
  if (app.activationPolicy !== 0) continue
  var name = ObjC.unwrap(app.localizedName)
  if (typeof name !== 'string') continue
  name = name.trim()
  if (name.length === 0 || seen[name]) continue
  seen[name] = true
  names.push(name)
}
JSON.stringify(names)
`;
    FINDER_FOLDER_SCRIPT = `tell application "Finder"
    try
        return POSIX path of (target of front window as alias)
    on error
        return ""
    end try
end tell
`;
    DEFAULT_BROWSER_SCRIPT = `ObjC.import('AppKit')
const url = $.NSURL.URLWithString('https:')
const appUrl = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url)
if (!appUrl) {
  JSON.stringify(null)
} else {
  const id = $.NSBundle.bundleWithURL(appUrl).bundleIdentifier
  const unwrapped = id ? ObjC.unwrap(id) : ''
  JSON.stringify(typeof unwrapped === 'string' && unwrapped.length > 0 ? unwrapped : null)
}
`;
    CROSS_PID_TRANSIENT_LAYERS = [101];
    CHROME_WINDOW_LAYERS = [20, 24];
    CHROME_WINDOW_OWNERS = [
      "Dock",
      "\u7A0B\u5E8F\u575E",
      "Control Center",
      "\u63A7\u5236\u4E2D\u5FC3",
      "Notification Center",
      "Notification Centre",
      "\u901A\u77E5\u4E2D\u5FC3",
      "Wallpaper",
      "\u5899\u7EB8"
    ];
    KEY_CODES = {
      a: 0,
      s: 1,
      d: 2,
      f: 3,
      h: 4,
      g: 5,
      z: 6,
      x: 7,
      c: 8,
      v: 9,
      b: 11,
      q: 12,
      w: 13,
      e: 14,
      r: 15,
      y: 16,
      t: 17,
      "1": 18,
      "2": 19,
      "3": 20,
      "4": 21,
      "6": 22,
      "5": 23,
      equal: 24,
      "=": 24,
      "9": 25,
      "7": 26,
      minus: 27,
      "-": 27,
      "8": 28,
      "0": 29,
      "]": 30,
      o: 31,
      u: 32,
      "[": 33,
      i: 34,
      p: 35,
      enter: 36,
      return: 36,
      l: 37,
      j: 38,
      quote: 39,
      "'": 39,
      k: 40,
      ";": 41,
      "\\": 42,
      ",": 43,
      "/": 44,
      n: 45,
      m: 46,
      ".": 47,
      tab: 48,
      space: 49,
      "`": 50,
      backspace: 51,
      delete: 51,
      escape: 53,
      esc: 53,
      cmd: 55,
      command: 55,
      meta: 55,
      win: 55,
      windows: 55,
      super: 55,
      shift: 56,
      capslock: 57,
      option: 58,
      alt: 58,
      control: 59,
      ctrl: 59,
      fn: 63,
      f17: 64,
      f18: 79,
      f19: 80,
      f20: 90,
      f5: 96,
      f6: 97,
      f7: 98,
      f3: 99,
      f8: 100,
      f9: 101,
      f11: 103,
      f13: 105,
      f16: 106,
      f14: 107,
      f10: 109,
      f12: 111,
      f15: 113,
      home: 115,
      pageup: 116,
      end: 119,
      f2: 120,
      pagedown: 121,
      f1: 122,
      left: 123,
      right: 124,
      down: 125,
      up: 126
    };
    HID_RUNTIME = `
ObjC.import('Cocoa')
const HID = 0
const SRC = $.CGEventSourceCreate(1)
const LEFT_DOWN = 1
const LEFT_UP = 2
const RIGHT_DOWN = 3
const RIGHT_UP = 4
const MOVE = 5
const LEFT_DRAGGED = 6
const LEFT = 0
const RIGHT = 1
const CLICK_STATE = 1
const FLAG_SHIFT = 0x00020000
const FLAG_CTRL = 0x00040000
const FLAG_ALT = 0x00080000
const FLAG_CMD = 0x00100000
const FLAG_FN = 0x00008000
const KEY_CMD = 55
const KEY_SHIFT = 56
const KEY_OPTION = 58
const KEY_CONTROL = 59
const KEY_FN = 63
const KEY_A = 0
const KEY_V = 9
const KEY_ENTER = 36
function sleep(ms) {
  $.NSThread.sleepForTimeInterval(ms / 1000)
}
function postMouse(type, x, y, button, clickState, flags) {
  const event = $.CGEventCreateMouseEvent(SRC, type, $.CGPointMake(x, y), button)
  if (clickState) $.CGEventSetIntegerValueField(event, CLICK_STATE, clickState)
  if (flags) $.CGEventSetFlags(event, flags)
  $.CGEventPost(HID, event)
}
function clickAt(x, y, button, count, flags) {
  flags = flags || 0
  const down = button === RIGHT ? RIGHT_DOWN : LEFT_DOWN
  const up = button === RIGHT ? RIGHT_UP : LEFT_UP
  postMouse(MOVE, x, y, button, 0, flags)
  sleep(80)
  for (var i = 1; i <= count; i++) {
    postMouse(down, x, y, button, i, flags)
    sleep(50)
    postMouse(up, x, y, button, i, flags)
    if (i < count) sleep(100)
  }
}
function clickWithModifiers(x, y, button, count, codes) {
  var flags = 0
  var mods = []
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i]
    if (code === KEY_CMD) { flags |= FLAG_CMD; mods.push(code) }
    else if (code === KEY_SHIFT) { flags |= FLAG_SHIFT; mods.push(code) }
    else if (code === KEY_OPTION) { flags |= FLAG_ALT; mods.push(code) }
    else if (code === KEY_CONTROL) { flags |= FLAG_CTRL; mods.push(code) }
  }
  for (var m = 0; m < mods.length; m++) postKey(mods[m], true, flags)
  sleep(20)
  clickAt(x, y, button, count, flags)
  for (var r = mods.length - 1; r >= 0; r--) postKey(mods[r], false, 0)
  sleep(20)
}
function postKey(code, down, flags) {
  const event = $.CGEventCreateKeyboardEvent(SRC, code, down)
  $.CGEventSetFlags(event, flags)
  $.CGEventPost(HID, event)
}
function tapKey(code, flags) {
  postKey(code, true, flags)
  sleep(20)
  postKey(code, false, flags)
  sleep(15)
}
function chord(codes) {
  var flags = 0
  var mods = []
  var keys = []
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i]
    if (code === KEY_CMD) { flags |= FLAG_CMD; mods.push(code) }
    else if (code === KEY_SHIFT) { flags |= FLAG_SHIFT; mods.push(code) }
    else if (code === KEY_OPTION) { flags |= FLAG_ALT; mods.push(code) }
    else if (code === KEY_CONTROL) { flags |= FLAG_CTRL; mods.push(code) }
    else if (code === KEY_FN) { flags |= FLAG_FN; mods.push(code) }
    else keys.push(code)
  }
  for (var m = 0; m < mods.length; m++) postKey(mods[m], true, flags)
  sleep(20)
  if (keys.length === 0) {
    for (var t = mods.length - 1; t >= 0; t--) postKey(mods[t], false, 0)
    return
  }
  for (var k = 0; k < keys.length; k++) tapKey(keys[k], flags)
  for (var r = mods.length - 1; r >= 0; r--) postKey(mods[r], false, 0)
  sleep(20)
}
function clipboardString() {
  var value = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString)
  if (!value) return ''
  try {
    var unwrapped = ObjC.unwrap(value)
    return typeof unwrapped === 'string' ? unwrapped : ''
  } catch (error) {
    // Nil NSPasteboard string unwraps by throwing in JXA; treat as empty.
    return ''
  }
}
function clearPasteboard(pb) {
  // JXA invokes no-arg ObjC methods on property access; calling this as a JS
  // function would invoke the NSInteger return value.
  var discarded = pb.clearContents
}
function pasteText(text) {
  var pb = $.NSPasteboard.generalPasteboard
  var previous = clipboardString()
  clearPasteboard(pb)
  pb.setStringForType($.NSString.stringWithString(text), $.NSPasteboardTypeString)
  chord([KEY_CMD, KEY_V])
  sleep(80)
  clearPasteboard(pb)
  pb.setStringForType($.NSString.stringWithString(previous), $.NSPasteboardTypeString)
}
function selectAll() {
  chord([KEY_CMD, KEY_A])
}
function pressEnter() {
  tapKey(KEY_ENTER, 0)
}
function scrollAt(x, y, dy) {
  postMouse(MOVE, x, y, LEFT, 0)
  sleep(40)
  var step = dy < 0 ? -1 : 1
  var n = Math.abs(dy)
  if (n < 1) n = 1
  for (var i = 0; i < n; i++) {
    var event = $.CGEventCreateScrollWheelEvent2(SRC, 1, 1, step, 0, 0)
    $.CGEventSetLocation(event, $.CGPointMake(x, y))
    $.CGEventPost(HID, event)
    sleep(20)
  }
}
function longPressAt(x, y, durationMs) {
  postMouse(MOVE, x, y, LEFT, 0)
  sleep(80)
  postMouse(LEFT_DOWN, x, y, LEFT, 1)
  sleep(durationMs)
  postMouse(LEFT_UP, x, y, LEFT, 1)
}
function dragFromTo(x1, y1, x2, y2) {
  postMouse(MOVE, x1, y1, LEFT, 0)
  sleep(80)
  postMouse(LEFT_DOWN, x1, y1, LEFT, 1)
  sleep(50)
  var steps = 10
  for (var i = 1; i <= steps; i++) {
    var t = i / steps
    postMouse(LEFT_DRAGGED, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, LEFT, 1)
    sleep(20)
  }
  postMouse(LEFT_UP, x2, y2, LEFT, 1)
}
`.trim();
    PASTEBOARD_TYPE = {
      "image/png": "public.png",
      "image/jpeg": "public.jpeg",
      "image/gif": "com.compuserve.gif",
      "image/webp": "org.webmproject.webp"
    };
    UNSUPPORTED_DESKTOP_MESSAGE = "computer-use: desktop control is implemented only on macOS and Windows";
    SHELL_CLASSES = /* @__PURE__ */ new Set([
      "Shell_TrayWnd",
      "Shell_SecondaryTrayWnd",
      "Progman",
      "WorkerW"
    ]);
    CROSS_PID_TRANSIENT_CLASSES = /* @__PURE__ */ new Set(["#32768", "ComboLBox"]);
    ELEVATED_WINDOW = "computer-use: the foreground window is running elevated, so this process cannot click or type into it";
    KEY_NAMES = {
      ctrl: 17,
      control: 17,
      alt: 18,
      option: 18,
      shift: 16,
      win: 91,
      windows: 91,
      meta: 91,
      cmd: 91,
      command: 91,
      super: 91,
      enter: 13,
      return: 13,
      tab: 9,
      escape: 27,
      esc: 27,
      space: 32,
      backspace: 8,
      delete: 46,
      del: 46,
      up: 38,
      down: 40,
      left: 37,
      right: 39,
      home: 36,
      end: 35,
      pageup: 33,
      pagedown: 34,
      insert: 45
    };
    EXTENDED_KEY_NAMES = /* @__PURE__ */ new Set([
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "pageup",
      "pagedown",
      "insert",
      "delete",
      "del"
    ]);
    MODIFIER_VKS = /* @__PURE__ */ new Set([
      16,
      17,
      18,
      91,
      92
    ]);
    POINTER_MOVE_SETTLE_MS = 80;
    BUTTON_HOLD_MS = 50;
    DOUBLE_CLICK_GAP_MS = 100;
    DRAG_STEPS = 10;
    DRAG_STEP_MS = 20;
    SCROLL_NOTCH = 120;
    SCROLL_STEP_MS = 20;
    MODIFIER_GAP_MS = 20;
    CLIPBOARD_SETTLE_MS = 30;
    PASTE_SETTLE_MS = 80;
    FOCUS_NOTE = "Keyboard focus is not on an operable app. Click the target window first if the next step needs focus.";
    UNFOCUSED_WINDOW_NOTE = "Keyboard focus is on another window. hotkey brings this window forward first; click inside it if focus must land on a specific control.";
    FOCUS_FALLBACK_FOREGROUND = {
      appName: "none",
      focusNote: FOCUS_NOTE
    };
  }
});

// vendor/computer-use/index.js
init_backend_18yEf5Jq();
import * as fs from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";

// src/cu-peer.mjs
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
function profileNodeModules() {
  const out = [];
  try {
    const profiles = join2(process.env.DSH_HOME || join2(homedir(), ".dsh"), "profiles");
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      out.push(join2(profiles, entry.name, "node_modules"));
    }
  } catch {
  }
  return out;
}
function bases() {
  const out = [];
  const resources = typeof process !== "undefined" ? process.resourcesPath : "";
  if (resources) {
    out.push(join2(resources, "app.asar", "dsh", "node_modules"));
    out.push(join2(resources, "app.asar", "node_modules"));
    out.push(join2(resources, "app", "dsh", "node_modules"));
    out.push(join2(resources, "app", "node_modules"));
  }
  out.push(...profileNodeModules());
  out.push(join2(process.cwd(), "node_modules"));
  return out;
}
var cache = /* @__PURE__ */ new Map();
function resolvePeer(name2) {
  for (const base of bases()) {
    try {
      return createRequire(pathToFileURL(pathResolve(base, "__dsh_probe__.js")).href).resolve(name2);
    } catch {
    }
  }
  return "";
}
async function loadPeer(name2) {
  if (cache.has(name2)) return cache.get(name2);
  const resolved = resolvePeer(name2);
  if (!resolved) {
    throw new Error(`dsh-assistant: \u627E\u4E0D\u5230\u5BBF\u4E3B\u6A21\u5757 ${name2}\uFF08Computer Use \u5DE5\u5177\u9700\u8981\u7531 DSH \u5BBF\u4E3B\u52A0\u8F7D\uFF09`);
  }
  const mod = await import(pathToFileURL(resolved).href);
  cache.set(name2, mod);
  return mod;
}

// src/cu-shims/schemastery.mjs
var m = await loadPeer("@deepseek-ai/schemastery");
var schemastery_default = m.default ?? m;

// src/cu-shims/dsh-llm.mjs
var m2 = await loadPeer("@deepseek-ai/dsh-llm");
var createUserMessage = m2.createUserMessage;
var boundContextSummary = m2.boundContextSummary;

// src/cu-shims/dsh-tools.mjs
var m3 = await loadPeer("@deepseek-ai/dsh-tools");
var defineTool = m3.defineTool;

// src/cu-shims/dsh-session.mjs
var m4 = await loadPeer("@deepseek-ai/dsh-session");
var KNOWN_SESSION_EVENT_TYPES = m4.KNOWN_SESSION_EVENT_TYPES;
var Session = m4.Session;
var SessionId = m4.SessionId;

// vendor/computer-use/index.js
import { z as z$1 } from "zod";

// src/cu-shims/dsh-attachment.mjs
var m5 = await loadPeer("@deepseek-ai/dsh-attachment");
var AttachmentId = m5.AttachmentId;

// vendor/computer-use/index.js
var Config = schemastery_default.object({ postActionWaitMs: schemastery_default.number().default(600) });
function requireFiniteNonNegative(value, name2) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name2} must be a finite number \u2265 0`);
  return value;
}
function resolveComputerUseConfig(config = {}) {
  return { postActionWaitMs: requireFiniteNonNegative(config.postActionWaitMs ?? 600, "postActionWaitMs") };
}
function captureExcludeIds(session) {
  return session?.excludeWindowIds ?? [];
}
function wrapDesktopBackend(inner, guard) {
  return {
    withGuiTurn: (run, signal) => guard.withInput(() => inner.withGuiTurn(run, signal), signal),
    listScreens: (signal) => guard.withCapture((session) => runWithCaptureExcludeWindowIds(captureExcludeIds(session), async () => {
      const screens = await inner.listScreens(signal);
      if (signal?.aborted) {
        try {
          await guard.setObservationFrame(null);
        } catch {
        }
        signal.throwIfAborted();
      }
      await guard.setObservationFrame(screens[0]?.bounds ?? null, signal);
      return screens;
    }), signal),
    capture: (screen, signal) => guard.withCapture((session) => runWithCaptureExcludeWindowIds(captureExcludeIds(session), () => inner.capture(screen, signal)), signal),
    inspectForeground: (signal) => guard.withCapture((session) => runWithCaptureExcludeWindowIds(captureExcludeIds(session), () => inner.inspectForeground(signal)), signal),
    listApps: (signal) => inner.listApps(signal),
    openApp: (input, signal) => guard.withInput(() => inner.openApp(input, signal), signal),
    click: (input, signal) => guard.withInput(() => inner.click(input, signal), signal),
    typeText: (input, signal) => guard.withInput(() => inner.typeText(input, signal), signal),
    scroll: (input, signal) => guard.withInput(() => inner.scroll(input, signal), signal),
    hotkey: (input, signal) => guard.withInput(() => inner.hotkey(input, signal), signal),
    longPress: (input, signal) => guard.withInput(() => inner.longPress(input, signal), signal),
    drag: (input, signal) => guard.withInput(() => inner.drag(input, signal), signal),
    openInBrowser: (input, signal) => inner.openInBrowser(input, signal),
    openInFinder: (input, signal) => inner.openInFinder(input, signal),
    copyImageToClipboard: (input, signal) => inner.copyImageToClipboard(input, signal)
  };
}
var COORDINATE_MODE_STATE_SCHEMA = z$1.object({ mode: z$1.enum(["millifraction", "pixel"]) }).strict();
function isCoordinateModeEvent(event) {
  return event?.type === "computer-use/coordinate-mode" || event?.type === "plugin:computer-use/coordinate-mode";
}
var coordinateModeProjection = {
  key: "computerUseCoordinateMode",
  stateVersion: 1,
  stateSchema: COORDINATE_MODE_STATE_SCHEMA,
  init: () => ({ mode: "millifraction" }),
  apply: (state, event) => {
    if (!isCoordinateModeEvent(event)) return state;
    if (event.data.mode === state.mode) return state;
    return { mode: event.data.mode };
  }
};
var observationCache = /* @__PURE__ */ new WeakMap();
var sessionModeCache = /* @__PURE__ */ new WeakMap();
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function lastRasterIn(value) {
  if (Array.isArray(value)) {
    let found2;
    for (const entry of value) {
      const raster = lastRasterIn(entry);
      if (raster !== void 0) found2 = raster;
    }
    return found2;
  }
  if (!isRecord(value)) return void 0;
  if (value.type === "image" && isRecord(value.attachment)) {
    const width = value.attachment.width;
    const height = value.attachment.height;
    if (typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return {
      width,
      height
    };
  }
  let found;
  for (const nested of Object.values(value)) {
    const raster = lastRasterIn(nested);
    if (raster !== void 0) found = raster;
  }
  return found;
}
function reconstructFromLog(session) {
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === void 0) continue;
    if (event.type === "user/message") {
      const source = event.data.source;
      if (source.kind !== "computer-use" || source.form !== "notice") continue;
      const raster = lastRasterIn(event.data.content);
      if (raster !== void 0) return raster;
    }
    if (event.type === "tool/result") {
      const raster = lastRasterIn(event.data.message.content);
      if (raster !== void 0) return raster;
    }
  }
}
function loggedCoordinateMode(session) {
  const events = session?.snapshotEvents?.();
  if (events === void 0) return void 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isCoordinateModeEvent(event)) return event.data.mode;
  }
}
function coordinateModeOf(session) {
  return loggedCoordinateMode(session) ?? (session === void 0 ? void 0 : sessionModeCache.get(session)) ?? "millifraction";
}
function rememberObservation(session, screens) {
  if (session === void 0) return;
  const first = screens[0]?.image;
  observationCache.set(session, first === void 0 ? false : {
    width: first.width,
    height: first.height
  });
}
function lastAttachedRaster(session) {
  if (session === void 0) return void 0;
  const cached = observationCache.get(session);
  if (cached === false) return void 0;
  if (cached !== void 0) return cached;
  if (typeof session.snapshotEvents !== "function") return void 0;
  const reconstructed = reconstructFromLog(session);
  observationCache.set(session, reconstructed === void 0 ? false : reconstructed);
  return reconstructed;
}
function coordinateOutcome(session, screens) {
  const mode = coordinateModeOf(session);
  const first = screens[0]?.image;
  if (mode === "pixel" && first !== void 0) return {
    coordinateMode: mode,
    attachedWidth: first.width,
    attachedHeight: first.height
  };
  return { coordinateMode: mode };
}
function coordinatesRemain(outcome) {
  if (outcome.coordinateMode === "pixel") {
    if (outcome.attachedWidth !== void 0 && outcome.attachedHeight !== void 0) return `Coordinates remain pixels of the attached ${String(outcome.attachedWidth)}x${String(outcome.attachedHeight)} screenshot.`;
    return "Coordinates remain pixels of the attached screenshot.";
  }
  return "Coordinates remain 0\u20131000.";
}
function firstFrameNotice(mode) {
  if (mode === "pixel") return "Current frontmost window. Coordinates are pixel columns and rows of this screenshot ([0, 0] top-left). Use attached_size on the observation envelope. Do not send 0\u20131000 fractions.";
  return "Current frontmost window. Coordinates are 0\u20131000 fractions of this screenshot ([0, 0] top-left, [1000, 1000] bottom-right). Center x is 500, not a pixel x.";
}
var PIXEL_POSITION = "[x, y] as pixel columns and rows of the attached screenshot named on that observation, not a 0\u20131000 fraction.";
var PIXEL_TOOLS = {
  click: {
    description: "Click at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. Use left (default) or right button; count 2 is a double-click. Optional modifiers (shift, cmd, option, control) are held only for this click.",
    parameters: { position: PIXEL_POSITION }
  },
  input_text: {
    description: "Click to focus a pixel position on the attached frontmost-window screenshot, type text, optionally replace existing content and press Enter, then return the post-action screenshot.",
    parameters: { position: `${PIXEL_POSITION} The click focuses the field.` }
  },
  scroll: {
    description: "Scroll up or down at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. scroll_level is 1\u201310.",
    parameters: { position: PIXEL_POSITION }
  },
  long_press: {
    description: "Press and hold the left button at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. duration_seconds defaults to 3 and must be 1\u201310.",
    parameters: { position: PIXEL_POSITION }
  },
  drag: {
    description: "Drag from a start pixel position to an end pixel position on the attached frontmost-window screenshot, then return the post-action screenshot.",
    parameters: {
      start_position: "[x, y] start as pixel columns and rows of the attached screenshot named on that observation, not a 0\u20131000 fraction.",
      end_position: "[x, y] end as pixel columns and rows of the attached screenshot named on that observation, not a 0\u20131000 fraction."
    }
  }
};
function rewritePixelTool(tool) {
  const copy = PIXEL_TOOLS[tool.name];
  if (copy === void 0) return tool;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties;
  if (isRecord(properties)) for (const [name2, description] of Object.entries(copy.parameters)) {
    const field = properties[name2];
    if (isRecord(field)) field.description = description;
  }
  return {
    ...tool,
    description: copy.description,
    parameters
  };
}
function toolsForCoordinateMode(tools, mode) {
  if (mode === "millifraction") return [...tools];
  return tools.map(rewritePixelTool);
}
function hasCoordinateModeEvent(session) {
  return session.snapshotEvents().some((event) => isCoordinateModeEvent(event));
}
function hasEndSeed(session) {
  return session.snapshotEvents().some((event) => event.type === "session/end-seed");
}
function appendCoordinateMode(session, mode, ignorable) {
  if (!ignorable) return session.append("computer-use/coordinate-mode", { mode });
  return session.append.call(session, "computer-use/coordinate-mode", { mode }, { ignorable: true });
}
function resolveStampCapability() {
  if (KNOWN_SESSION_EVENT_TYPES.has("computer-use/coordinate-mode")) return "catalog";
  try {
    return appendCoordinateMode(Session.create(SessionId("dsh-orb-coordinate-mode-probe")), "millifraction", true).ignorable === true ? "ignorable" : "none";
  } catch {
    return "none";
  }
}
function stampCoordinateMode(ctx, session) {
  if (hasCoordinateModeEvent(session) || hasEndSeed(session)) return;
  const service = ctx.get("orbCoordinateMode");
  if (service === void 0) return;
  const mode = service.currentMode();
  sessionModeCache.set(session, mode);
  const capability = resolveStampCapability();
  if (capability === "catalog") {
    appendCoordinateMode(session, mode, false);
    return;
  }
  if (capability === "ignorable") appendCoordinateMode(session, mode, true);
}
function installCoordinateMode(ctx) {
  const projections = ctx.get("sessionProjections");
  if (projections !== void 0) projections.register(coordinateModeProjection);
  else ctx.inject(["sessionProjections"], (scoped) => {
    scoped.sessionProjections.register(coordinateModeProjection);
  });
  ctx.on("agent/created", ({ agent }) => {
    stampCoordinateMode(ctx, agent.session);
  });
}
var PATH_BLACKLIST = [
  "/System",
  "/private",
  "/etc",
  "/var",
  "/usr",
  "/sbin",
  "/bin",
  "/dev",
  "/proc",
  "/sys"
];
var MULTIBYTE_UTF8_PERCENT = /%(?:[Cc][2-9A-Fa-f]|[Dd][0-9A-Fa-f]|[Ee][0-9A-Fa-f]|[Ff][0-7])(?:%[0-9A-Fa-f]{2})+/u;
function isForbiddenOpenPath(resolved) {
  return PATH_BLACKLIST.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`));
}
function requireLongPressDuration(value) {
  const duration = value ?? 3;
  if (!Number.isFinite(duration) || duration < 1 || duration > 10) throw new Error("duration_seconds must be a number from 1 to 10");
  return duration;
}
function urlPathAndQuery(rawUrl) {
  const afterScheme = (/^https?:\/\//iu.test(rawUrl) ? rawUrl : `https://${rawUrl}`).replace(/^https?:\/\//iu, "");
  const pathStart = afterScheme.search(/[/?#]/u);
  return pathStart < 0 ? "" : afterScheme.slice(pathStart);
}
function browserUrlHasCjkPercentEncoding(rawUrl) {
  const trimmed = rawUrl.trim();
  if (trimmed === "") return false;
  return MULTIBYTE_UTF8_PERCENT.test(urlPathAndQuery(trimmed));
}
function requireBrowserUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  if (trimmed === "") throw new Error("url must be a non-empty http(s) URL when provided");
  if (browserUrlHasCjkPercentEncoding(trimmed)) throw new Error("url path and query must use plain CJK text, not percent-encoding such as %E5... / %E8...");
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== void 0 && scheme !== "http" && scheme !== "https") throw new Error("url must be an http(s) URL");
  const withScheme = scheme === void 0 ? `https://${trimmed}` : trimmed;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("url must be a valid http(s) URL");
  }
  if (parsed.username !== "" || parsed.password !== "") throw new Error("url must not include userinfo");
  return withScheme;
}
async function resolveFinderOpen(path, revealOnly, home = homedir2()) {
  const trimmed = path === void 0 ? "" : path.trim();
  const expanded = trimmed === "" || trimmed === "~" ? join3(home, "Desktop") : trimmed.startsWith("~/") ? join3(home, trimmed.slice(2)) : trimmed;
  if (isForbiddenOpenPath(expanded)) throw new Error(`computer-use: opening a system path is forbidden: ${expanded}`);
  let resolved;
  try {
    resolved = await realpath(expanded);
  } catch (error) {
    throw new Error(`computer-use: path does not exist: ${expanded} (${String(error)})`);
  }
  if (isForbiddenOpenPath(resolved)) throw new Error(`computer-use: opening a system path is forbidden: ${resolved}`);
  return {
    path: resolved,
    revealOnly
  };
}
var IMAGE_NAME_PREFIX = "desktop-screen";
function isObservationAbort(error, signal) {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}
function optionalImageFields(image) {
  return {
    ...image.name === void 0 ? {} : { name: image.name },
    ...image.originalDimensions === void 0 ? {} : { originalDimensions: { ...image.originalDimensions } }
  };
}
function imageRefFromObserved(image) {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...optionalImageFields(image)
  };
}
function envelopeValue(value) {
  return value.replace(/[\r\n]+/g, " ").trim();
}
function formatForegroundEnvelope(foreground) {
  const lines = [`<frontmost_app>${envelopeValue(foreground.appName) || "none"}</frontmost_app>`];
  if (foreground.windowTitle !== void 0) {
    const title = envelopeValue(foreground.windowTitle);
    if (title !== "") lines.push(`<frontmost_window>${title}</frontmost_window>`);
  }
  if (foreground.focusNote !== void 0) {
    const note = envelopeValue(foreground.focusNote);
    if (note !== "") lines.push(`<focus_note>${note}</focus_note>`);
    return lines.join("\n");
  }
  if (foreground.finderFolder !== void 0) {
    const folder = envelopeValue(foreground.finderFolder);
    if (folder !== "") lines.push(`<frontmost_folder>${folder}</frontmost_folder>`);
  }
  return lines.join("\n");
}
function compactForeground(foreground) {
  return {
    appName: foreground.appName,
    ...foreground.windowTitle === void 0 ? {} : { windowTitle: foreground.windowTitle },
    ...foreground.finderFolder === void 0 ? {} : { finderFolder: foreground.finderFolder },
    ...foreground.focusNote === void 0 ? {} : { focusNote: foreground.focusNote }
  };
}
function formatScreenEnvelope(screen, mode = "millifraction") {
  if (mode === "pixel") return `<screen_index>${String(screen.screenIndex)}</screen_index>
<coordinate_space>pixels</coordinate_space>
<attached_size>${String(screen.image.width)}x${String(screen.image.height)}</attached_size>`;
  return `<screen_index>${String(screen.screenIndex)}</screen_index>
<coordinate_space>0-1000</coordinate_space>`;
}
function observationBlocks(screens, mode = "millifraction") {
  const blocks = [];
  for (const screen of screens) {
    blocks.push({
      type: "text",
      text: formatScreenEnvelope(screen, mode)
    });
    blocks.push({
      type: "image",
      attachment: imageRefFromObserved(screen.image)
    });
  }
  return blocks;
}
function observationContent(screens, foreground, mode = "millifraction") {
  return [{
    type: "text",
    text: formatForegroundEnvelope(foreground)
  }, ...observationBlocks(screens, mode)];
}
async function observeDesktop(ctx, backend, signal, options = {}) {
  signal.throwIfAborted();
  const settleMs = options.settleMs ?? 0;
  if (settleMs > 0) await delay(settleMs, signal);
  const selected = (await backend.listScreens(signal)).slice(0, 1);
  let foreground = FOCUS_FALLBACK_FOREGROUND;
  try {
    foreground = await backend.inspectForeground(signal);
  } catch (error) {
    if (isObservationAbort(error, signal)) throw error;
  }
  const screens = [];
  const captures = [];
  const persistCapture = options.persistCapture;
  for (const screen of selected) {
    signal.throwIfAborted();
    const captured = await backend.capture(screen, signal);
    captures.push(captured);
    if (persistCapture !== void 0 && !persistCapture(captured)) continue;
    const saved = await ctx.attachments.saveImage({
      data: captured.data,
      mediaType: captured.mediaType,
      name: `${IMAGE_NAME_PREFIX}-${String(screen.index)}`
    });
    screens.push({
      screenIndex: screen.index,
      logicalWidth: screen.bounds.width,
      logicalHeight: screen.bounds.height,
      scale: screen.scale,
      image: {
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
        ...optionalImageFields(saved)
      }
    });
  }
  return {
    screens,
    foreground,
    blocks: observationContent(screens, foreground, options.coordinateMode ?? "millifraction"),
    captures
  };
}
function requireScreen(screens, screenIndex) {
  const screen = screens.find((candidate) => candidate.index === screenIndex);
  if (screen === void 0) {
    const last = screens.at(-1);
    const range = last === void 0 ? "none" : `0..${String(last.index)}`;
    throw new Error(`computer-use: screen_index ${String(screenIndex)} is out of range (${range})`);
  }
  return screen;
}
var PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
function viewOf(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function pngSize(data) {
  if (data.length < 24) return void 0;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) if (data[i] !== PNG_SIGNATURE[i]) return void 0;
  if (data[12] !== 73 || data[13] !== 72 || data[14] !== 68 || data[15] !== 82) return void 0;
  const view = viewOf(data);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) return void 0;
  return {
    width,
    height
  };
}
function isStartOfFrame(marker) {
  if (marker < 192 || marker > 207) return false;
  return marker !== 196 && marker !== 200 && marker !== 204;
}
function jpegSize(data) {
  if (data.length < 4 || data[0] !== 255 || data[1] !== 216) return void 0;
  const view = viewOf(data);
  let index = 2;
  while (index + 1 < data.length) {
    if (data[index] !== 255) return void 0;
    while (index < data.length && data[index] === 255) index += 1;
    if (index >= data.length) return void 0;
    const marker = view.getUint8(index);
    index += 1;
    if (marker === 217 || marker === 218) return void 0;
    if (marker === 216 || marker >= 208 && marker <= 215 || marker === 1) continue;
    if (index + 1 >= data.length) return void 0;
    const length = view.getUint16(index);
    if (length < 2 || index + length > data.length) return void 0;
    if (isStartOfFrame(marker)) {
      if (length < 7) return void 0;
      const height = view.getUint16(index + 3);
      const width = view.getUint16(index + 5);
      if (width < 1 || height < 1) return void 0;
      return {
        width,
        height
      };
    }
    index += length;
  }
}
function observationRasterSize(data) {
  return pngSize(data) ?? jpegSize(data);
}
function isUsableObservationRaster(data) {
  const size = observationRasterSize(data);
  return size !== void 0 && size.width >= 2 && size.height >= 2;
}
var POLICY_BEFORE_COORDINATES = `Computer Use lets you see the current frontmost application window and operate the GUI.

See: trust only the attached screenshot of the frontmost application on this display for windows, buttons, and on-screen text. The image includes that app's open menus, popovers, and panels. It does not include the Dock, menu bar, other applications (except where they overlap this app's windows), or other displays. Do not assume UI that is not visible in the latest image. You may use observation tags <frontmost_app>, <frontmost_window>, <frontmost_folder>, and <focus_note> as OS metadata.

`;
var MILLIFRACTION_COORDINATES = "Coordinates: the attached screenshot uses a 0\u20131000 space of that window. [0, 0] is the top-left of that image and [1000, 1000] is the bottom-right. x and y scale independently; do not treat the space as a square overlay. Pass position as [x, y] in that space together with screen_index 0. Encode x and y as fractions of this screenshot \xD7 1000 (center x is 500, not a pixel x). Ignore pixel widths and any other image-handle dimensions. Do not send raw pixel coordinates.";
var PIXEL_COORDINATES = "Coordinates: the attached screenshot uses pixel columns and rows of that image. [0, 0] is the top-left pixel. Pass position as [x, y] in that pixel space together with screen_index 0. Read attached_size on the latest observation envelope as width\xD7height of this screenshot; x runs 0 to that width and y runs 0 to that height. Do not send 0\u20131000 fractions. Ignore image-handle dimensions that are not on the Computer Use envelope.";
var POLICY_AFTER_COORDINATES = `

Step: you may emit several GUI tool calls in one step when every target is already visible in the latest screenshot and later calls do not need UI that earlier calls create. The host runs those calls in order. Each result includes its own post-action screenshot; after the step, use the last image for any action that depends on what changed. Do not batch a click, type, or hotkey whose target appears only after an earlier action in the same step (menu, dialog, new page, loader).

Do not click or type into a target you cannot see. Do not OCR file paths from the screenshot. When a file or folder path is known, call open_in_finder with that path; do not click Desktop icons to open it. When <frontmost_folder> is present, copy that path; otherwise use bash with real paths. When <focus_note> is present, call open_app to bring the target application forward if the next step needs a window. Do not click chrome that is not in the image.

If <frontmost_app> or the screenshot is not the application the user asked for, call list_apps or open_app. Do not click the Dock; it is not in the screenshot.

Observation is not a tool. After bash, search, or web_fetch, screenshot may refresh the frontmost window. After click, type, wait, or open, do not call screenshot again \u2014 those results already attach a window. Call screenshot when the user asked for a screenshot file or needs the image on the clipboard to paste.

This session drives the real unsandboxed desktop. Use bash for a command that answers the user or feeds the next click, including one more command when the first missed. When you are still digging through files or commands, hand that stretch to code_agent. Do not use bash open as a substitute for open_in_finder, open_in_browser, or open_app.

Open a site in the user's visible browser with open_in_browser. web_search and web_fetch return text to you; they do not open a window the user can see.

Drag sliders, window edges, and files with drag. Press and hold with long_press. Multi-select with click plus shift or cmd on each later click; do not hold a modifier across calls.

When the latest screenshot still shows a loader, spinner, or a control that has not appeared, call wait. After click or open, the tool result already has a new screenshot; do not immediately wait unless that image still shows loading. When the screenshot shows a long job still running (download, install, export, or in-window generation), call long_wait with the smallest of 10, 30, 60, or 120 that covers remaining progress. Do not use long_wait for ordinary page load.

Decide each stretch yourself:
- Do it in this chat when it is visible GUI, or when one search or one command will answer the user or feed the next click. A second search that you expect will hit the point stays here. Visible GUI such as opening WeChat or clicking a button in Pages \u2192 GUI tools only. Do not call code_agent. A short lookup such as today's weather or current headlines \u2192 web_search or web_fetch in this chat. Do not call code_agent or GUI tools.
- Hand the stretch to code_agent when you are still digging through files, searches, or commands. The last step being a click does not keep that investigation here: hand off the investigation, then click after the completion notice.
- A file, document, spreadsheet, or site, such as writing a Word document, a PPT, an Excel file, a website, or a research report (write the report as HTML) \u2192 code_agent without session_id.
- Follow-up on the same artifact such as making that Word document's font green, or another stretch of the same investigation \u2192 code_agent with the session_id from that earlier result.
- Unrelated new background work such as making a gobang game after the Word document \u2192 code_agent without session_id. Do not reuse the Word session.

Working directory for a new code_agent session:
- When the user names a path (Desktop, a home folder, or an absolute path) \u2192 pass that path as cwd.
- When the user says "here", "this folder", or "the current window" and <frontmost_folder> is present \u2192 pass that folder as cwd.
- When the user says "here", "this folder", or "the current window" and <frontmost_folder> is absent \u2192 do not call code_agent. Tell the user the frontmost window is not Finder, so the current folder path is unknown; they should click that Finder window or give a path.
- Otherwise omit cwd; the tool creates a new subdirectory under this session's workspace.

If the user's request names a folder or window that does not match the screenshot or <frontmost_folder>, ask_user_question in this chat. Do not guess. Do not fall back to this session's workspace.

After code_agent returns, tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need the background result; otherwise end the turn. Do not call wait, long_wait, or bash sleep to poll that session.

Call code_agent_status when the user asks how many background tasks there are, what they are, where they run, or whether they are still running. Call code_agent_stop when the user wants a background task cancelled. Stopping leaves the session idle; a later code_agent with the same session_id continues that artifact.

When a plugin notice reports that a Code agent session finished, decide again. Do remaining GUI that the result makes possible. If another stretch of file search or file production remains, call code_agent with that session_id. Then tell the user the short conclusion. Do not recite a long report.

When a user message starts with "Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.", answer in this chat only. Do not call GUI tools, code_agent, or screenshot on that turn.`;
function policyFor(mode) {
  return `${POLICY_BEFORE_COORDINATES}${mode === "pixel" ? PIXEL_COORDINATES : MILLIFRACTION_COORDINATES}${POLICY_AFTER_COORDINATES}`;
}
var POLICY = policyFor("millifraction");
function resolveAgentRoute(agent) {
  const routed = agent?.session.requestHeader()?.config;
  const provider = routed?.provider ?? agent?.options.provider;
  const model = routed?.model ?? agent?.options.model;
  if (provider === void 0 || model === void 0) return void 0;
  return {
    provider,
    model
  };
}
async function routeAcceptsImages(ctx, agent, signal) {
  const route = resolveAgentRoute(agent);
  const llm = ctx.get("llm");
  if (route === void 0 || llm === void 0) return false;
  const active = await llm.resolveModelInfo(route.provider, route.model, signal);
  return active.inputModalities !== void 0 && active.inputModalities.includes("image");
}
async function assertImageCapableRoute(ctx, exec) {
  const route = resolveAgentRoute(exec.agent);
  const llm = ctx.get("llm");
  if (route === void 0 || llm === void 0) throw new Error("cannot use computer-use tools: the current model route could not be resolved");
  const active = await llm.resolveModelInfo(route.provider, route.model, exec.signal);
  if (active.inputModalities === void 0 || !active.inputModalities.includes("image")) throw new Error(`cannot use computer-use tools: model "${route.model}" does not declare image input; switch to an image-capable model`);
}
var SCREEN_BUSY_MESSAGE = "Another Computer Use session is operating the screen. Do not retry GUI actions now; tell the user about the conflict and continue with non-GUI work or end the turn.";
var SCREEN_LOCK = Symbol.for("dsh-orb.gui-lock");
function screenLockState() {
  const holder = globalThis;
  holder[SCREEN_LOCK] ??= {
    held: false,
    owner: void 0
  };
  return holder[SCREEN_LOCK];
}
async function withScreenLock(owner, run) {
  const state = screenLockState();
  const key = owner ?? Symbol("dsh-orb.gui-lock.anonymous");
  if (state.held && state.owner !== key) throw new Error(SCREEN_BUSY_MESSAGE);
  const nested = state.held;
  if (!nested) {
    state.held = true;
    state.owner = key;
  }
  try {
    return await run();
  } finally {
    if (!nested) {
      state.held = false;
      state.owner = void 0;
    }
  }
}
function textOf(content) {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function isDesktopSelectionTurn(messages) {
  return messages.some((message) => message.source.kind === "user" && textOf(message.content).startsWith("Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent."));
}
var EXTENSION = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};
function pad2(value) {
  return String(value).padStart(2, "0");
}
function screenshotFileStem(now, screenIndex, screenCount) {
  const stamp = `${String(now.getFullYear())}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} at ${pad2(now.getHours())}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}`;
  if (screenCount === 1) return `Screenshot ${stamp}`;
  return `Screenshot ${stamp} (screen ${String(screenIndex)})`;
}
async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
async function uniquePath(directory, stem, extension) {
  let candidate = join3(directory, `${stem}.${extension}`);
  for (let suffix = 2; suffix <= 101; suffix += 1) {
    if (!await pathExists(candidate)) return candidate;
    if (suffix > 100) break;
    candidate = join3(directory, `${stem} ${String(suffix)}.${extension}`);
  }
  throw new Error("computer-use: could not allocate a unique screenshot filename");
}
function pairScreenshotFiles(captures, screens) {
  if (captures.length !== screens.length) throw new Error("computer-use: screenshot captures and screens disagree");
  const files = [];
  for (const [index, captured] of captures.entries()) {
    const screen = screens[index];
    if (screen === void 0) throw new Error("computer-use: screenshot captures and screens disagree");
    files.push({
      data: captured.data,
      mediaType: captured.mediaType,
      screenIndex: screen.screenIndex
    });
  }
  return files;
}
async function writeDesktopScreenshots(files, options) {
  if (files.length === 0) throw new Error("computer-use: no screenshot files to write");
  const home = options.home;
  const now = options.now ?? /* @__PURE__ */ new Date();
  const desktop = join3(home, "Desktop");
  await fs.mkdir(desktop, { recursive: true });
  const paths = [];
  for (const file of files) {
    const path = await uniquePath(desktop, screenshotFileStem(now, file.screenIndex, files.length), EXTENSION[file.mediaType]);
    await fs.writeFile(path, file.data);
    paths.push(path);
  }
  return paths;
}
var LONG_WAIT_SECONDS = [
  10,
  30,
  60,
  120
];
function requireLongWaitSeconds(raw) {
  if (typeof raw !== "number" || !Number.isInteger(raw) || !isLongWaitSeconds(raw)) throw new Error("wait_seconds must be 10, 30, 60, or 120");
  return raw;
}
function isLongWaitSeconds(value) {
  return LONG_WAIT_SECONDS.includes(value);
}
var PLUGIN_NAME = "tool-computer-use";
var POLICY_SECTION_ORDER = 1750;
var SCREENS_FIELD = {
  type: "array",
  required: true,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      screenIndex: {
        type: "integer",
        required: true
      },
      logicalWidth: {
        type: "number",
        required: true
      },
      logicalHeight: {
        type: "number",
        required: true
      },
      scale: {
        type: "number",
        required: true
      },
      image: {
        type: "object",
        additionalProperties: false,
        required: true,
        properties: {
          attachmentId: {
            type: "string",
            required: true
          },
          mediaType: {
            type: "string",
            enum: [
              "image/png",
              "image/jpeg",
              "image/webp",
              "image/gif"
            ],
            required: true
          },
          bytes: {
            type: "integer",
            required: true
          },
          width: {
            type: "integer",
            required: true
          },
          height: {
            type: "integer",
            required: true
          },
          name: { type: "string" },
          originalDimensions: {
            type: "object",
            additionalProperties: false,
            properties: {
              width: {
                type: "integer",
                required: true
              },
              height: {
                type: "integer",
                required: true
              }
            }
          }
        }
      }
    }
  }
};
var FOREGROUND_FIELD = {
  type: "object",
  additionalProperties: false,
  required: true,
  properties: {
    appName: {
      type: "string",
      required: true
    },
    windowTitle: { type: "string" },
    finderFolder: { type: "string" },
    focusNote: { type: "string" }
  }
};
var COORDINATE_FIELDS = {
  coordinateMode: {
    type: "string",
    required: true,
    enum: ["millifraction", "pixel"]
  },
  attachedWidth: { type: "integer" },
  attachedHeight: { type: "integer" }
};
function genericExecute(title, rawInput) {
  return {
    card: "generic",
    title,
    kind: "execute",
    rawInput
  };
}
function resultBlocks(intro, screens, foreground, outcome) {
  return [{
    type: "text",
    text: intro
  }, ...observationContent(screens, foreground, outcome.coordinateMode)];
}
function sessionOf(exec) {
  return exec.agent?.session;
}
function validatedPosition(exec, position) {
  const session = sessionOf(exec);
  if (coordinateModeOf(session) === "millifraction") return requireNormalizedPosition(position);
  const attached = lastAttachedRaster(session);
  if (attached === void 0) throw new Error("computer-use: pixel coordinates require an attached screenshot raster");
  return requirePixelPosition(position, attached);
}
function hidPosition(exec, position) {
  const session = sessionOf(exec);
  const mode = coordinateModeOf(session);
  return modelPositionToHid(position, mode, mode === "pixel" ? lastAttachedRaster(session) : void 0);
}
function observedFields(session, observation) {
  return {
    screens: observation.screens,
    foreground: observation.foreground,
    ...coordinateOutcome(session, observation.screens)
  };
}
async function recapture(ctx, backend, exec, settleMs = 0) {
  const session = sessionOf(exec);
  const mode = coordinateModeOf(session);
  const observation = await observeDesktop(ctx, backend, exec.signal, {
    settleMs,
    coordinateMode: mode
  });
  rememberObservation(session, observation.screens);
  return {
    screens: [...observation.screens],
    foreground: compactForeground(observation.foreground),
    captures: [...observation.captures]
  };
}
function guiTurn(backend, exec, run) {
  return withScreenLock(exec.agent?.id, () => backend.withGuiTurn(run, exec.signal));
}
function screenshotIntro(paths, outcome) {
  return `Saved screenshot to ${paths[0]} and copied it to the clipboard. The image is ready to paste. ${coordinatesRemain(outcome)}`;
}
function clickResultText(value) {
  const mods = value.modifiers === void 0 ? "" : `, modifiers ${value.modifiers.join(", ")}`;
  return `Clicked screen ${String(value.screenIndex)} at [${value.position.join(", ")}] (${value.button}, count ${String(value.count)}${mods}). ${coordinatesRemain(value)}`;
}
function applyComputerUse(ctx, backend, config) {
  installCoordinateMode(ctx);
  ctx.systemPrompt.section({
    name: "tool:computer-use",
    order: POLICY_SECTION_ORDER,
    text: (context) => policyFor(coordinateModeOf(context.agent?.session))
  });
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const nextAssembly = await next();
    const mode = coordinateModeOf(context.agent?.session);
    if (mode === "millifraction") return nextAssembly;
    return {
      ...nextAssembly,
      tools: toolsForCoordinateMode(nextAssembly.tools, mode)
    };
  });
  ctx.on("session/event", (_session, event) => {
    if (event.type !== "turn/end") return;
    const guard = ctx.get("computerUseOverlayGuard");
    if (guard === void 0) return;
    guard.setObservationFrame(null).catch(() => {
    });
  });
  ctx.tools.register(defineTool({
    name: "click",
    description: "Click at a 0\u20131000 position on the attached frontmost-window screenshot, then return the post-action screenshot. Use left (default) or right button; count 2 is a double-click. Optional modifiers (shift, cmd, option, control) are held only for this click.",
    parameters: {
      screen_index: {
        type: "integer",
        required: true,
        description: "0 for the attached frontmost-window screenshot."
      },
      position: {
        type: "array",
        required: true,
        items: { type: "number" },
        description: "[x, y] as a 0\u20131000 fraction of that screenshot, not pixels."
      },
      button: {
        type: "string",
        enum: ["left", "right"],
        default: "left",
        description: "Mouse button. Default: left."
      },
      count: {
        type: "integer",
        enum: [1, 2],
        default: 1,
        description: "1 for a single click, 2 for a double-click. Default: 1."
      },
      modifiers: {
        type: "array",
        items: { type: "string" },
        description: 'Modifier keys held only for this click, for example ["shift"] or ["cmd"]. Omit for a plain click.'
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          screenIndex: {
            type: "integer",
            required: true
          },
          position: {
            type: "array",
            required: true,
            items: { type: "number" }
          },
          button: {
            type: "string",
            required: true,
            enum: ["left", "right"]
          },
          count: {
            type: "integer",
            required: true
          },
          modifiers: {
            type: "array",
            items: { type: "string" }
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(clickResultText(value), value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Click", {
      screen_index: args.screen_index,
      position: args.position,
      ...args.modifiers !== void 0 && args.modifiers.length > 0 ? { modifiers: args.modifiers } : {}
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const position = validatedPosition(exec, args.position);
      const button = args.button === "right" ? "right" : "left";
      const count = args.count === 2 ? 2 : 1;
      const modifiers = requireClickModifiers(args.modifiers);
      return guiTurn(backend, exec, async () => {
        const screen = requireScreen(await backend.listScreens(exec.signal), args.screen_index);
        await backend.click({
          screen,
          position: hidPosition(exec, position),
          button,
          count,
          ...modifiers === void 0 ? {} : { modifiers }
        }, exec.signal);
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
        return {
          screenIndex: args.screen_index,
          position,
          button,
          count,
          ...modifiers === void 0 ? {} : { modifiers },
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.tools.register(defineTool({
    name: "input_text",
    description: "Click to focus a 0\u20131000 position on the attached frontmost-window screenshot, type text, optionally replace existing content and press Enter, then return the post-action screenshot.",
    parameters: {
      screen_index: {
        type: "integer",
        required: true,
        description: "0 for the attached frontmost-window screenshot."
      },
      position: {
        type: "array",
        required: true,
        items: { type: "number" },
        description: "[x, y] as a 0\u20131000 fraction of that screenshot, not pixels; the click focuses the field."
      },
      text: {
        type: "string",
        required: true,
        description: "Characters to type after the focus click."
      },
      replace: {
        type: "boolean",
        default: false,
        description: "When true, select all in the focused field before typing. Default: false."
      },
      submit: {
        type: "boolean",
        default: false,
        description: "When true, press Enter after typing. Default: false."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          screenIndex: {
            type: "integer",
            required: true
          },
          position: {
            type: "array",
            required: true,
            items: { type: "number" }
          },
          text: {
            type: "string",
            required: true
          },
          replace: {
            type: "boolean",
            required: true
          },
          submit: {
            type: "boolean",
            required: true
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(`Typed on screen ${String(value.screenIndex)} at [${value.position.join(", ")}] (replace=${String(value.replace)}, submit=${String(value.submit)}). ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Type text", {
      screen_index: args.screen_index,
      text: args.text
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const position = validatedPosition(exec, args.position);
      const replace = args.replace ?? false;
      const submit = args.submit ?? false;
      return guiTurn(backend, exec, async () => {
        const screen = requireScreen(await backend.listScreens(exec.signal), args.screen_index);
        await backend.typeText({
          screen,
          position: hidPosition(exec, position),
          text: args.text,
          replace,
          submit
        }, exec.signal);
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
        return {
          screenIndex: args.screen_index,
          position,
          text: args.text,
          replace,
          submit,
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.tools.register(defineTool({
    name: "scroll",
    description: "Scroll up or down at a 0\u20131000 position on the attached frontmost-window screenshot, then return the post-action screenshot. scroll_level is 1\u201310.",
    parameters: {
      screen_index: {
        type: "integer",
        required: true,
        description: "0 for the attached frontmost-window screenshot."
      },
      position: {
        type: "array",
        required: true,
        items: { type: "number" },
        description: "[x, y] as a 0\u20131000 fraction of that screenshot, not pixels."
      },
      direction: {
        type: "string",
        required: true,
        enum: ["up", "down"],
        description: "Scroll direction."
      },
      scroll_level: {
        type: "integer",
        required: true,
        description: "Scroll magnitude from 1 (smallest) to 10 (largest)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          screenIndex: {
            type: "integer",
            required: true
          },
          position: {
            type: "array",
            required: true,
            items: { type: "number" }
          },
          direction: {
            type: "string",
            required: true,
            enum: ["up", "down"]
          },
          scrollLevel: {
            type: "integer",
            required: true
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(`Scrolled ${value.direction} on screen ${String(value.screenIndex)} at [${value.position.join(", ")}] (level ${String(value.scrollLevel)}). ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Scroll", {
      screen_index: args.screen_index,
      direction: args.direction,
      scroll_level: args.scroll_level
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const position = validatedPosition(exec, args.position);
      if (!Number.isInteger(args.scroll_level) || args.scroll_level < 1 || args.scroll_level > 10) throw new Error("scroll_level must be an integer from 1 to 10");
      return guiTurn(backend, exec, async () => {
        const screen = requireScreen(await backend.listScreens(exec.signal), args.screen_index);
        await backend.scroll({
          screen,
          position: hidPosition(exec, position),
          direction: args.direction,
          scrollLevel: args.scroll_level
        }, exec.signal);
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
        return {
          screenIndex: args.screen_index,
          position,
          direction: args.direction,
          scrollLevel: args.scroll_level,
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.tools.register(defineTool({
    name: "hotkey",
    description: "Press a key combination on the desktop, then return the post-action screenshot. System screenshot shortcuts (Cmd/Win+Shift+3/4/5) are rejected.",
    parameters: { keys: {
      type: "array",
      required: true,
      items: { type: "string" },
      description: 'Key names in order, for example ["cmd", "c"].'
    } },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          keys: {
            type: "array",
            required: true,
            items: { type: "string" }
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(`Pressed hotkey [${value.keys.join(", ")}]. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Hotkey", args.keys),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      if (args.keys.length === 0) throw new Error("keys must contain at least one key");
      assertAllowedHotkey(args.keys);
      return guiTurn(backend, exec, async () => {
        await backend.hotkey({ keys: args.keys }, exec.signal);
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
        return {
          keys: args.keys,
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.tools.register(defineTool({
    name: "wait",
    description: "Pause 1 second, then return a fresh frontmost-window screenshot without moving the pointer. Use for page refresh, a loader, or a control that has not appeared yet. Do not use for code_agent.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          waitSeconds: {
            type: "number",
            required: true
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(`Waited ${String(value.waitSeconds)}s. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: () => genericExecute("Wait", 1),
    async execute(_args, exec) {
      await assertImageCapableRoute(ctx, exec);
      await delay(1e3, exec.signal);
      const observation = await recapture(ctx, backend, exec);
      return {
        waitSeconds: 1,
        ...observedFields(sessionOf(exec), observation)
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: "long_wait",
    description: "Pause 10, 30, 60, or 120 seconds, then return a fresh frontmost-window screenshot without moving the pointer. Only for a visible long job such as a download, installer, export, or on-screen generation. Pick the smallest wait_seconds that covers remaining progress; 120 only when the screenshot already shows a minutes-long job. Ordinary loading uses wait. Do not use for code_agent.",
    parameters: { wait_seconds: {
      type: "integer",
      required: true,
      enum: [...LONG_WAIT_SECONDS],
      description: "Seconds to pause. Must be 10, 30, 60, or 120."
    } },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          waitSeconds: {
            type: "number",
            required: true
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(`Waited ${String(value.waitSeconds)}s. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Long wait", args.wait_seconds),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const waitSeconds = requireLongWaitSeconds(args.wait_seconds);
      await delay(waitSeconds * 1e3, exec.signal);
      const observation = await recapture(ctx, backend, exec);
      return {
        waitSeconds,
        ...observedFields(sessionOf(exec), observation)
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: "screenshot",
    description: "Save the current frontmost-window screenshot to the user Desktop and copy it to the clipboard. Returns the saved file path. After bash, search, or web_fetch, call this to refresh the frontmost window. After click, type, wait, or open, do not call it again \u2014 those results already attach a window. Use when the user asked for a screenshot file or needs the image on the clipboard to paste.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          paths: {
            type: "array",
            required: true,
            items: { type: "string" }
          },
          clipboard: {
            type: "boolean",
            required: true
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(screenshotIntro(value.paths, value), value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: () => genericExecute("Screenshot", {}),
    async execute(_args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const session = sessionOf(exec);
      const observation = await observeDesktop(ctx, backend, exec.signal, {
        coordinateMode: coordinateModeOf(session),
        persistCapture: (captured) => isUsableObservationRaster(captured.data)
      });
      const foreground = compactForeground(observation.foreground);
      if (observation.screens.length === 0) {
        if (observation.captures.length > 0) throw new Error(`computer-use: screenshot capture was unusable. Retry screenshot, wait, or open_app.
${formatForegroundEnvelope(foreground)}`);
        throw new Error("computer-use: screenshot produced no files");
      }
      rememberObservation(session, observation.screens);
      const files = pairScreenshotFiles(observation.captures, observation.screens);
      const paths = await writeDesktopScreenshots(files, { home: homedir2() });
      const first = files[0];
      const firstPath = paths[0];
      if (first === void 0 || firstPath === void 0) throw new Error("computer-use: screenshot produced no files");
      await backend.copyImageToClipboard({
        path: firstPath,
        mediaType: first.mediaType
      }, exec.signal);
      return {
        paths: [...paths],
        clipboard: true,
        ...observedFields(session, {
          screens: [...observation.screens],
          foreground
        })
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: "long_press",
    description: "Press and hold the left button at a 0\u20131000 position on the attached frontmost-window screenshot, then return the post-action screenshot. duration_seconds defaults to 3 and must be 1\u201310.",
    parameters: {
      screen_index: {
        type: "integer",
        required: true,
        description: "0 for the attached frontmost-window screenshot."
      },
      position: {
        type: "array",
        required: true,
        items: { type: "number" },
        description: "[x, y] as a 0\u20131000 fraction of that screenshot, not pixels."
      },
      duration_seconds: {
        type: "number",
        default: 3,
        description: "Hold duration in seconds. Default: 3. Must be 1\u201310."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          screenIndex: {
            type: "integer",
            required: true
          },
          position: {
            type: "array",
            required: true,
            items: { type: "number" }
          },
          durationSeconds: {
            type: "number",
            required: true
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(`Long-pressed screen ${String(value.screenIndex)} at [${value.position.join(", ")}] for ${String(value.durationSeconds)}s. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Long press", {
      screen_index: args.screen_index,
      position: args.position,
      duration_seconds: args.duration_seconds ?? 3
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const position = validatedPosition(exec, args.position);
      const durationSeconds = requireLongPressDuration(args.duration_seconds);
      return guiTurn(backend, exec, async () => {
        const screen = requireScreen(await backend.listScreens(exec.signal), args.screen_index);
        await backend.longPress({
          screen,
          position: hidPosition(exec, position),
          durationSeconds
        }, exec.signal);
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
        return {
          screenIndex: args.screen_index,
          position,
          durationSeconds,
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.tools.register(defineTool({
    name: "drag",
    description: "Drag from a start 0\u20131000 position to an end 0\u20131000 position on the attached frontmost-window screenshot, then return the post-action screenshot.",
    parameters: {
      start_screen_index: {
        type: "integer",
        required: true,
        description: "0 for the attached frontmost-window screenshot."
      },
      start_position: {
        type: "array",
        required: true,
        items: { type: "number" },
        description: "[x, y] start as a 0\u20131000 fraction of that screenshot, not pixels."
      },
      end_screen_index: {
        type: "integer",
        required: true,
        description: "0 for the attached frontmost-window screenshot."
      },
      end_position: {
        type: "array",
        required: true,
        items: { type: "number" },
        description: "[x, y] end as a 0\u20131000 fraction of that screenshot, not pixels."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          startScreenIndex: {
            type: "integer",
            required: true
          },
          startPosition: {
            type: "array",
            required: true,
            items: { type: "number" }
          },
          endScreenIndex: {
            type: "integer",
            required: true
          },
          endPosition: {
            type: "array",
            required: true,
            items: { type: "number" }
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(`Dragged from screen ${String(value.startScreenIndex)} [${value.startPosition.join(", ")}] to screen ${String(value.endScreenIndex)} [${value.endPosition.join(", ")}]. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Drag", {
      start_screen_index: args.start_screen_index,
      end_screen_index: args.end_screen_index
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const startPosition = validatedPosition(exec, args.start_position);
      const endPosition = validatedPosition(exec, args.end_position);
      return guiTurn(backend, exec, async () => {
        const screens = await backend.listScreens(exec.signal);
        const startScreen = requireScreen(screens, args.start_screen_index);
        const endScreen = requireScreen(screens, args.end_screen_index);
        await backend.drag({
          startScreen,
          startPosition: hidPosition(exec, startPosition),
          endScreen,
          endPosition: hidPosition(exec, endPosition)
        }, exec.signal);
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
        return {
          startScreenIndex: args.start_screen_index,
          startPosition,
          endScreenIndex: args.end_screen_index,
          endPosition,
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.tools.register(defineTool({
    name: "open_in_browser",
    description: "Open the default browser, or a full http(s) URL in it, then return the post-action screenshot. This is the user-visible browser. Do not use web_fetch as a substitute. Chinese in path or query must be plain text, never CJK percent-encoding such as %E5... / %E8....",
    parameters: { url: {
      type: "string",
      description: "http(s) URL to open. Omit to launch the default browser with no page."
    } },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(value.url === void 0 ? `Opened the default browser. ${coordinatesRemain(value)}` : `Opened ${value.url} in the default browser. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Open in browser", args.url === void 0 ? {} : { url: args.url }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const url = args.url === void 0 || args.url.trim() === "" ? void 0 : requireBrowserUrl(args.url);
      return withScreenLock(exec.agent?.id, async () => {
        await backend.openInBrowser(url === void 0 ? {} : { url }, exec.signal);
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
        return {
          ...url === void 0 ? {} : { url },
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.tools.register(defineTool({
    name: "open_in_finder",
    description: "Open a folder in Finder, open a file with its default app, or reveal a file in Finder, then return the post-action screenshot. Omit path to open the Desktop. Use reveal_only only to select a file in Finder (Open With or rename/move). Pass a real path; do not OCR one from the screenshot.",
    parameters: {
      path: {
        type: "string",
        description: "Absolute or ~ path. Omit to open the user Desktop."
      },
      reveal_only: {
        type: "boolean",
        default: false,
        description: "When true and path is a file, reveal it in Finder instead of opening it. Default: false."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            required: true
          },
          revealOnly: {
            type: "boolean",
            required: true
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(value.revealOnly ? `Revealed ${value.path} in Finder. ${coordinatesRemain(value)}` : `Opened ${value.path}. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Open in Finder", {
      ...args.path === void 0 ? {} : { path: args.path },
      reveal_only: args.reveal_only ?? false
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const requestedReveal = args.reveal_only ?? false;
      const target = await resolveFinderOpen(args.path, requestedReveal);
      const info = await stat(target.path);
      const revealOnly = target.revealOnly && info.isFile();
      return withScreenLock(exec.agent?.id, async () => {
        await backend.openInFinder({
          path: target.path,
          revealOnly
        }, exec.signal);
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
        return {
          path: target.path,
          revealOnly,
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.tools.register(defineTool({
    name: "list_apps",
    description: "List running regular (Dock-visible) applications by display name, then return the current frontmost-window screenshot. Use this when the attached window is the wrong app.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          apps: {
            type: "array",
            required: true,
            items: { type: "string" }
          },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(value.apps.length === 0 ? `No running regular applications. ${coordinatesRemain(value)}` : `Running apps: ${value.apps.join(", ")}. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: () => genericExecute("List apps", {}),
    async execute(_args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const apps = await backend.listApps(exec.signal);
      const observation = await recapture(ctx, backend, exec);
      return {
        apps: [...apps],
        ...observedFields(sessionOf(exec), observation)
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: "open_app",
    description: "Activate a running application or launch it by display name or bundle id, then return the post-action screenshot. Use this when the attached window is the wrong app. Do not click the Dock.",
    parameters: { name: {
      type: "string",
      required: true,
      description: "Localized application name or bundle identifier, for example Pages or com.apple.TextEdit."
    } },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            required: true
          },
          ok: {
            type: "boolean",
            required: true
          },
          action: {
            type: "string",
            enum: ["activated", "launched"]
          },
          error: { type: "string" },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD
        }
      },
      render: (_args, value) => resultBlocks(value.ok ? `Opened ${value.name} (${value.action ?? "activated"}). ${coordinatesRemain(value)}` : `Could not open ${value.name}: ${value.error ?? "unknown error"}. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => genericExecute("Open app", { name: args.name }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec);
      const name2 = args.name.trim();
      if (name2 === "") throw new Error("name must be a non-empty application name or bundle id");
      return guiTurn(backend, exec, async () => {
        let action;
        let error;
        let settleMs = 0;
        try {
          action = (await backend.openApp({ name: name2 }, exec.signal)).kind;
          settleMs = config.postActionWaitMs;
        } catch (caught) {
          if (exec.signal.aborted || caught instanceof Error && caught.name === "AbortError") throw caught;
          error = caught instanceof Error ? caught.message : String(caught);
        }
        const observation = await recapture(ctx, backend, exec, settleMs);
        return {
          name: name2,
          ok: error === void 0,
          ...action === void 0 ? {} : { action },
          ...error === void 0 ? {} : { error },
          ...observedFields(sessionOf(exec), observation)
        };
      });
    }
  }));
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || decision.messages.length === 0) return decision;
    if (isDesktopSelectionTurn(messages)) return decision;
    if (!messages.some((message) => message.source.kind === "user")) return decision;
    if (!await routeAcceptsImages(ctx, agent, signal)) return decision;
    signal.throwIfAborted();
    const mode = coordinateModeOf(agent.session);
    const observation = await observeDesktop(ctx, backend, signal, { coordinateMode: mode });
    rememberObservation(agent.session, observation.screens);
    signal.throwIfAborted();
    const notice = createUserMessage({
      content: [{
        type: "text",
        text: firstFrameNotice(mode)
      }, ...observation.blocks],
      source: {
        kind: "computer-use",
        form: "notice",
        summary: "Frontmost window attached"
      }
    });
    return {
      ...decision,
      messages: [...decision.messages, notice]
    };
  });
}
var FAKE_DESKTOP_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP4z8AAQQxYWACPjgj4kWPEuQAAAABJRU5ErkJggg==", "base64");
var DEFAULT_SCREENS = [{
  index: 0,
  bounds: {
    x: 0,
    y: 0,
    width: 1e3,
    height: 800
  },
  scale: 2,
  windowId: 1
}];
var DEFAULT_APPS = ["Pages", "Safari"];
function createFakeDesktopBackend(options = {}) {
  const png = options.png ?? FAKE_DESKTOP_PNG;
  const screens = options.screens ?? DEFAULT_SCREENS;
  const foreground = options.foreground ?? { appName: "Pages" };
  const apps = options.apps ?? DEFAULT_APPS;
  const actions = [];
  const captured = {
    data: png,
    mediaType: "image/png"
  };
  return {
    get actions() {
      return actions;
    },
    listScreens: () => Promise.resolve(screens),
    capture: () => Promise.resolve(captured),
    inspectForeground: () => Promise.resolve(foreground),
    listApps: () => Promise.resolve(apps),
    openApp: (input) => {
      actions.push({
        type: "openApp",
        input
      });
      if (options.openAppError !== void 0) return Promise.reject(options.openAppError);
      return Promise.resolve(options.openAppResult ?? {
        kind: "activated",
        name: input.name
      });
    },
    click: (input) => {
      actions.push({
        type: "click",
        input
      });
      return Promise.resolve();
    },
    typeText: (input) => {
      actions.push({
        type: "typeText",
        input
      });
      return Promise.resolve();
    },
    scroll: (input) => {
      actions.push({
        type: "scroll",
        input
      });
      return Promise.resolve();
    },
    hotkey: (input) => {
      actions.push({
        type: "hotkey",
        input
      });
      return Promise.resolve();
    },
    longPress: (input) => {
      actions.push({
        type: "longPress",
        input
      });
      return Promise.resolve();
    },
    drag: (input) => {
      actions.push({
        type: "drag",
        input
      });
      return Promise.resolve();
    },
    openInBrowser: (input) => {
      actions.push({
        type: "openInBrowser",
        input
      });
      return Promise.resolve();
    },
    openInFinder: (input) => {
      actions.push({
        type: "openInFinder",
        input
      });
      return Promise.resolve();
    },
    copyImageToClipboard: (input) => {
      actions.push({
        type: "copyImageToClipboard",
        input
      });
      return Promise.resolve();
    },
    withGuiTurn: (run) => run()
  };
}
var name = PLUGIN_NAME;
var inject = [
  "tools",
  "systemPrompt",
  "attachments"
];
function desktopBackend(ctx, inner) {
  const resolve = () => {
    const guard = ctx.get("computerUseOverlayGuard");
    return guard === void 0 ? inner : wrapDesktopBackend(inner, guard);
  };
  return {
    withGuiTurn: (run, signal) => resolve().withGuiTurn(run, signal),
    listScreens: (signal) => resolve().listScreens(signal),
    capture: (screen, signal) => resolve().capture(screen, signal),
    inspectForeground: (signal) => resolve().inspectForeground(signal),
    listApps: (signal) => resolve().listApps(signal),
    openApp: (input, signal) => resolve().openApp(input, signal),
    click: (input, signal) => resolve().click(input, signal),
    typeText: (input, signal) => resolve().typeText(input, signal),
    scroll: (input, signal) => resolve().scroll(input, signal),
    hotkey: (input, signal) => resolve().hotkey(input, signal),
    longPress: (input, signal) => resolve().longPress(input, signal),
    drag: (input, signal) => resolve().drag(input, signal),
    openInBrowser: (input, signal) => resolve().openInBrowser(input, signal),
    openInFinder: (input, signal) => resolve().openInFinder(input, signal),
    copyImageToClipboard: (input, signal) => resolve().copyImageToClipboard(input, signal)
  };
}
function apply(ctx, config = {}) {
  const excludedRegionCapture = (input) => {
    const capture = ctx.get("computerUseOverlayGuard")?.captureExcludedRegion;
    if (capture === void 0) return Promise.reject(/* @__PURE__ */ new Error("dsh desktop: overlay-exclude capture is not attached"));
    const { signal, ...region } = input;
    return capture(region, signal);
  };
  applyComputerUse(ctx, desktopBackend(ctx, createPlatformBackend(process.platform, excludedRegionCapture)), resolveComputerUseConfig(config));
}
export {
  Config,
  FAKE_DESKTOP_PNG,
  FOCUS_FALLBACK_FOREGROUND,
  FOCUS_NOTE,
  PLUGIN_NAME,
  POLICY,
  POLICY_SECTION_ORDER,
  UNFOCUSED_WINDOW_NOTE,
  apply,
  applyComputerUse,
  createFakeDesktopBackend,
  createPlatformBackend,
  inject,
  name,
  resolveComputerUseConfig,
  wrapDesktopBackend
};
