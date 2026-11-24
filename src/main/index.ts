/* eslint-disable no-shadow */
import { app, ipcMain, globalShortcut, desktopCapturer } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { WindowManager } from "./window-manager";
import { MenuManager } from "./menu-manager";
import { setupAudioDrop } from "./audio-drop";

let windowManager: WindowManager;
let menuManager: MenuManager;
let isQuitting = false;

function setupIPC(): void {
  ipcMain.handle("get-platform", () => process.platform);

  ipcMain.on("set-ignore-mouse-events", (_event, ignore: boolean) => {
    const window = windowManager.getWindow();
    if (window) {
      windowManager.setIgnoreMouseEvents(ignore);
    }
  });

  ipcMain.on("get-current-mode", (event) => {
    event.returnValue = windowManager.getCurrentMode();
  });

  ipcMain.on("pre-mode-changed", (_event, newMode) => {
    if (newMode === 'window' || newMode === 'pet') {
      menuManager.setMode(newMode);
    }
  });

  ipcMain.on("window-minimize", () => {
    windowManager.getWindow()?.minimize();
  });

  ipcMain.on("window-maximize", () => {
    const window = windowManager.getWindow();
    if (window) {
      windowManager.maximizeWindow();
    }
  });

  ipcMain.on("window-close", () => {
    const window = windowManager.getWindow();
    if (window) {
      if (process.platform === "darwin") {
        window.hide();
      } else {
        window.close();
      }
    }
  });

  // [deskpet] she was sent to the tray but the user is talking to her again: come back out,
  // without stealing focus and without landing on the taskbar
  ipcMain.on("window-show", () => {
    const window = windowManager.getWindow();
    if (!window || window.isVisible()) return;
    window.showInactive();
    if (windowManager.getCurrentMode() === "pet") {
      window.setSkipTaskbar(true);
      window.setAlwaysOnTop(true, "screen-saver");
    }
  });

  ipcMain.on(
    "update-component-hover",
    (_event, componentId: string, isHovering: boolean) => {
      windowManager.updateComponentHover(componentId, isHovering);
    },
  );

  ipcMain.handle("get-config-files", () => {
    const configFiles = JSON.parse(localStorage.getItem("configFiles") || "[]");
    menuManager.updateConfigFiles(configFiles);
    return configFiles;
  });

  ipcMain.on("update-config-files", (_event, files) => {
    menuManager.updateConfigFiles(files);
  });

  ipcMain.handle('get-screen-capture', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources[0].id;
  });
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");

  windowManager = new WindowManager();
  menuManager = new MenuManager((mode) => windowManager.setWindowMode(mode));

  const window = windowManager.createWindow({
    titleBarOverlay: {
      color: "#111111",
      symbolColor: "#FFFFFF",
      height: 30,
    },
  });
  menuManager.createTray();
  setupAudioDrop(window); // [deskpet]

  // [deskpet] started with --pet (e.g. by the startup launcher): go straight to pet mode.
  // Stay invisible and off the taskbar until the page has loaded and can switch modes,
  // otherwise the switch is lost and the window stays transparent / on the taskbar.
  if (process.argv.includes('--pet')) {
    window.setOpacity(0);
    window.setSkipTaskbar(true);
    let switched = false;
    const goPet = () => {
      if (switched) return;
      switched = true;
      menuManager.setMode('pet');
    };
    ipcMain.once('mode-listener-ready', () => setTimeout(goPet, 800));
    // the page can reload later (e.g. after the GPU drawing context was lost): put it back in pet mode
    ipcMain.on('mode-listener-ready', (event) => {
      if (switched && (menuManager as any).currentMode === 'pet') {
        setTimeout(() => event.sender.send('mode-changed', 'pet'), 300);
      }
    });
    // safety net: never leave her invisible
    setTimeout(() => {
      goPet();
      setTimeout(() => window.setOpacity(1), 4000);
    }, 20000);
  }

  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
    return false;
  });

  // if (process.env.NODE_ENV === "development") {
  //   globalShortcut.register("F12", () => {
  //     const window = windowManager.getWindow();
  //     if (!window) return;

  //     if (window.webContents.isDevToolsOpened()) {
  //       window.webContents.closeDevTools();
  //     } else {
  //       window.webContents.openDevTools();
  //     }
  //   });
  // }

  setupIPC();

  app.on("activate", () => {
    const window = windowManager.getWindow();
    if (window) {
      window.show();
    }
  });

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  app.on('web-contents-created', (_, contents) => {
    contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'media') {
        callback(true);
      } else {
        callback(false);
      }
    });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  menuManager.destroy();
  globalShortcut.unregisterAll();
});
