import { a as encodeBgraPng } from "./backend-18yEf5Jq.js";
import { execFileSync } from "node:child_process";
import koffi from "koffi";
/**
* Reverse the row order of a tightly packed raster in place.
* `GetDIBits` returns bottom-up rows; every cursor and capture plane is used top-down.
* @param pixels - raster to reverse, mutated in place.
* @param rowBytes - bytes per row.
* @param height - number of rows.
*/
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
/**
* Where the cursor bitmap lands inside a capture region.
* The pointer is measured against the region grown by `margin`; a pointer farther out
* returns undefined and the capture is left as `BitBlt` produced it.
* @param pointer - pointer position in physical screen pixels.
* @param hotspot - cursor hotspot inside its bitmap.
* @param size - cursor bitmap size.
* @param bounds - capture region in physical screen pixels.
* @param margin - slack outside the region, {@link CURSOR_EDGE_MARGIN} by default.
* @returns the capture-local top-left, or undefined when the cursor must not be drawn.
*/
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
/**
* Resolve a cursor bitmap to top-down BGRA with a usable alpha channel.
* A colour plane that carries alpha is used as it is. A legacy cursor whose colour
* plane is fully transparent falls back to the AND mask: a white mask pixel keeps the
* destination, a black one paints the colour plane.
* @param cursor - bitmap from `GetIconInfo`.
* @returns top-down BGRA pixels, `width * height * 4` bytes.
*/
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
/**
* Alpha-blend one cursor bitmap into a BGRA raster. Pixels outside the target are clipped.
* @param target - destination BGRA pixels, top-down, mutated in place.
* @param targetWidth - destination width.
* @param targetHeight - destination height.
* @param cursor - top-down BGRA cursor pixels with a resolved alpha channel.
* @param cursorWidth - cursor width.
* @param cursorHeight - cursor height.
* @param at - capture-local top-left for the cursor.
*/
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
//#endregion
//#region src/windows-native.ts
/**
* Win32 capture and input used by {@link createWindowsDesktopBackend}.
* Loaded only on Windows, and only when a method runs without injected operations.
* Each coordinate-bearing call sets this thread to per-monitor DPI awareness so
* window rectangles, `BitBlt`, and `SendInput` share physical pixels, then restores
* the previous awareness. `.agents/notes/implemented/architecture/2026-09-23-windows-computer-use-per-monitor-dpi.md`
* owns that decision.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/windows-native
*/
const SRCCOPY = 13369376;
const MOUSEEVENTF_LEFTDOWN = 2;
const MOUSEEVENTF_LEFTUP = 4;
const MOUSEEVENTF_RIGHTDOWN = 8;
const MOUSEEVENTF_RIGHTUP = 16;
const MOUSEEVENTF_WHEEL = 2048;
const MOUSEEVENTF_ABSOLUTE = 32768;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 1;
const KEYEVENTF_KEYUP = 2;
const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 2;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const PROCESS_QUERY_LIMITED_INFORMATION = 4096;
const TOKEN_QUERY = 8;
const TokenIntegrityLevel = 25;
const SW_SHOWNORMAL = 1;
const SW_RESTORE = 9;
const GW_OWNER = 4;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 2147483648;
const WS_EX_TOOLWINDOW = 128;
/** 覆盖层三件套：恒置顶 + 不可激活 + 点击穿透（Electron 悬浮球 / ribbon 就是这样）。 */
const WS_EX_TOPMOST = 8;
const WS_EX_TRANSPARENT = 32;
const WS_EX_NOACTIVATE = 2048;
/** 抓屏长边上限（像素）。0 或不提供 = 不缩放，按原尺寸抓。 */
const DEFAULT_CAPTURE_MAX_EDGE_PX = 1280;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const MONITOR_DEFAULTTONEAREST = 2;
const MDT_EFFECTIVE_DPI = 0;
const VK_MENU = 18;
/** `SetWindowPos` 的 z 序顶端与不激活/不移动/不改尺寸标志：只为验证覆盖层之上，不抢焦点。 */
const HWND_TOP = 0;
const SWP_NOSIZE = 1;
const SWP_NOMOVE = 2;
const SWP_NOACTIVATE = 16;
/** `CURSORINFO.flags` bit set while the pointer is drawn. */
const CURSOR_SHOWING = 1;
/** Per-monitor v2, then per-monitor. `SetThreadDpiAwarenessContext` returns NULL when the context is unsupported. */
const DPI_PER_MONITOR_V2 = -4;
const DPI_PER_MONITOR = -3;
const FOREGROUND_RETRY_MS = 50;
/** `SendInput` 鼠标事件位：移动、绝对坐标、坐标映射到整块虚拟桌面（而不是主屏）。 */
const MOUSEEVENTF_MOVE = 1;
const MOUSEEVENTF_VIRTUALDESK = 16384;
koffi.struct("DSH_CU_RECT", {
	left: "int32",
	top: "int32",
	right: "int32",
	bottom: "int32"
});
const POINT = koffi.struct("DSH_CU_POINT", {
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
const MOUSEINPUT = koffi.struct("DSH_CU_MOUSEINPUT", {
	dx: "int32",
	dy: "int32",
	mouseData: "uint32",
	dwFlags: "uint32",
	time: "uint32",
	dwExtraInfo: "uintptr"
});
const KEYBDINPUT = koffi.struct("DSH_CU_KEYBDINPUT", {
	wVk: "uint16",
	wScan: "uint16",
	dwFlags: "uint32",
	time: "uint32",
	dwExtraInfo: "uintptr"
});
const INPUT_UNION = koffi.union("DSH_CU_INPUT_UNION", {
	mi: MOUSEINPUT,
	ki: KEYBDINPUT
});
const INPUT = koffi.struct("DSH_CU_INPUT", {
	type: "uint32",
	u: INPUT_UNION
});
const CURSORINFO = koffi.struct("DSH_CU_CURSORINFO", {
	cbSize: "uint32",
	flags: "uint32",
	hCursor: "void *",
	ptScreenPos: POINT
});
const ICONINFO = koffi.struct("DSH_CU_ICONINFO", {
	fIcon: "int32",
	xHotspot: "uint32",
	yHotspot: "uint32",
	hbmMask: "void *",
	hbmColor: "void *"
});
/** `tagBITMAP`; only `bmWidth` and `bmHeight` are read. */
const BITMAP = koffi.struct("DSH_CU_BITMAP", {
	bmType: "int32",
	bmWidth: "int32",
	bmHeight: "int32",
	bmWidthBytes: "int32",
	bmPlanes: "uint16",
	bmBitsPixel: "uint16",
	bmBits: "void *"
});
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
		AttachThreadInput: user32.func("int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)"),
		GetCurrentThreadId: kernel32.func("uint32 __stdcall GetCurrentThreadId()"),
		BringWindowToTop: user32.func("int __stdcall BringWindowToTop(void *hWnd)"),
		SetWindowPos: user32.func("int __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)"),
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
/**
 * 物理像素全局坐标 → SendInput 绝对坐标。
 * `MOUSEEVENTF_ABSOLUTE` 的 0..65535 是 `MOUSEEVENTF_VIRTUALDESK` 所定义的**整块虚拟桌面**
 * 包围盒的归一化值（不带 VIRTUALDESK 时只映射到主屏，负坐标根本表达不出来），原点可以是负的，
 * 尺寸随屏幕数量变化，所以只能拿 GetSystemMetrics 的四个虚拟屏指标实时换算。
 * 这条路径只在 {@link placePointer} 的 SetCursorPos 回退里用；正常落点不做归一化。
 * @param point - 物理像素全局坐标。
 * @param virtualScreen - `virtualScreen()` 查到的虚拟屏包围盒。
 * @returns `{ dx, dy }`，直接喂进 MOUSEINPUT。
 */
function absoluteInputCoordinates(point, virtualScreen) {
	return {
		dx: Math.round((point.x - virtualScreen.x) * 65535 / Math.max(1, virtualScreen.width - 1)),
		dy: Math.round((point.y - virtualScreen.y) * 65535 / Math.max(1, virtualScreen.height - 1))
	};
}
/**
 * 虚拟屏包围盒（物理像素）。单屏就是主屏；多屏含负原点；宿主 DPI 虚拟化时与查询同一套坐标。
 * @param api - Win32 operations.
 * @returns 运行时查询到的虚拟屏矩形。
 */
function virtualScreenOf(api) {
	return {
		x: api.GetSystemMetrics(SM_XVIRTUALSCREEN),
		y: api.GetSystemMetrics(SM_YVIRTUALSCREEN),
		width: Math.max(1, api.GetSystemMetrics(SM_CXVIRTUALSCREEN)),
		height: Math.max(1, api.GetSystemMetrics(SM_CYVIRTUALSCREEN))
	};
}
function sendMouse(api, flags, x, y, data = 0, basis) {
	const absolute = (flags & MOUSEEVENTF_ABSOLUTE) !== 0;
	const virtual = basis ?? virtualScreenOf(api);
	const target = absolute ? absoluteInputCoordinates({
		x,
		y
	}, virtual) : {
		dx: x,
		dy: y
	};
	const input = {
		type: INPUT_MOUSE,
		u: { mi: {
			dx: target.dx,
			dy: target.dy,
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
/** Read one bitmap as top-down 32-bit BGRA. `GetDIBits` converts depth and row order for us. */
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
/**
* The system pointer as Win32 reports it.
* `GetIconInfo` hands over two bitmaps the caller owns; the shared cursor handle is not ours to free.
* @returns position, hotspot, and bitmaps, or undefined when no pointer is drawn.
*/
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
/**
* Draw the system pointer into one capture raster.
* `BitBlt` copies the desktop without the cursor layer, so the agent cannot see where its
* clicks land. macOS gets the same pointer baked in by `screencapture -x -C`.
* @param bounds - capture region in physical pixels, matching the raster origin.
*/
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
/**
 * 抓屏尺寸：只有超过 `maxEdge` 的长边才缩放，比例保持原样。
 * @param width - 原始物理像素宽。
 * @param height - 原始物理像素高。
 * @param maxEdge - 长边上限像素；非正或非数字 = 不缩放。
 * @returns 缩放后的目标尺寸，或 undefined 表示不需要缩放。
 */
function fitCaptureSize(width, height, maxEdge) {
	if (!Number.isFinite(maxEdge) || maxEdge < 1) return void 0;
	if (width <= maxEdge && height <= maxEdge) return void 0;
	const factor = Math.min(maxEdge / width, maxEdge / height);
	const scaledWidth = Math.max(1, Math.round(width * factor));
	const scaledHeight = Math.max(1, Math.round(height * factor));
	if (scaledWidth === width && scaledHeight === height) return void 0;
	return {
		width: scaledWidth,
		height: scaledHeight
	};
}
/**
 * 盒式平均缩放一帧 BGRA 光栅，保持宽高比已经由 {@link fitCaptureSize} 决定。
 * 整帧降采样比把原始 PNG 交给模型便宜得多：每步观察的像素越少，回喂的 token 也越少。
 * @param pixels - 源 top-down BGRA 像素。
 * @param srcWidth - 源宽。
 * @param srcHeight - 源高。
 * @param dstWidth - 目标宽。
 * @param dstHeight - 目标高。
 * @returns 目标尺寸的光栅，`dstWidth * dstHeight * 4` 字节。
 */
function downscaleBgra(pixels, srcWidth, srcHeight, dstWidth, dstHeight) {
	const out = Buffer.alloc(dstWidth * dstHeight * 4);
	const xScale = srcWidth / dstWidth;
	const yScale = srcHeight / dstHeight;
	for (let row = 0; row < dstHeight; row += 1) {
		const y0 = Math.min(srcHeight - 1, Math.floor(row * yScale));
		const y1 = Math.min(srcHeight, Math.max(y0 + 1, Math.ceil((row + 1) * yScale)));
		for (let column = 0; column < dstWidth; column += 1) {
			const x0 = Math.min(srcWidth - 1, Math.floor(column * xScale));
			const x1 = Math.min(srcWidth, Math.max(x0 + 1, Math.ceil((column + 1) * xScale)));
			let blue = 0;
			let green = 0;
			let red = 0;
			let alpha = 0;
			let samples = 0;
			for (let sy = y0; sy < y1; sy += 1) {
				for (let sx = x0; sx < x1; sx += 1) {
					const at = (sy * srcWidth + sx) * 4;
					blue += pixels[at] ?? 0;
					green += pixels[at + 1] ?? 0;
					red += pixels[at + 2] ?? 0;
					alpha = Math.max(alpha, pixels[at + 3] ?? 0);
					samples += 1;
				}
			}
			const dest = (row * dstWidth + column) * 4;
			out[dest] = Math.round(blue / samples);
			out[dest + 1] = Math.round(green / samples);
			out[dest + 2] = Math.round(red / samples);
			out[dest + 3] = alpha;
		}
	}
	return out;
}
function monitorOf(api, hwnd, fallback) {
	const handle = api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
	if (isNull(handle)) return {
		monitor: fallback,
		workArea: fallback,
		dpi: 96
	};
	const info = Buffer.alloc(40);
	info.writeUInt32LE(40, 0);
	if (api.GetMonitorInfoW(handle, info) === 0) return {
		monitor: fallback,
		workArea: fallback,
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
	// MONITORINFO.rcWork：这块显示器去掉任务栏/贴边栏后的工作区。观察面与点击基准都跟它求交，
	// 所以屏幕原点是否为负、任务栏在哪一侧、几块屏，全部由运行时决定，代码里不出现任何几何常量。
	const workLeft = info.readInt32LE(20);
	const workTop = info.readInt32LE(24);
	const workRight = info.readInt32LE(28);
	const workBottom = info.readInt32LE(32);
	const workArea = workRight > workLeft && workBottom > workTop ? {
		x: workLeft,
		y: workTop,
		width: workRight - workLeft,
		height: workBottom - workTop
	} : monitor;
	const readDpi = api.GetDpiForMonitor;
	if (readDpi === void 0) return {
		monitor,
		workArea,
		dpi: 96
	};
	const dpiX = [0];
	if (readDpi(handle, MDT_EFFECTIVE_DPI, dpiX, [0]) !== 0) return {
		monitor,
		workArea,
		dpi: 96
	};
	const dpi = dpiX[0] ?? 0;
	return {
		monitor,
		workArea,
		dpi: dpi > 0 ? dpi : 96
	};
}
/**
 * 抓屏长边上限：0 = 关闭缩放（原样全尺寸抓），非有限值 = 用默认上限。
 * @param value - 插件提供的配置值，可能为 undefined。
 * @returns 上限像素（0 表示不缩放）。
 */
function resolveCaptureMaxEdge(value) {
	if (value === 0) return 0;
	return Number.isFinite(value) && value >= 1 ? Math.round(value) : DEFAULT_CAPTURE_MAX_EDGE_PX;
}
function stylesOf(api, hwnd) {
	const style = low32(api.GetWindowLongPtrW(hwnd, GWL_STYLE));
	const extended = low32(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	return {
		popup: (style & WS_POPUP) !== 0,
		toolWindow: (extended & WS_EX_TOOLWINDOW) !== 0,
		// 助手自己的悬浮球 / 覆盖条带：不可激活 + 恒置顶 + 点击穿透，永远不会是用户正在操作的那个应用窗口。
		topmost: (extended & WS_EX_TOPMOST) !== 0,
		noActivate: (extended & WS_EX_NOACTIVATE) !== 0,
		clickThrough: (extended & WS_EX_TRANSPARENT) !== 0
	};
}
function cachedAppName(api, cache, pid) {
	const cached = cache.get(pid);
	if (cached !== void 0) return cached;
	const name = processBaseName(api, pid) ?? "unknown";
	cache.set(pid, name);
	return name;
}
/**
* Win32 operations for the production Windows backend.
* @param options - 插件配置：`captureMaxEdgePx` = 抓屏长边上限像素（0 = 不缩放）。
* @returns operations that capture and post input on this machine.
*/
function createProductionWindowsOps(options = {}) {
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
	/** 每步观察截图的长边上限；0 = 保持全尺寸。 */
	const captureMaxEdge = resolveCaptureMaxEdge(options.captureMaxEdgePx);
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
	/**
	* 一次指针动作只认一套坐标：**物理像素全局坐标**。
	* `BitBlt` 抓屏、`GetWindowRect`、DWM 扩展帧、`GetCursorPos` 全都在这个空间里，
	* 所以落点直接交给 `SetCursorPos`（它本来就吃物理坐标），不做 0..65535 归一化 ——
	* 没有归一化就没有"映射基准 ≠ 归一化基准"的漂移，多屏负坐标也天然成立。
	* 只有 `SetCursorPos` 被拒（安全桌面等）时才退回 `SendInput` 绝对坐标，那时归一化基准
	* 只能是 `MOUSEEVENTF_VIRTUALDESK` 定义的整块虚拟桌面；两条路径都以 `GetCursorPos`
	* 的回读值为准，落不到请求的点就报错，绝不"当作成功"接着按键。
	* @param x - 物理像素全局 x。
	* @param y - 物理像素全局 y。
	* @throws when the pointer cannot be placed at the requested pixel.
	*/
	function placePointer(x, y) {
		const pos = {
			x: 0,
			y: 0
		};
		if (api.SetCursorPos(x, y) !== 0 && api.GetCursorPos(pos) !== 0 && pos.x === x && pos.y === y) return;
		sendMouse(api, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y);
		if (api.GetCursorPos(pos) === 0 || pos.x !== x || pos.y !== y) throw new Error(`computer-use: pointer input failed (wanted ${x},${y}; got ${pos.x},${pos.y})`);
	}
	/** 指针现在实际在哪（物理像素）。用于把落点回传给调用方自证，而不是等下一次截图猜。 */
	function cursorPosition() {
		const pos = {
			x: 0,
			y: 0
		};
		if (api.GetCursorPos(pos) === 0) return void 0;
		return {
			x: pos.x,
			y: pos.y
		};
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
					topmost: styles.topmost,
					noActivate: styles.noActivate,
					clickThrough: styles.clickThrough,
					frame,
					monitor: display.monitor,
					workArea: display.workArea,
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
	/**
	* 把 `target` 弄到键盘前台，**以 `GetForegroundWindow` 的实际结果为准**。
	*
	* 判定顺序（每步都先读 GetForegroundWindow，而不是看 `SetForegroundWindow` 的返回值）：
	*  0. 目标本来就在前台 → 直接放行，一个按键都不发。`SetForegroundWindow` 对前台窗口
	*     返回 false，但那不是失败；此前这里无条件先按一下 Alt，等于给已经是前台的窗口
	*     塞了一个系统键，前台反而可能被这根 Alt 带走，然后被判成「focus could not be moved」。
	*  1. 最小化就先恢复，再直接抢一次（本进程刚收到过输入时有效）。
	*  2. 经典解锁一：发一个 Alt 按下/抬起，让自己成为「最后输入」的所有者，再抢。
	*  3. 经典解锁二：`AttachThreadInput` 把本线程输入队列临时挂到当前前台线程上，再抢，
	*     无论成败都立刻断开（不留下被挂着输入队列的线程）。
	*  4. 最后才提 z 序（不激活、不移动、不改尺寸）补 `SetForegroundWindow`，重读一次。
	* 全程不碰 ForegroundLockTimeout 之类的用户级设置。
	* @param target - top-level HWND pointer from `EnumWindows`.
	* @returns 目标此刻是否真的在前台（由 `GetForegroundWindow` 读出）。
	*/
	function becomeForeground(target) {
		if (isForeground(target)) return true;
		if (api.IsIconic(target) !== 0) api.ShowWindow(target, SW_RESTORE);
		api.SetForegroundWindow(target);
		if (isForeground(target)) return true;
		postKey(api, VK_MENU, true, false);
		try {
			api.SetForegroundWindow(target);
		} finally {
			postKey(api, VK_MENU, false, false);
		}
		if (isForeground(target)) return true;
		const foreground = api.GetForegroundWindow();
		if (!isNull(foreground)) {
			const selfThread = api.GetCurrentThreadId();
			const foregroundThread = api.GetWindowThreadProcessId(foreground, [0]);
			if (foregroundThread !== 0 && foregroundThread !== selfThread && api.AttachThreadInput(selfThread, foregroundThread, 1) !== 0) {
				try {
					api.SetForegroundWindow(target);
				} finally {
					api.AttachThreadInput(selfThread, foregroundThread, 0);
				}
				if (isForeground(target)) return true;
			}
		}
		api.BringWindowToTop(target);
		api.SetWindowPos(target, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
		sleepSync(FOREGROUND_RETRY_MS);
		api.SetForegroundWindow(target);
		return isForeground(target);
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
					const fit = fitCaptureSize(width, height, captureMaxEdge);
					if (fit === void 0) return encodeBgraPng(width, height, pixels, false);
					return encodeBgraPng(fit.width, fit.height, downscaleBgra(pixels, width, height, fit.width, fit.height), false);
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
		cursorPosition,
		/**
		* 只发按键事件，**绝不移动指针**：按下与抬起都必须落在同一个坐标上，
		* 中间插入任何移动都会被窗口当成拖拽（搬运窗口/拖选正文就是这么来的）。
		*/
		mouseButton(button, down, point) {
			const flags = button === "right" ? down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP : down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
			perMonitor(() => {
				// 按下前把落点再确认一次；抬起时绝不移动（移动会在按键期间变成拖拽）。
				if (down === true && point !== void 0) placePointer(point.x, point.y);
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
				const name = processBaseName(api, pidOf(api, hwnd));
				if (name !== void 0 && name !== "") names.add(name);
			}
			return [...names];
		},
		activateApp(name) {
			const wanted = name.trim().toLowerCase();
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
				if (!becomeForeground(target)) throw new Error(`computer-use: failed to activate ${name}`);
				return true;
			});
		},
		foregroundWindowId() {
			return hwndId(api.GetForegroundWindow()) ?? 0;
		},
		virtualScreen() {
			return perMonitor(() => virtualScreenOf(api));
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
//#endregion
export { createProductionWindowsOps, fitCaptureSize, downscaleBgra, resolveCaptureMaxEdge, absoluteInputCoordinates, virtualScreenOf };
